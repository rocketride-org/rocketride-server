# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for the Discord bot source node.

These tests exercise the node's real pure-logic helpers (message chunking and
MIME-type detection) plus the shipped services.json schema. The helpers live in
``text_utils.py`` — a module with no discord.py dependency — so they are loaded
directly by file path here, avoiding both the discord.py runtime requirement and
the name collision between the ``discord`` node package and the discord.py
library during test collection.
"""

import importlib.util
import json
import os

import pytest

_NODE_DIR = os.path.join(os.path.dirname(__file__), '../../src/nodes/discord')
_SERVICES_JSON = os.path.join(_NODE_DIR, 'services.json')


def _load_text_utils():
    """Load the node's text_utils module directly from its file path."""
    path = os.path.join(_NODE_DIR, 'text_utils.py')
    spec = importlib.util.spec_from_file_location('discord_text_utils', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


text_utils = _load_text_utils()
chunk_message = text_utils.chunk_message
guess_media_type = text_utils.guess_media_type
should_process_message = text_utils.should_process_message
DISCORD_MESSAGE_CHAR_LIMIT = text_utils.DISCORD_MESSAGE_CHAR_LIMIT


def _gate(**overrides):
    """Build should_process_message kwargs with permissive defaults."""
    kwargs = dict(
        author_id=1,
        bot_user_id=999,
        author_is_bot=False,
        ignore_bots=True,
        guild_id=10,
        channel_id=20,
        allowed_guild_ids=[],
        allowed_channel_ids=[],
        require_mention=False,
        is_mentioned=False,
    )
    kwargs.update(overrides)
    return should_process_message(**kwargs)


class TestShouldProcessMessage:
    """Test the real gating predicate."""

    def test_default_message_passes(self):
        assert _gate() is True

    def test_own_message_skipped(self):
        assert _gate(author_id=999, bot_user_id=999) is False

    def test_bot_message_skipped_when_ignore_bots(self):
        assert _gate(author_is_bot=True, ignore_bots=True) is False

    def test_bot_message_allowed_when_not_ignoring(self):
        assert _gate(author_is_bot=True, ignore_bots=False) is True

    def test_guild_allowlist_blocks_other_guilds(self):
        assert _gate(guild_id=10, allowed_guild_ids=['77']) is False
        assert _gate(guild_id=77, allowed_guild_ids=['77']) is True

    def test_guild_allowlist_blocks_dms(self):
        assert _gate(guild_id=None, allowed_guild_ids=['77']) is False

    def test_channel_allowlist(self):
        assert _gate(channel_id=20, allowed_channel_ids=['21']) is False
        assert _gate(channel_id=21, allowed_channel_ids=['21']) is True

    def test_require_mention_gate(self):
        assert _gate(require_mention=True, is_mentioned=False) is False
        assert _gate(require_mention=True, is_mentioned=True) is True

    def test_empty_allowlists_allow_all(self):
        assert _gate(allowed_guild_ids=[], allowed_channel_ids=[]) is True


class TestChunkMessage:
    """Test the real chunk_message helper against Discord's 2000-char limit."""

    def test_short_message_not_chunked(self):
        text = 'Hello, this is a short message.'
        assert chunk_message(text) == [text]

    def test_exact_limit_not_chunked(self):
        text = 'a' * DISCORD_MESSAGE_CHAR_LIMIT
        chunks = chunk_message(text)
        assert chunks == [text]

    def test_long_message_split_by_lines(self):
        text = 'Line\n' * 500
        chunks = chunk_message(text)
        assert len(chunks) > 1
        assert all(len(c) <= DISCORD_MESSAGE_CHAR_LIMIT for c in chunks)

    def test_every_chunk_within_limit(self):
        text = 'This is a sentence. ' * 300
        chunks = chunk_message(text)
        assert len(chunks) > 1
        assert all(len(c) <= DISCORD_MESSAGE_CHAR_LIMIT for c in chunks)

    def test_unbroken_token_longer_than_limit_is_hard_split(self):
        # A single token with no whitespace/sentence boundary must still be
        # split so no chunk exceeds the limit (regression: previously emitted
        # one oversized chunk that Discord would reject).
        text = 'a' * 4501
        chunks = chunk_message(text)
        assert all(len(c) <= DISCORD_MESSAGE_CHAR_LIMIT for c in chunks)
        assert ''.join(chunks) == text  # no data lost
        assert len(chunks) == 3  # 2000 + 2000 + 501

    def test_no_empty_chunks(self):
        text = 'word ' * 800
        chunks = chunk_message(text)
        assert all(c.strip() for c in chunks)

    def test_custom_max_length(self):
        chunks = chunk_message('abcdefghij', max_length=4)
        assert all(len(c) <= 4 for c in chunks)
        assert ''.join(chunks) == 'abcdefghij'


class TestGuessMediaType:
    """Test the real guess_media_type helper."""

    def test_image_types(self):
        assert guess_media_type('photo.jpg') == 'image/jpeg'
        assert guess_media_type('picture.png') == 'image/png'
        assert guess_media_type('animation.gif') == 'image/gif'
        assert guess_media_type('modern.webp') == 'image/webp'

    def test_audio_types(self):
        assert guess_media_type('song.mp3') == 'audio/mpeg'
        assert guess_media_type('clip.wav') == 'audio/wav'
        assert guess_media_type('voice.ogg') == 'audio/ogg'

    def test_video_types(self):
        assert guess_media_type('movie.mp4') == 'video/mp4'
        assert guess_media_type('clip.webm') == 'video/webm'
        assert guess_media_type('video.mov') == 'video/quicktime'

    def test_document_types(self):
        assert guess_media_type('doc.pdf') == 'application/pdf'
        assert guess_media_type('report.docx').endswith('wordprocessingml.document')
        assert guess_media_type('sheet.xlsx').endswith('spreadsheetml.sheet')
        assert guess_media_type('archive.zip') == 'application/zip'

    def test_unknown_defaults_to_octet_stream(self):
        assert guess_media_type('file.xyz') == 'application/octet-stream'
        assert guess_media_type('noext') == 'application/octet-stream'

    def test_case_insensitive_extension(self):
        assert guess_media_type('Photo.JPG') == 'image/jpeg'
        assert guess_media_type('Document.PDF') == 'application/pdf'

    def test_content_type_takes_priority(self):
        assert guess_media_type('file.jpg', 'image/png') == 'image/png'
        assert guess_media_type('file.bin', 'text/plain') == 'text/plain'

    def test_content_type_parameters_stripped(self):
        assert guess_media_type('file.txt', 'text/plain; charset=utf-8') == 'text/plain'

    def test_content_type_case_normalized(self):
        # A mixed-case reported type must lowercase so the downstream
        # startswith('image/') lane check still routes it correctly.
        assert guess_media_type('file.bin', 'IMAGE/PNG') == 'image/png'
        assert guess_media_type('file.bin', 'Image/PNG; charset=binary') == 'image/png'

    def test_malformed_content_type_falls_back_to_extension(self):
        # A present-but-empty-after-normalization content type must not win;
        # fall through to the filename extension.
        assert guess_media_type('photo.jpg', '   ; charset=utf-8') == 'image/jpeg'
        assert guess_media_type('mystery.xyz', ' ; x=y') == 'application/octet-stream'


class TestServicesJsonSchema:
    """Validate the shipped services.json contract."""

    @pytest.fixture(scope='class')
    def schema(self):
        with open(_SERVICES_JSON, 'r', encoding='utf-8') as f:
            return json.load(f)

    def test_top_level_keys(self, schema):
        for key in ('title', 'protocol', 'classType', 'fields', 'lanes'):
            assert key in schema, f'missing top-level key: {key}'
        assert schema['protocol'] == 'discord://'
        assert schema['classType'] == ['source']

    def test_all_config_fields_present(self, schema):
        required = [
            'discord.botToken',
            'discord.guildIds',
            'discord.channelIds',
            'discord.ignoreBots',
            'discord.requireMention',
            'discord.replyMode',
            'discord.showTyping',
            'discord.maxAttachmentBytes',
            'discord.sendResponses',
        ]
        for field in required:
            assert field in schema['fields'], f'missing field: {field}'

    def test_bot_token_is_secure(self, schema):
        assert schema['fields']['discord.botToken'].get('secure') is True

    def test_source_lanes(self, schema):
        lanes = schema['lanes']['_source']
        for lane in ('text', 'image', 'audio', 'video', 'tags'):
            assert lane in lanes, f'missing lane: {lane}'

    def test_reply_mode_enum(self, schema):
        assert schema['fields']['discord.replyMode']['enum'] == ['channel', 'reply', 'thread']


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
