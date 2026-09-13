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

import re
from typing import List, Optional

DISCORD_MESSAGE_CHAR_LIMIT: int = 2000  # Discord's per-message cap

_EXT_TO_MIME = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip',
}


def _hard_split(text: str, max_length: int) -> List[str]:
    """Split text into fixed-size pieces, each at most ``max_length`` chars."""
    return [text[i : i + max_length] for i in range(0, len(text), max_length)]


def chunk_message(text: str, max_length: int = DISCORD_MESSAGE_CHAR_LIMIT) -> List[str]:
    """Split text into chunks that each fit within Discord's per-message limit.

    Splits on newline boundaries first, then on sentence boundaries for any
    line that still exceeds the limit, and finally hard-splits any single
    token/sentence that is itself longer than ``max_length`` (e.g. a long URL
    with no whitespace). Every returned chunk is guaranteed to be at most
    ``max_length`` characters.

    Args:
        text (str): The reply text.
        max_length (int): The maximum chunk length.

    Returns:
        List[str]: Non-empty chunks, each at most ``max_length`` characters.
    """
    if len(text) <= max_length:
        return [text]

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
    if ignore_bots and author_is_bot:
        return False
    if allowed_guild_ids and (guild_id is None or str(guild_id) not in allowed_guild_ids):
        return False
    if allowed_channel_ids and str(channel_id) not in allowed_channel_ids:
        return False
    if require_mention and not is_mentioned:
        return False
    return True


def guess_media_type(filename: str, content_type: str = '') -> str:
    """Guess a MIME type from a reported content type or the file extension.

    Args:
        filename (str): The attachment filename.
        content_type (str): The reported content type, if any (takes priority).

    Returns:
        str: A MIME type string, defaulting to 'application/octet-stream'.
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
    return 'application/octet-stream'
