# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Pure text helpers for the Discord node.

These functions have no discord.py dependency so they can be unit-tested
directly without a Gateway connection or the discord.py package installed.
"""

import codecs
import json
import mimetypes
import re
from typing import Iterable, List, Optional, Sequence, Tuple

DISCORD_MESSAGE_CHAR_LIMIT: int = 2000  # Discord's per-message cap

# Default cap on the thread transcript handed to the pipeline as context.
THREAD_HISTORY_MAX_CHARS: int = 6000

# Cap on each message in the transcript, so one long message cannot fill the
# whole transcript budget on its own.
THREAD_HISTORY_MESSAGE_MAX_CHARS: int = 1000

# Continuation lines of a message are indented by this much in the transcript,
# so a newline inside one message cannot start another speaker's line.
_TRANSCRIPT_CONTINUATION = '\n  '

# A newline that starts a speaker line (not an indented continuation line).
_SPEAKER_LINE_START = re.compile(r'\n(?!  )')

# A reply that still opens with one of these labels is leaked agent scratchpad
# ("Thought: ...", "Action Input: ...") rather than a user-facing answer.
_OPENS_WITH_REASONING = re.compile(r'^\s*(Thought|Action(?:\s+Input)?|Observation|Reasoning)\s*:', re.IGNORECASE)
# Only at the start of a line: prose that mentions the label is not trimmed.
_FINAL_ANSWER = re.compile(r'^[ \t]*Final Answer\s*:\s*', re.IGNORECASE | re.MULTILINE)

# Some agent runtimes wrap the finished answer in a small JSON envelope instead
# of writing it out: ``{"type": "final", "content": "<escaped string>"}``. It is
# unwrapped only when it is the whole reply, or the end of a reply that opens as
# scratchpad; an answer that shows one as an example is left alone.
_FINAL_JSON = re.compile(r'\{\s*"type"\s*:\s*"final"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}')

# A fenced code block, or an unclosed fence running to the end of the text.
_CODE_FENCE = re.compile(r'```.*?(?:```|\Z)', re.DOTALL)

# What a code block becomes before the error checks: a line of its own, so the
# text after a leading block is not mistaken for the opening of the reply.
_CODE_PLACEHOLDER = '\n[code]\n'

# Engine and model failures can surface as the "answer" text — a provider API
# error, a Python traceback, an engine stack frame, or an HTTP status with the
# provider's payload. None of those may ever reach Discord, whatever the
# settings. Each shape is matched only where the reply opens with it (each code
# fence is replaced by a placeholder line first), so a support answer that
# quotes the user's error is still posted.
_ERROR_SIGNATURES = (
    re.compile(r'^\s*an error occurred with the \w+ api\b', re.IGNORECASE),
    re.compile(r'^\s*[\w./\\-]*\b(chat|agent)\.py:\d+', re.IGNORECASE),
    # The engine's own log line is ``agent base _run failed run_id=...``.
    re.compile(r'^\s*(?:agent\s+base\s+)?_run failed\b', re.IGNORECASE),
    re.compile(r'^\s*Traceback \(most recent call last\)', re.IGNORECASE),
    # A provider status followed by its payload (``Error code: 429 - {...}``),
    # optionally labelled by an exception name (``RateLimitError:``), never by
    # an arbitrary word (``Note:``).
    re.compile(r'^\s*(?:\w*(?:Error|Exception)\s*:\s*)?Error code:\s*\d{3}\s*-\s', re.IGNORECASE),
    # The engine's LLM layer reports a provider failure as the answer itself:
    # ``**LLM error** — ValueError: An error occurred with the API.``, and the
    # RocketRide agent as ``LLM error: <exception>`` (no bold).
    re.compile(r'^\s*(?:\*\*)?LLM error(?:\*\*)?\s*[:—–-]'),
    # ...and the sentence its mapped exception carries, when that sentence is the
    # whole answer (prose that merely mentions API errors is not matched).
    re.compile(r'^\s*(?:\w+Error:\s*)?an error occurred with the api\.?\s*$', re.IGNORECASE),
)

# Openings that are usually a failure but may open a real answer
# (``Error: ENOENT means...``): an ``Error:`` / ``Exception:`` label, one named
# after an exception (``ValueError:``), or a bare provider status. Counted only
# when the caller asks for them (with ``sanitizeReplies`` on).
_GENERIC_ERROR_SIGNATURES = (
    re.compile(r'^\s*\w*(?:Exception|Error)\s*:', re.IGNORECASE),
    re.compile(r'^\s*(?:\w*(?:Error|Exception)\s*:\s*)?Error code:\s*\d{3}\b', re.IGNORECASE),
)

# Chunk numbering: each chunk ends with '\n\n*(3/7)*' when it is turned on.
_CHUNK_LABEL_OVERHEAD = len('\n\n*(/)*')

# Prefix added to a capped transcript so the reader knows the head was dropped.
_TRANSCRIPT_TRUNCATION_PREFIX = '…\n'

# Suffix marking a folded attachment whose tail was dropped at the char cap.
_ATTACHMENT_TRUNCATION_SUFFIX = '\n… (truncated)'

# Framing for a message that carries only files. Without it the pipeline gets a
# bare document and no task, and answers generically.
NO_MESSAGE_FRAMING = (
    'The user shared the following file(s) with no message. '
    'Explain what each file is and what it does, and help them with it.'
)

_EXT_TO_MIME = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    # Common on Discord, but only some hosts' MIME tables know them.
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.opus': 'audio/opus',
    '.aac': 'audio/aac',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip',
}

# Python's built-in MIME table only. The module-level ``mimetypes.guess_type``
# also reads the Windows registry and /etc/mime.types, so the same file routed
# differently per host (on Windows .csv is application/vnd.ms-excel and .ts
# video/vnd.dlna.mpeg-tts). A fresh ``MimeTypes()`` is filled from the built-in
# defaults alone; the system files go into the module's own global table.
_BUILTIN_MIME_TYPES = mimetypes.MimeTypes()


def _hard_split(text: str, max_length: int) -> List[str]:
    """Split text into fixed-size pieces, each at most ``max_length`` chars."""
    return [text[i : i + max_length] for i in range(0, len(text), max_length)]


def _split_long_line(text: str, max_length: int) -> List[str]:
    """Split one line with no fence into pieces of at most ``max_length`` chars.

    Each cut falls after the last sentence end, else the last whitespace, in
    the second half of the window (see :func:`_prose_boundary`), and at the
    exact character count only when there is neither.

    Args:
        text (str): The line, longer than ``max_length``.
        max_length (int): The maximum piece length; must be positive.

    Returns:
        List[str]: The pieces in order; joined they give ``text`` back.
    """
    pieces: List[str] = []
    position = 0
    while len(text) - position > max_length:
        end = position + max_length
        cut = _prose_boundary(text, position + max_length // 2, end, False, '', position)
        pieces.append(text[position:cut])
        position = cut
    pieces.append(text[position:])
    return pieces


def _chunk_label(index: int, total: int) -> str:
    """The ``*(i/n)*`` marker appended to one chunk of a numbered reply."""
    return f'\n\n*({index}/{total})*'


def _label_width(total: int) -> int:
    """Room every label needs for a split of ``total`` chunks (worst case)."""
    return _CHUNK_LABEL_OVERHEAD + 2 * len(str(total))


def _numbered_chunks(text: str, max_length: int) -> List[str]:
    """Split ``text`` and end each chunk with ``*(i/n)*``, label included in the cap.

    A reply that needs more than one
    Discord message says which message this is, and the label is paid for by
    the split rather than added on top of a chunk that already fills the limit.

    Args:
        text (str): The reply text.
        max_length (int): The per-message limit, label included.

    Returns:
        List[str]: The chunks; labelled only when there is more than one.
    """
    chunks = chunk_message(text, max_length)
    if len(chunks) < 2:
        return chunks

    # How wide a label is depends on how many chunks there are, so widen the
    # reservation until the split it produces no longer needs a wider one. A
    # smaller cap only ever adds chunks, so this settles after a digit or two.
    reserve = _label_width(len(chunks))
    while max_length - reserve >= 1:
        candidate = chunk_message(text, max_length - reserve)
        needed = _label_width(len(candidate))
        if needed <= reserve:
            chunks = candidate
            break
        reserve = needed
    else:
        # A caller-supplied cap too small to hold content plus a label. The
        # length guarantee is what Discord enforces, so the labels are dropped.
        return chunks

    total = len(chunks)
    if total < 2:
        return chunks
    # A piece's trailing blank lines would sit between its text and the label.
    return [piece.rstrip() + _chunk_label(index, total) for index, piece in enumerate(chunks, 1)]


def chunk_message(text: str, max_length: int = DISCORD_MESSAGE_CHAR_LIMIT, number: bool = False) -> List[str]:
    """Split text into chunks that each fit within Discord's per-message limit.

    Splits on newline boundaries first, then on sentence boundaries for any
    line that still exceeds the limit. A single sentence that is itself longer
    than ``max_length`` is cut at a sentence end or whitespace in the second
    half of each window, and by character count only when there is neither
    (e.g. a long URL). Every returned chunk is guaranteed to be at most
    ``max_length`` characters.

    Args:
        text (str): The reply text.
        max_length (int): The maximum chunk length.
        number (bool): Append ``*(i/n)*`` to every chunk when the reply needs
            more than one message. A single chunk is never labeled.

    Returns:
        List[str]: Non-empty chunks, each at most ``max_length`` characters;
            empty when ``max_length`` is zero or less.
    """
    if max_length <= 0:
        return []
    if number:
        return _numbered_chunks(text, max_length)

    if len(text) <= max_length:
        return [text]

    # Keep the established splitting behavior for ordinary prose. Fenced code
    # needs a little more care: Discord renders each message independently, so
    # a fence spanning two messages leaves both chunks malformed unless we
    # temporarily close and reopen it at the boundary.
    if '```' in text:
        return _chunk_fenced_message(text, max_length)

    chunks: List[str] = []
    current = ''
    for line in text.split('\n'):
        if len(current) + len(line) + 1 <= max_length:
            current += line + '\n'
            continue

        if current:
            chunks.append(current.rstrip())
            current = ''

        if len(line) <= max_length:
            current = line + '\n'
            continue

        # Line too long on its own: split on sentence boundaries.
        sentence = ''
        for part in re.split(r'(?<=[.!?])\s+', line):
            if len(part) > max_length:
                # A single sentence/token exceeds the limit — flush and split
                # at whitespace, or by character count when there is none.
                if sentence:
                    chunks.append(sentence.rstrip())
                    sentence = ''
                chunks.extend(piece.rstrip() for piece in _split_long_line(part, max_length))
            elif len(sentence) + len(part) + 1 <= max_length:
                sentence += part + ' '
            else:
                if sentence:
                    chunks.append(sentence.rstrip())
                sentence = part + ' '
        if sentence:
            chunks.append(sentence.rstrip())

    if current.strip():
        chunks.append(current.rstrip())

    return [c for c in chunks if c.strip()]


def _fence_state(fragment: str, is_open: bool, language: str) -> tuple:
    """Apply real fence tokens in ``fragment`` to the current fence state."""
    for match in re.finditer(r'```', fragment):
        if is_open:
            is_open = False
            language = ''
            continue
        is_open = True
        line_end = fragment.find('\n', match.end())
        if line_end < 0:
            line_end = len(fragment)
        language = fragment[match.end() : line_end].strip()
    return is_open, language


def _opener_offset(fragment: str, is_open: bool) -> int:
    """Where in ``fragment`` the code block still open at its end was opened.

    Args:
        fragment (str): The text to scan, from the start of a chunk.
        is_open (bool): Whether a fence is open at the start of ``fragment``.

    Returns:
        int: The offset of that block's opening backticks; -1 when no block is
            open at the end, or the open one began before ``fragment``.
    """
    opener = -1
    for match in re.finditer(r'```', fragment):
        opener = -1 if is_open else match.start()
        is_open = not is_open
    return opener if is_open else -1


def _ends_opener_line(text: str, position: int, newline: int, is_open: bool) -> bool:
    """Whether the newline at ``newline`` ends a line that opens a code block.

    Args:
        text (str): The whole reply.
        position (int): Where the chunk starts.
        newline (int): The offset of a newline in ``text`` after ``position``.
        is_open (bool): Whether a fence is open at ``position``.

    Returns:
        bool: True when a block opened between ``position`` and ``newline``
            is still open at ``newline`` and its opening backticks sit on the
            line that newline ends; cutting there would leave an empty block.
    """
    opener = _opener_offset(text[position:newline], is_open)
    return opener >= 0 and '\n' not in text[position + opener : newline]


def _safe_fence_boundary(text: str, start: int, end: int) -> int:
    """Move ``end`` so it never cuts through one of the three backticks."""
    fence = text.rfind('```', start, min(len(text), end + 2))
    if fence >= start and fence < end < fence + 3:
        if fence > start:
            return fence
        return min(len(text), fence + 3)
    return end


def _prose_boundary(text: str, start: int, end: int, is_open: bool, language: str, position: int) -> int:
    """Pick a word boundary in ``text[start:end]`` to cut a chunk at.

    Args:
        text (str): The whole reply.
        start (int): The earliest acceptable cut (the window's midpoint).
        end (int): The cut by character count.
        is_open (bool): Whether a fence is open at ``position``.
        language (str): The open fence's language marker.
        position (int): Where the chunk starts.

    Returns:
        int: Just past the last sentence end (``.``, ``!`` or ``?`` followed
            by whitespace), else just past the last whitespace, in the range;
            ``end`` when there is neither or that cut would fall inside a
            code block.
    """
    window = text[start:end]
    candidates = [match.end() for match in re.finditer(r'[.!?]\s', window)]
    if not candidates:
        candidates = [match.end() for match in re.finditer(r'\s', window)]
    if not candidates:
        return end
    cut = start + candidates[-1]
    if cut >= end or _fence_state(text[position:cut], is_open, language)[0]:
        return end
    return cut


def _chunk_fenced_message(text: str, max_length: int) -> List[str]:
    """Hard-split fenced text while balancing fences in every emitted chunk."""
    if max_length <= 0:
        return []
    if max_length < 9:
        # There is not enough room for an opening fence, content, and a closing
        # fence. Preserve the content and length guarantee in this degenerate
        # caller-supplied case.
        return _hard_split(text, max_length)

    chunks: List[str] = []
    position = 0
    is_open = False
    language = ''

    while position < len(text):
        # The language marker is best-effort. A pathological language token
        # must not consume the whole Discord message by itself.
        max_language = max(0, max_length - 9)
        reopen_language = language[:max_language] if is_open else ''
        prefix = f'```{reopen_language}\n' if is_open else ''

        # Reserve room for a closing fence. It is released below when the
        # selected payload ends outside a code block.
        reserved_close = 4
        capacity = max(1, max_length - len(prefix) - reserved_close)
        end = min(len(text), position + capacity)
        # A block opened in this window whose opener line and first code line
        # do not both fit starts the next chunk instead: cutting inside it
        # would split the language name or leave an empty code block behind.
        # Only when they fit there, though; otherwise moving the cut would just
        # send the text before the fence as a short chunk of its own.
        if end < len(text):
            opener = _opener_offset(text[position:end], is_open)
            if opener > 0:
                fence = position + opener
                opener_end = text.find('\n', fence)
                code_end = text.find('\n', opener_end + 1) if opener_end >= 0 else -1
                if code_end < 0:
                    code_end = len(text)
                if code_end >= end and code_end - fence < capacity:
                    end = fence
        # Break between lines when the window has a newline in its second half:
        # a code line cut in two cannot be copied out of either message. The
        # newline is not emitted; the synthetic close/reopen pair stands in for
        # it (consumed below). A newline right before a fence or right after an
        # opener line is passed over, so a boundary never produces an empty
        # code block.
        line_break = False
        if end < len(text):
            newline = text.rfind('\n', position, end)
            while newline > position + capacity // 2 and (
                text.startswith('```', newline + 1) or _ends_opener_line(text, position, newline, is_open)
            ):
                newline = text.rfind('\n', position, newline)
            if newline > position + capacity // 2:
                end = newline
                line_break = True
            elif not _fence_state(text[position:end], is_open, language)[0]:
                # Prose outside a code block (a reply only takes this path
                # because it holds a fence somewhere): break after the last
                # sentence end, else the last whitespace, in the second half
                # rather than in the middle of a word.
                end = _prose_boundary(text, position + capacity // 2, end, is_open, language, position)
        end = _safe_fence_boundary(text, position, end)
        if end <= position:
            end = min(len(text), position + 1)

        # Grow into any spare room when the candidate closes the real fence;
        # otherwise shrink until prefix + payload + synthetic close fits.
        while True:
            payload = text[position:end]
            next_open, next_language = _fence_state(payload, is_open, language)
            suffix = '\n```' if next_open else ''
            overflow = len(prefix) + len(payload) + len(suffix) - max_length
            if overflow <= 0:
                break
            end = _safe_fence_boundary(text, position, max(position + 1, end - overflow))

        chunk = prefix + payload + suffix
        if chunk.strip():
            chunks.append(chunk)
        position = end
        if line_break and next_open and text.startswith('\n', end):
            position = end + 1
        is_open, language = next_open, next_language

    return chunks


def should_process_message(
    *,
    author_id: int,
    bot_user_id: Optional[int],
    author_is_bot: bool,
    ignore_bots: bool,
    guild_id: Optional[int],
    channel_id: int,
    allowed_guild_ids: List[str],
    allowed_channel_ids: List[str],
    require_mention: bool,
    is_mentioned: bool,
    parent_channel_id: Optional[int] = None,
    allowed_bot_ids: Optional[List[str]] = None,
) -> bool:
    """Decide whether an incoming message should be routed to the pipeline.

    Pure predicate (no discord.py types) so the gating rules can be unit-tested
    in isolation. ``_on_message`` extracts the relevant primitives from the
    Gateway message and delegates the decision here.

    Args:
        author_id: The message author's user id.
        bot_user_id: This bot's own user id, or None if not yet known.
        author_is_bot: Whether the author is a bot account.
        ignore_bots: Whether messages from other bots should be ignored.
        guild_id: The originating guild id, or None for DMs.
        channel_id: The originating channel id.
        allowed_guild_ids: Guild allowlist (empty means all guilds).
        allowed_channel_ids: Channel allowlist (empty means all channels).
        require_mention: Whether the bot must be @mentioned to respond.
        is_mentioned: Whether the bot is mentioned in this message.
        parent_channel_id: A thread's parent channel id, which also matches
            the channel allowlist; None outside a thread.
        allowed_bot_ids: Bot user ids let through while ``ignore_bots`` is on.

    Returns:
        bool: True if the message passes every gate and should be processed.
    """
    # Never process our own messages (prevents reply loops).
    if bot_user_id is not None and author_id == bot_user_id:
        return False
    if ignore_bots and author_is_bot and str(author_id) not in (allowed_bot_ids or []):
        return False
    if allowed_guild_ids and (guild_id is None or str(guild_id) not in allowed_guild_ids):
        return False
    if (
        allowed_channel_ids
        and str(channel_id) not in allowed_channel_ids
        and str(parent_channel_id) not in allowed_channel_ids
    ):
        return False
    if require_mention and not is_mentioned:
        return False
    return True


def format_thread_transcript(
    entries: Iterable[Tuple[str, str]],
    max_chars: int = THREAD_HISTORY_MAX_CHARS,
) -> str:
    """Render prior thread messages as a plain ``<name>: <content>`` transcript.

    Mirrors the support bot's ``threadTranscript``: one entry per message,
    oldest first, and a tail-capped result prefixed with an ellipsis line when
    the transcript is longer than ``max_chars`` (keeping the most recent
    context, which is what the agent needs); the cut never leaves part of a
    message at the top, unless that part is all there is. Each message is clipped to
    :data:`THREAD_HISTORY_MESSAGE_MAX_CHARS`, and its continuation lines are
    indented, so only the first line of a message starts with a speaker name:
    one user cannot forge lines from another speaker, the bot included.

    Args:
        entries: ``(author_name, content)`` pairs, already ordered oldest first
            and already filtered (no system messages, no empty content).
        max_chars: Maximum transcript length before the head is dropped.

    Returns:
        str: The transcript, or '' when there is nothing to show.
    """
    lines: List[str] = []
    for name, content in entries:
        text = (content or '').strip()
        if not text:
            continue
        if len(text) > THREAD_HISTORY_MESSAGE_MAX_CHARS:
            text = text[:THREAD_HISTORY_MESSAGE_MAX_CHARS] + '…'
        lines.append(f'{name}: ' + _TRANSCRIPT_CONTINUATION.join(text.split('\n')))
    out = '\n'.join(lines)
    if max_chars > 0 and len(out) > max_chars:
        tail = out[-max_chars:]
        on_line_start = out[-max_chars - 1] == '\n' and not tail.startswith(_TRANSCRIPT_CONTINUATION[1:])
        if not on_line_start:
            # The cut landed inside a message: start at the next speaker line.
            start = _SPEAKER_LINE_START.search(tail)
            if start is not None and tail[start.end() :]:
                tail = tail[start.end() :]
        out = _TRANSCRIPT_TRUNCATION_PREFIX + tail
    return out


def with_thread_context(content: str, transcript: str) -> str:
    """Frame the latest message plus its thread transcript for the pipeline.

    Mirrors the support bot's context framing. Returns ``content`` unchanged
    when there is no transcript, so a brand-new thread is a no-op.

    Args:
        content (str): The user's latest message text.
        transcript (str): The formatted transcript (see
            :func:`format_thread_transcript`).

    Returns:
        str: The text to hand to the pipeline.
    """
    if not transcript:
        return content
    return f"User's latest message: {content}\n\nEarlier in this thread (oldest first, for context):\n{transcript}"


def attachment_kind(mime_type: str) -> str:
    """Name the modality of an attachment as the merged question refers to it.

    Args:
        mime_type (str): The attachment MIME type.

    Returns:
        str: 'image', 'audio', 'video', or 'file' for anything else.
    """
    for kind in ('image', 'audio', 'video'):
        if mime_type.startswith(f'{kind}/'):
            return kind
    return 'file'


def decode_text_attachment(data: bytes) -> Optional[str]:
    """Decode a text-like attachment, or say it holds binary content.

    The one decode both attachment paths use (merged or not), so a file is
    text on one path exactly when it is text on the other.

    Args:
        data (bytes): The downloaded file.

    Returns:
        Optional[str]: The text with invalid bytes ignored: UTF-16 when the
            file starts with a UTF-16 byte order mark (Windows Notepad
            "Unicode", PowerShell 5.1 redirects), else UTF-8 with any UTF-8
            byte order mark stripped. None when the decoded text still holds
            a NUL: binary content.
    """
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        text = data.decode('utf-16', errors='ignore')
    else:
        text = data.decode('utf-8-sig', errors='ignore')
    if '\x00' in text:
        return None
    return text


def clip_attachment_text(text: str, max_chars: int) -> str:
    """Apply the ``textAttachmentMaxChars`` cap to decoded attachment text.

    Args:
        text (str): The decoded text.
        max_chars (int): Maximum characters kept. Zero or less keeps everything.

    Returns:
        str: The text, cut to ``max_chars`` when the cap applies.
    """
    return text[:max_chars] if max_chars > 0 else text


def fold_text_attachment(name: str, content: str, max_chars: int = 12000) -> str:
    """Render a text-like attachment as a fenced block for the merged question.

    A text file travels with the
    user's own words instead of becoming a separate question, so one answer has
    seen both.

    Args:
        name (str): The attachment filename.
        content (str): The decoded file content.
        max_chars (int): Maximum characters kept; anything beyond is dropped
            behind a ``… (truncated)`` line. Zero or less keeps everything.

    Returns:
        str: The block to fold into the question.
    """
    text = clip_attachment_text(content, max_chars)
    if len(text) < len(content):
        text += _ATTACHMENT_TRUNCATION_SUFFIX
    return f'Contents of attached file "{name}":\n```\n{text}\n```'


def fold_binary_answer(kind: str, name: str, answer: str) -> str:
    """Render what the pipeline made of one binary attachment as context.

    Args:
        kind (str): The modality word (see :func:`attachment_kind`).
        name (str): The attachment filename.
        answer (str): The answer that attachment's lane produced.

    Returns:
        str: The block to fold into the question.
    """
    return f'What the pipeline found in the attached {kind} "{name}":\n{answer}'


def compose_merged_question(user_text: str, blocks: Sequence[str]) -> str:
    """Join the user's words and the folded attachment blocks into one question.

    Args:
        user_text (str): The user's message (already carrying thread context).
        blocks (Sequence[str]): Folded blocks, in the order they should appear.

    Returns:
        str: The text handed to the text lane — ``user_text`` unchanged when
            there is nothing to fold, and a message that is only files framed
            with :data:`NO_MESSAGE_FRAMING` so the pipeline is given a task
            rather than a bare document.
    """
    parts = [block for block in blocks if block]
    if not parts:
        return user_text
    if user_text:
        return '\n\n'.join([user_text, *parts])
    return '\n\n'.join([NO_MESSAGE_FRAMING, *parts])


def find_marker(text: str, markers: Sequence[str]) -> Optional[str]:
    """Return the first configured escalation marker present in ``text``.

    The support bot tests a single team role mention; the node generalizes that
    to a configured list (plus the outbound-allowlisted role mentions). A marker
    counts only as a whole word (``ESCALATED`` is not found in ``NOTESCALATED``;
    an edge that is punctuation, as in ``<@&id>``, needs no boundary) and only
    outside fenced code blocks.

    Args:
        text (str): The text to inspect (typically a pipeline answer).
        markers (Sequence[str]): The effective escalation markers.

    Returns:
        Optional[str]: The first marker found, in configured order, else None.
    """
    if not text:
        return None
    for marker in markers or ():
        if not marker:
            continue
        lead = r'(?<![\w/])' if re.match(r'\w', marker[0]) else ''
        trail = r'(?!\w)' if re.match(r'\w', marker[-1]) else ''
        pattern = re.compile(lead + re.escape(marker) + trail)
        if _outside_code_fences(text, pattern.finditer(text)):
            return marker
    return None


def looks_like_error(text: str, generic: bool = True) -> bool:
    """Whether this "answer" is really an engine or model failure.

    Mirrors the support bot's ``looksLikeError``, plus the shapes that reached
    a user anyway: a provider status such as ``Error code: 429 - {...}`` and,
    when ``generic`` is on, a reply that opens with ``Exception:`` /
    ``Error:`` / ``<Name>Error:`` or a bare ``Error code: 429``. The caller
    suppresses these instead of relaying them to Discord.

    Both the reply and the final text an agent wrapped in it (the last
    ``Final Answer:``, or a ``{"type": "final"}`` envelope) are checked, so a
    wrapped error is caught however the reply is posted.

    Args:
        text (str): The candidate reply.
        generic (bool): Also count the generic error-shaped openings, which a
            real answer may start with; off, only engine and provider
            failures count.

    Returns:
        bool: True when the text is a failure rather than an answer.
    """
    if not text:
        return False
    patterns = _ERROR_SIGNATURES + (_GENERIC_ERROR_SIGNATURES if generic else ())
    candidates = [text]
    final, _found = _extract_final(text)
    if final and final != text:
        candidates.append(final)
    for candidate in candidates:
        candidate = _CODE_FENCE.sub(_CODE_PLACEHOLDER, candidate)
        if any(pattern.search(candidate) for pattern in patterns):
            return True
    return False


def _outside_code_fences(text: str, matches) -> list:
    """Keep only the regex matches that do not start inside a fenced code block.

    Args:
        text (str): The text the matches were found in.
        matches: The ``re.Match`` objects, in any order.

    Returns:
        list: The matches outside code fences, in their original order.
    """
    fences = [fence.span() for fence in _CODE_FENCE.finditer(text)]
    return [match for match in matches if not any(start <= match.start() < end for start, end in fences)]


def _alias_pattern(alias: str) -> Optional['re.Pattern']:
    """The regex that finds the team alias in an answer, or None for no alias.

    Case-insensitive, and whitespace inside the alias matches any run of
    whitespace, so a line break between the words still hits. Only a whole
    word counts: not inside a longer word (``Support`` in ``supportive``) or a
    URL path (``/support/``).

    Args:
        alias (str): The configured team alias.

    Returns:
        Optional[re.Pattern]: The compiled pattern, or None when the alias is
            empty or only whitespace.
    """
    tokens = [re.escape(token) for token in (alias or '').split()]
    if not tokens:
        return None
    return re.compile(r'(?<![\w/])' + r'\s+'.join(tokens) + r'(?!\w)', re.IGNORECASE)


def contains_alias(text: str, alias: str) -> bool:
    """Whether ``text`` names the team alias where it would be injected.

    Args:
        text (str): The answer.
        alias (str): The configured alias (empty never matches).

    Returns:
        bool: True when :func:`inject_role_mention` would replace something.
    """
    pattern = _alias_pattern(alias)
    if not text or pattern is None:
        return False
    return bool(_outside_code_fences(text, pattern.finditer(text)))


def inject_role_mention(text: str, alias: str, role_mention: str) -> str:
    """Turn the literal team name the model wrote into a real role mention.

    Mirrors the support bot's ``injectRoleMention``: the agent is prompted to
    hand off to "@RocketRide team", which Discord renders as plain text and
    pings nobody. Matching is case-insensitive, and whitespace inside the alias
    matches any run of whitespace so a line break between the words still hits.
    Only whole-word occurrences outside fenced code blocks are replaced, since
    each replacement garbles the text it hits and sends a real ping.

    Args:
        text (str): The pipeline answer.
        alias (str): The configured literal alias (empty disables this).
        role_mention (str): The ``<@&id>`` mention to substitute.

    Returns:
        str: The answer with every occurrence of the alias replaced.
    """
    if not text or not alias or not role_mention:
        return text
    pattern = _alias_pattern(alias)
    if pattern is None:
        return text
    outside = {match.start() for match in _outside_code_fences(text, pattern.finditer(text))}
    # A function, not the string itself: a replacement is a template, and a
    # backslash in it would otherwise be read as a group reference.
    return pattern.sub(lambda match: role_mention if match.start() in outside else match.group(0), text)


def _handoff_marker(scratchpad: str, markers: Sequence[str], alias: str) -> Optional[str]:
    """The escalation marker on a scratchpad's final hand-off line, if any.

    Only the last non-empty line counts, and only when it is not itself a
    reasoning line: a ``Thought:`` that merely names the team ("I could hand
    off to the team, but...") is not a hand-off.

    Args:
        scratchpad (str): A reply that opens with a reasoning label.
        markers (Sequence[str]): The effective escalation markers.
        alias (str): The team alias, which also counts as a marker here.

    Returns:
        Optional[str]: The marker found (the alias as configured, with its
            whitespace collapsed, when only the alias is there), else None.
    """
    lines = [line for line in scratchpad.split('\n') if line.strip()]
    if not lines or _OPENS_WITH_REASONING.match(lines[-1]):
        return None
    last = lines[-1]
    marker = find_marker(last, markers)
    if marker:
        return marker
    pattern = _alias_pattern(alias)
    if pattern is not None and pattern.search(last):
        return ' '.join(alias.split())
    return None


def _extract_final(text: str) -> Tuple[str, bool]:
    """The final text an agent wrapped its answer in, else the reply itself.

    Unwraps a ``{"type": "final", "content": "..."}`` envelope (when it is the
    whole reply, or the end of a reply that opens as scratchpad), then keeps
    only what follows the LAST ``Final Answer:`` outside code (when non-empty).

    Args:
        text (str): The raw pipeline answer.

    Returns:
        Tuple[str, bool]: The stripped text, and whether an envelope or a
            non-empty ``Final Answer:`` supplied it.
    """
    result = (text or '').strip()
    if not result:
        return result, False
    found = False

    envelope = _FINAL_JSON.search(result)
    if envelope and (
        envelope.end() != len(result) or (envelope.start() != 0 and not _OPENS_WITH_REASONING.match(result))
    ):
        envelope = None
    if envelope:
        captured = envelope.group(1)
        try:
            result = json.loads(f'"{captured}"')
        except ValueError:
            # An envelope we cannot decode still told us where the answer is.
            result = captured
        result = result.strip()
        found = True
        if not result:
            return result, found

    marks = _outside_code_fences(result, _FINAL_ANSWER.finditer(result))
    if marks:
        after = result[marks[-1].end() :].strip()
        if after:
            result = after
            found = True
    return result, found


def sanitize_reply(text: str, markers: Sequence[str], alias: str = '') -> str:
    """Strip leaked agent scratchpad from a reply before it is posted.

    Mirrors the support bot's ``sanitizeReply`` (plus its ``extractFinalText``):

    - unwrap a ``{"type": "final", "content": "..."}`` envelope;
    - keep only what follows the LAST ``Final Answer:`` (when non-empty);
    - if the result still opens with a reasoning label it is scratchpad, not an
      answer: when it came from a ``Final Answer:`` or envelope and its final
      line (the last non-empty one, not itself a reasoning line) carries an
      escalation marker it becomes a short hand-off line that keeps the
      marker, otherwise it becomes '' so nothing is posted. A scratchpad with
      no final answer is never a hand-off: its last line may be tool output
      (an ``Observation:`` that names the team), not the agent handing off.

    The team alias is not turned into a role mention here: the caller does that
    on the text it finally posts, so reasoning that names the team never pings.

    Args:
        text (str): The raw pipeline answer.
        markers (Sequence[str]): The effective escalation markers.
        alias (str): The team alias, counted as a marker on the hand-off line.

    Returns:
        str: The reply to post, or '' when there is no real answer.
    """
    result, found = _extract_final(text)
    if not result:
        return result

    if _OPENS_WITH_REASONING.match(result):
        if not found:
            return ''
        marker = _handoff_marker(result, markers, alias)
        if marker:
            return f"Thanks for flagging this — I've looped in the team to take a look. {marker}"
        return ''
    return result


def is_aimed_at_someone_else(
    *,
    is_bot_mentioned: bool,
    mentioned_user_ids: Sequence[str],
    bot_user_id: Optional[str],
    role_mention_count: int,
    is_reply: bool,
    reply_target_is_bot: Optional[bool] = None,
    reply_target_is_author: Optional[bool] = None,
) -> bool:
    """Decide whether a message is addressed to somebody other than the bot.

    Pure mirror of the support bot's ``isAimedAtSomeoneElse``: a direct mention
    of the bot always wins; otherwise a mention of another user or any role, or
    a reply to a message the bot did not author, means the message belongs to
    someone else's conversation. A reply to the author's own earlier message
    (a common way to add details) is not.

    Args:
        is_bot_mentioned: Whether the bot is directly @mentioned.
        mentioned_user_ids: The mentioned user ids, as strings.
        bot_user_id: The bot's own user id as a string, or None if unknown.
        role_mention_count: How many roles the message mentions.
        is_reply: Whether the message replies to another message.
        reply_target_is_bot: Whether the replied-to message is the bot's, or
            None when it could not be fetched.
        reply_target_is_author: Whether the replied-to message was written by
            the author of this message, or None when it could not be fetched.

    Returns:
        bool: True when the message should be acknowledged rather than answered.
    """
    if is_bot_mentioned:
        return False
    mentions_others = any(str(user_id) != str(bot_user_id) for user_id in mentioned_user_ids or ()) or (
        role_mention_count > 0
    )
    if not mentions_others and not is_reply:
        return False
    if is_reply and reply_target_is_bot:
        return False
    if is_reply and reply_target_is_author:
        # Adding details to your own message; a mention still aims it elsewhere.
        return mentions_others
    return True


def guess_media_type(filename: str, content_type: str = '') -> str:
    """Guess a MIME type from a reported content type or the file extension.

    Args:
        filename (str): The attachment filename.
        content_type (str): The reported content type, if any (takes priority).

    Returns:
        str: A MIME type string: the reported type, else the node's own
            extension table, else Python's built-in ``mimetypes`` table (never
            the host's), else 'application/octet-stream'.
    """
    if content_type:
        # Normalize to lowercase without parameters (e.g. '; charset=utf-8').
        # discord.py usually reports lowercase, but a mixed-case 'Image/PNG'
        # would otherwise fail the 'image/' lane check downstream. A malformed
        # value that normalizes to empty falls through to the extension guess.
        mime = content_type.split(';')[0].strip().lower()
        if mime:
            return mime

    filename_lower = filename.lower()
    for ext, mime_type in _EXT_TO_MIME.items():
        if filename_lower.endswith(ext):
            return mime_type
    # Anything the table does not list (.avi, .bmp, ...) would otherwise go
    # to the tags lane whatever it is: ask Python's MIME table before giving up.
    return _BUILTIN_MIME_TYPES.guess_type(filename_lower)[0] or 'application/octet-stream'
