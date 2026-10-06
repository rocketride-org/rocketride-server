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

import codecs
import importlib.util
import json
import mimetypes
import os
import re
from unittest import mock

import pytest

_NODE_DIR = os.path.join(os.path.dirname(__file__), '../../src/nodes/discord')
_SERVICES_JSON = os.path.join(_NODE_DIR, 'services.json')


def _load_services_json():
    """Parse services.json, which is JSONC: its whole-line ``//`` comments are dropped first."""
    with open(_SERVICES_JSON, 'r', encoding='utf-8') as handle:
        lines = handle.read().split('\n')
    return json.loads('\n'.join(line for line in lines if not line.lstrip().startswith('//')))


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
        parent_channel_id=None,
        allowed_guild_ids=[],
        allowed_channel_ids=[],
        allowed_bot_ids=[],
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

    def test_thread_parent_channel_allowlist(self):
        assert _gate(channel_id=99, parent_channel_id=21, allowed_channel_ids=['21']) is True
        assert _gate(channel_id=99, parent_channel_id=22, allowed_channel_ids=['21']) is False

    def test_allowed_bot_overrides_ignore_bots(self):
        assert _gate(author_id=42, author_is_bot=True, allowed_bot_ids=['42']) is True
        assert _gate(author_id=43, author_is_bot=True, allowed_bot_ids=['42']) is False

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

    def test_numbering_is_off_by_default_and_labels_every_chunk_when_on(self):
        text = 'Line\n' * 500
        plain = chunk_message(text)
        numbered = chunk_message(text, number=True)

        assert len(plain) > 1
        assert not any(chunk.endswith('*') for chunk in plain), 'numbering must be opt-in'
        total = len(numbered)
        assert total > 1
        for index, chunk in enumerate(numbered, 1):
            assert chunk.endswith(f'\n\n*({index}/{total})*')

    def test_numbered_chunks_still_fit_the_discord_limit(self):
        # The label has to be paid for by the split, not added on top of a
        # chunk that already fills the message.
        text = 'This is a sentence. ' * 2000
        numbered = chunk_message(text, number=True)

        assert len(numbered) > 9, 'a three-digit-free run of labels is not the interesting case'
        assert all(len(chunk) <= DISCORD_MESSAGE_CHAR_LIMIT for chunk in numbered)

    def test_a_single_chunk_is_never_labelled(self):
        assert chunk_message('short enough', number=True) == ['short enough']
        exact = 'a' * DISCORD_MESSAGE_CHAR_LIMIT
        assert chunk_message(exact, number=True) == [exact]

    def test_a_cap_too_small_for_a_label_keeps_the_length_guarantee(self):
        # Degenerate caller-supplied max_length: the limit is what Discord
        # enforces, so the labels are what gets dropped.
        chunks = chunk_message('word ' * 50, max_length=12, number=True)
        assert all(len(chunk) <= 12 for chunk in chunks)
        assert not any('*(' in chunk for chunk in chunks)

    def test_numbering_keeps_the_whole_answer(self):
        text = 'word ' * 800
        numbered = chunk_message(text, number=True)
        stripped = [re.sub(r'\n\n\*\(\d+/\d+\)\*$', '', chunk) for chunk in numbered]
        assert ''.join(stripped).split() == text.split()

    def test_code_fence_is_balanced_across_chunks(self):
        text = 'Intro\n```python\n' + ('print("long code line")\n' * 10) + '```\nOutro'
        chunks = chunk_message(text, max_length=60)

        assert len(chunks) > 1
        assert all(len(chunk) <= 60 for chunk in chunks)
        assert all(chunk.count('```') % 2 == 0 for chunk in chunks)
        # Removing synthetic close/reopen boundaries reconstructs all original
        # non-whitespace content, including the opening language marker.
        joined = ''.join(chunks).replace('\n``````python\n', '')
        assert ''.join(joined.split()) == ''.join(text.split())

    def test_a_long_code_block_splits_between_lines(self):
        # Live F12/F44: every boundary inside a fence used to cut a code line in
        # two, so a copied block was broken. Each message must hold whole lines.
        body = ''.join(f'line {index:04d} ' + 'x' * 12 + '\n' for index in range(300))
        text = 'Intro\n```\n' + body + '```\nOutro'
        chunks = chunk_message(text)

        assert len(chunks) > 2
        assert all(len(chunk) <= DISCORD_MESSAGE_CHAR_LIMIT for chunk in chunks)
        full_line = re.compile(r'^line \d{4} x{12}$')
        for chunk in chunks:
            for line in chunk.splitlines():
                if line.startswith('line '):
                    assert full_line.match(line), f'cut mid-line: {line!r}'
        # The fence pair standing in for each boundary newline is the only change.
        assert ''.join(chunks).replace('\n``````\n', '\n') == text

    def test_a_single_line_longer_than_a_chunk_is_still_split(self):
        # No newline to break on: the length guarantee still holds.
        text = '```\n' + 'y' * 5000 + '\n```'
        chunks = chunk_message(text)
        assert all(len(chunk) <= DISCORD_MESSAGE_CHAR_LIMIT for chunk in chunks)
        assert ''.join(chunks).replace('\n``````\n', '').count('y') == 5000

    @staticmethod
    def _paragraph(length, word='setup'):
        """Prose of about ``length`` characters with no newline in it."""
        sentence = f'This explains one step of the {word} in plain words. '
        return (sentence * (length // len(sentence) + 1))[:length].rstrip()

    def test_prose_before_a_code_block_is_not_cut_mid_word(self):
        # Reviewer reproduction: two long paragraphs, then a short code block.
        # Any fence sends the whole reply down the fenced path, which used to
        # cut the second paragraph at the exact character count.
        text = self._paragraph(868) + '\n\n' + self._paragraph(1550) + '\n\n```\nprint("hi")\n```'
        chunks = chunk_message(text)

        assert len(chunks) == 2
        assert all(len(chunk) <= DISCORD_MESSAGE_CHAR_LIMIT for chunk in chunks)
        assert ' '.join(chunks).split() == text.split(), 'a word was cut in two'
        assert chunks[0].rstrip().endswith('.'), 'prefer a sentence end'
        assert ''.join(chunks) == text
        assert all(chunk.count('```') % 2 == 0 for chunk in chunks)

    def test_prose_with_no_sentence_end_breaks_at_whitespace(self):
        text = ('word ' * 600).rstrip() + '\n```\ncode\n```'
        chunks = chunk_message(text)

        assert all(len(chunk) <= DISCORD_MESSAGE_CHAR_LIMIT for chunk in chunks)
        assert ' '.join(chunks).split() == text.split()
        assert ''.join(chunks) == text

    def test_a_numbered_last_chunk_has_no_trailing_blank_lines(self):
        # Live F12: the answer's trailing newlines sat between the closing fence
        # and the label as blank lines.
        body = ''.join(f'line {index:04d} ' + 'x' * 12 + '\n' for index in range(150))
        numbered = chunk_message('```\n' + body + '```\n\n\n', number=True)
        total = len(numbered)
        assert total > 1
        assert numbered[-1].endswith(f'```\n\n*({total}/{total})*')


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
        # '.xyz' is a registered chemistry type in many system MIME tables, so
        # an extension no table knows stands in for "unknown".
        assert guess_media_type('file.qqzz') == 'application/octet-stream'
        assert guess_media_type('noext') == 'application/octet-stream'

    def test_common_discord_audio_and_video_route_on_every_host(self):
        # In the node's own table, so routing does not depend on the host's
        # MIME files (a bare CI image has none for these).
        assert guess_media_type('voice.m4a') == 'audio/mp4'
        assert guess_media_type('track.flac') == 'audio/flac'
        assert guess_media_type('call.opus') == 'audio/opus'
        assert guess_media_type('clip.mkv') == 'video/x-matroska'

    def test_types_python_knows_route_by_extension(self):
        assert guess_media_type('clip.aac').startswith('audio/')
        assert guess_media_type('note.opus').startswith('audio/')
        assert guess_media_type('movie.avi').startswith('video/')
        assert guess_media_type('scan.bmp').startswith('image/')

    def test_the_table_still_wins_over_the_fallback(self):
        # mimetypes says audio/x-wav; the node's own table answers first.
        assert guess_media_type('clip.wav') == 'audio/wav'
        assert guess_media_type('song.mp3') == 'audio/mpeg'

    def test_the_fallback_uses_python_built_in_table_only(self):
        # On Windows the registry says application/vnd.ms-excel for .csv and
        # video/vnd.dlna.mpeg-tts for .ts (TypeScript, as often as not).
        assert guess_media_type('data.csv') == 'text/csv'
        assert not guess_media_type('app.ts').startswith('video/')

    def test_the_host_mime_table_is_never_consulted(self):
        host = mock.Mock(return_value=('application/vnd.ms-excel', None))
        with mock.patch.object(mimetypes, 'guess_type', host), mock.patch.object(mimetypes, '_db', None):
            assert guess_media_type('data.csv') == 'text/csv'
            assert guess_media_type('app.ts') == 'application/octet-stream'
        host.assert_not_called()

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
        assert guess_media_type('mystery.qqzz', ' ; x=y') == 'application/octet-stream'
        assert guess_media_type('voice.opus', ' ; x=y').startswith('audio/')


class TestTextAttachmentHelpers:
    """The one decode helper and cap rule both attachment paths share."""

    def test_utf8_is_decoded_and_invalid_bytes_ignored(self):
        assert text_utils.decode_text_attachment(b'caf\xc3\xa9 \xff ok') == 'café  ok'

    def test_a_nul_byte_means_binary(self):
        assert text_utils.decode_text_attachment(b'ok\x00binary') is None

    def test_utf16_with_a_bom_is_text(self):
        # Windows Notepad "Unicode" and PowerShell 5.1 redirects write these.
        decode = text_utils.decode_text_attachment
        assert decode(codecs.BOM_UTF16_LE + 'héllo\r\nworld'.encode('utf-16-le')) == 'héllo\r\nworld'
        assert decode(codecs.BOM_UTF16_BE + 'héllo\r\nworld'.encode('utf-16-be')) == 'héllo\r\nworld'

    def test_a_utf8_bom_is_stripped(self):
        assert text_utils.decode_text_attachment(codecs.BOM_UTF8 + 'café'.encode('utf-8')) == 'café'

    def test_utf32_is_still_binary(self):
        # Its BOM starts with the UTF-16 LE one; read as UTF-16 it is full of NULs.
        assert text_utils.decode_text_attachment('hello'.encode('utf-32')) is None

    def test_the_cap(self):
        clip = text_utils.clip_attachment_text
        assert clip('abcdefgh', 3) == 'abc'
        assert clip('abcdefgh', 0) == 'abcdefgh'
        assert clip('abcdefgh', -1) == 'abcdefgh'
        assert clip('abc', 10) == 'abc'

    def test_the_folded_block_follows_the_same_cap(self):
        fold = text_utils.fold_text_attachment
        assert fold('a.txt', 'abcdefgh', 3) == 'Contents of attached file "a.txt":\n```\nabc\n… (truncated)\n```'
        assert fold('a.txt', 'abcdefgh', 0) == 'Contents of attached file "a.txt":\n```\nabcdefgh\n```'


class TestServicesJsonSchema:
    """Validate the shipped services.json contract."""

    @pytest.fixture(scope='class')
    def schema(self):
        return _load_services_json()

    def test_every_top_level_key_has_a_comment_block(self, schema):
        with open(_SERVICES_JSON, 'r', encoding='utf-8') as handle:
            lines = handle.read().split('\n')
        for key in schema:
            index = next(i for i, line in enumerate(lines) if line.startswith(f'\t"{key}":'))
            assert lines[index - 1] == '\t//', f'{key} has no // comment block above it'

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
            'discord.requireMentionChannelIds',
            'discord.allowedBotIds',
            'discord.allowedMentionRoleIds',
            'discord.allowedMentionUserIds',
            'discord.threadName',
            'discord.threadNameMaxLength',
            'discord.threadAutoArchiveMinutes',
            'discord.textAttachmentExtensions',
            'discord.textAttachmentMaxChars',
            'discord.mergeAttachments',
            'discord.emitReactions',
            'discord.emitNoReply',
            'discord.emitOutbound',
            'discord.includeMemberMetadata',
            'discord.numberChunks',
        ]
        for field in required:
            assert field in schema['fields'], f'missing field: {field}'

    def test_opt_in_fields_are_registered_and_off_by_default(self, schema):
        """The opt-in behaviors must be reachable in the UI and default to off."""
        properties = schema['fields']['Pipe.source.parameters']['properties']
        defaults = {
            'discord.numberChunks': False,
        }
        for field, default in defaults.items():
            assert field in properties, f'{field} not registered in Pipe.source.parameters'
            assert schema['fields'][field]['default'] == default, f'{field} default drift'

    def test_new_opt_in_fields_are_typed_and_optional(self, schema):
        """A field the UI cannot leave alone is not opt-in."""
        for field, kind in (('discord.numberChunks', 'boolean'),):
            declared = schema['fields'][field]
            assert declared['type'] == kind
            assert declared['optional'] is True
            assert declared['title'] and declared['description']

    def test_merge_attachments_is_registered_and_off_by_default(self, schema):
        """Attachment merging is opt-in; off keeps one object per attachment."""
        properties = schema['fields']['Pipe.source.parameters']['properties']
        assert 'discord.mergeAttachments' in properties
        assert schema['fields']['discord.mergeAttachments']['default'] is False

    def test_attachment_routing_defaults_keep_the_original_behaviour(self, schema):
        """No text decoding and the channel's own archive duration unless configured."""
        fields = schema['fields']
        assert fields['discord.textAttachmentExtensions']['default'] == []
        assert fields['discord.threadAutoArchiveMinutes']['default'] == 0

    def test_thread_name_length_is_bounded_by_what_discord_accepts(self, schema):
        """Discord rejects a thread name longer than 100 characters."""
        field = schema['fields']['discord.threadNameMaxLength']
        assert field['minimum'] == 1
        assert field['maximum'] == 100
        assert field['minimum'] <= field['default'] <= field['maximum']

    def test_thread_archive_minutes_offers_only_the_durations_discord_accepts(self, schema):
        """Any other duration is a 400 from Discord, so the UI offers only these."""
        field = schema['fields']['discord.threadAutoArchiveMinutes']
        values = [option[0] for option in field['enum']]
        assert values == [0, 60, 1440, 4320, 10080]
        assert all(isinstance(option[1], str) and option[1] for option in field['enum'])
        assert field['default'] in values

    def test_text_attachment_max_chars_cannot_be_negative(self, schema):
        """0 means no limit; a negative cap has no meaning."""
        assert schema['fields']['discord.textAttachmentMaxChars']['minimum'] == 0

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
