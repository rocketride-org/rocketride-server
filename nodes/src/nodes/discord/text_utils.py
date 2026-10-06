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
import mimetypes
import re
from typing import List, Optional, Sequence

DISCORD_MESSAGE_CHAR_LIMIT: int = 2000  # Discord's per-message cap

# Chunk numbering: each chunk ends with '\n\n*(3/7)*' when it is turned on.
_CHUNK_LABEL_OVERHEAD = len('\n\n*(/)*')

# Suffix marking a folded attachment whose tail was dropped at the char cap.
_ATTACHMENT_TRUNCATION_SUFFIX = '\n… (truncated)'

# Framing for a message that carries only files. Without it the pipeline gets a
# bare document and no task, and answers generically (the support bot's
# ``collectParts`` adds the same line).
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


def _chunk_label(index: int, total: int) -> str:
    """The ``*(i/n)*`` marker appended to one chunk of a numbered reply."""
    return f'\n\n*({index}/{total})*'


def _label_width(total: int) -> int:
    """Room every label needs for a split of ``total`` chunks (worst case)."""
    return _CHUNK_LABEL_OVERHEAD + 2 * len(str(total))


def _numbered_chunks(text: str, max_length: int) -> List[str]:
    """Split ``text`` and end each chunk with ``*(i/n)*``, label included in the cap.

    Mirrors the support bot's ``chunk``: a reply that needs more than one
    Discord message says which message this is, and the label is paid for by
    the split rather than added on top of a chunk that already fills the limit.
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
    line that still exceeds the limit, and finally hard-splits any single
    token/sentence that is itself longer than ``max_length`` (e.g. a long URL
    with no whitespace). Every returned chunk is guaranteed to be at most
    ``max_length`` characters.

    Args:
        text (str): The reply text.
        max_length (int): The maximum chunk length.
        number (bool): Append ``*(i/n)*`` to every chunk when the reply needs
            more than one message. A single chunk is never labeled.

    Returns:
        List[str]: Non-empty chunks, each at most ``max_length`` characters.
    """
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
                # A single sentence/token exceeds the limit — flush and hard-split.
                if sentence:
                    chunks.append(sentence.rstrip())
                    sentence = ''
                chunks.extend(_hard_split(part, max_length))
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
        # Break between lines when the window has a newline in its second half:
        # a code line cut in two cannot be copied out of either message. The
        # newline is not emitted; the synthetic close/reopen pair stands in for
        # it (consumed below). A newline right before a fence is passed over, so
        # a boundary never produces an empty code block.
        line_break = False
        if end < len(text):
            newline = text.rfind('\n', position, end)
            while newline > position + capacity // 2 and text.startswith('```', newline + 1):
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

    Mirrors the support bot's ``collectParts``: a text file travels with the
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
        user_text (str): The user's message.
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
