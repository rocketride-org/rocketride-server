# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""L1 live I/O tests (D01..D19) for the discord node.

Real Discord Gateway, real posts, real attachments; only the engine and the
pipeline are stubbed (see ``live_support``). Every message the harness posts is
prefixed ``[LIVE-TEST <id>]`` and deleted at session end.

Two identity shims exist because the test server has a single bot identity (see
``live_support.SynthUser`` / ``live_support.BotProxy``): the node's own-message
gate would otherwise drop everything the harness posts. Where a shim is used,
only the *identity* is synthetic — the message, channel, thread, mentions and
reply reference all come from Discord.
"""

import io
import time
from unittest import mock

import pytest

# The live suite drives real Discord; an offline run without discord.py must
# skip this directory instead of breaking collection for the unit tests.
pytest.importorskip('discord')

import discord  # noqa: E402

from .live_support import (
    BotProxy,
    StubTarget,
    SynthUser,
    live_only,
    make_endpoint,
    text_utils,
    with_author,
)

pytestmark = live_only

# Identities that do not exist on Discord; only the gate ever sees them.
SYNTH_HUMAN_ID = 900000000000000001
SYNTH_DRIVER_BOT_ID = 900000000000000002
SYNTH_SELF_ID = 900000000000000003

METADATA_KEYS = {
    'messageId',
    'channelId',
    'threadId',
    'parentChannelId',
    'guildId',
    'createdAt',
    'authorId',
    'authorIsBot',
    'authorDisplayName',
    'authorRoleIds',
    'mentionedUserIds',
    'mentionedRoleIds',
    'repliedToMessageId',
    'botUserId',
    'attachments',
    'correlationId',
    'groupIndex',
    'groupSize',
    'eventType',
}


def _process(live_bot, endpoint, message):
    """Drive ``_process_message`` to completion on the bot's loop."""
    live_bot.run(endpoint._process_message(message), timeout=180)


def _gate(live_bot, endpoint, message):
    """Drive ``_on_message`` (the gate) to completion on the bot's loop."""
    live_bot.run(endpoint._on_message(message, wait=True), timeout=180)


def _file(name: str, data: bytes) -> discord.File:
    return discord.File(io.BytesIO(data), filename=name)


# ---------------------------------------------------------------------------
# D01 — login, intents, permissions
# ---------------------------------------------------------------------------


def test_d01_login_intents_permissions(live_bot):
    """Bot logs in; node-built intents are right; per-channel permission table."""
    assert live_bot.bot.user is not None
    assert live_bot.bot.user.id == int(live_bot.ids['botUserId'])
    assert live_bot.guild is not None

    # The intents the *node* would request. _bot_runner is stubbed so _startup
    # builds the bot without opening a second Gateway session.
    async def _intents(**overrides):
        endpoint = make_endpoint(live_bot.bot, botToken='intent-probe-only', **overrides)
        endpoint._bot_runner = mock.AsyncMock()
        await endpoint._startup()
        intents = endpoint._bot.intents
        if endpoint._bot_task is not None:
            endpoint._bot_task.cancel()
        return intents

    base = live_bot.run(_intents())
    assert base.message_content is True
    assert base.guilds is True
    reactions = live_bot.run(_intents(emitReactions=True))
    assert reactions.reactions is True
    members = live_bot.run(_intents(includeMemberMetadata=True))
    assert members.members is True

    print('\nD01 permissions (send / read_history / create_public_threads / add_reactions):')
    channels = [
        ('primary', int(live_bot.ids['primaryChannelId'])),
        ('guest', int(live_bot.ids['guestChannelId'])),
    ]
    if live_bot.ids.get('noPermissionChannelId'):
        channels.append(('no-perms', int(live_bot.ids['noPermissionChannelId'])))
    table = {'no-perms': None}
    for label, channel_id in channels:
        channel = live_bot.bot.get_channel(channel_id)
        if channel is None:
            print(f'  {label:9} {channel_id} NOT VISIBLE')
            table[label] = None
            continue
        perms = channel.permissions_for(live_bot.guild.me)
        table[label] = perms
        print(
            f'  {label:9} #{channel.name} {channel_id} '
            f'send={perms.send_messages} hist={perms.read_message_history} '
            f'threads={perms.create_public_threads} react={perms.add_reactions} '
            f'manage_threads={perms.manage_threads} manage_messages={perms.manage_messages}'
        )

    for label in ('primary', 'guest'):
        perms = table[label]
        assert perms is not None, f'{label} channel not visible to the bot'
        assert perms.send_messages and perms.read_message_history
        assert perms.create_public_threads and perms.add_reactions
    assert table['no-perms'] is None or not table['no-perms'].send_messages, '#test should have no send permission'


# ---------------------------------------------------------------------------
# D02 — reply modes
# ---------------------------------------------------------------------------


def test_d02a_reply_mode_reply(live_bot):
    """replyMode=reply posts a native reply to the message with no author ping."""
    target = StubTarget(answer='D02a stub answer')
    endpoint = make_endpoint(live_bot.bot, target=target, replyMode='reply')
    message = live_bot.post(live_bot.primary, '[LIVE-TEST D02a] reply mode')

    _process(live_bot, endpoint, message)

    replies = live_bot.wait_for_bot_message(live_bot.primary, after_id=message.id)
    assert len(replies) == 1, 'expected exactly one reply'
    reply = replies[0]
    assert reply.content == 'D02a stub answer'
    assert reply.reference is not None and reply.reference.message_id == message.id
    assert reply.mentions == [], 'mention_author=False must not ping the author'


def test_d02b_reply_mode_channel(live_bot):
    """replyMode=channel posts a plain channel message with no reply reference."""
    target = StubTarget(answer='D02b stub answer')
    endpoint = make_endpoint(live_bot.bot, target=target, replyMode='channel')
    message = live_bot.post(live_bot.primary, '[LIVE-TEST D02b] channel mode')

    _process(live_bot, endpoint, message)

    replies = live_bot.wait_for_bot_message(live_bot.primary, after_id=message.id)
    assert len(replies) == 1
    assert replies[0].content == 'D02b stub answer'
    assert replies[0].reference is None


def test_d02c_reply_mode_thread(live_bot):
    """replyMode=thread creates a named, auto-archiving thread and answers in it."""
    target = StubTarget(answer='D02c stub answer')
    endpoint = make_endpoint(
        live_bot.bot,
        target=target,
        replyMode='thread',
        threadName='Q: {content}',
        threadNameMaxLength=20,
        threadAutoArchiveMinutes=60,
    )
    content = '[LIVE-TEST D02c]-thread-mode'
    message = live_bot.post(live_bot.primary, content)

    _process(live_bot, endpoint, message)

    thread = live_bot.track_thread(live_bot.bot.get_channel(message.id))
    assert isinstance(thread, discord.Thread), 'node did not create a thread on the message'
    assert thread.name == ('Q: ' + content)[:20]
    assert thread.auto_archive_duration == 60
    posted = live_bot.wait_for_bot_message(thread)
    assert [m.content for m in posted] == ['D02c stub answer']


# ---------------------------------------------------------------------------
# D03 — thread follow-up gating
# ---------------------------------------------------------------------------


def test_d03_thread_followup_parent_aware_gating(live_bot):
    """A thread follow-up matches via the parent channel; other parents do not."""
    allowed = [live_bot.ids['primaryChannelId']]

    parent = live_bot.post(live_bot.primary, '[LIVE-TEST D03] thread parent')
    thread = live_bot.create_thread(parent, 'LIVE-TEST D03 thread')
    follow_up = live_bot.post(thread, '[LIVE-TEST D03] follow-up inside thread')
    assert isinstance(follow_up.channel, discord.Thread)
    assert str(follow_up.channel.parent_id) == allowed[0]

    target = StubTarget(answer='D03 stub answer')
    endpoint = make_endpoint(live_bot.bot, target=target, channelIds=allowed)
    _gate(live_bot, endpoint, with_author(follow_up, SynthUser(SYNTH_HUMAN_ID)))

    assert len(target.pipes) == 1, 'thread follow-up was not processed'
    assert target.pipes[0].meta['threadId'] == str(thread.id)
    assert target.pipes[0].meta['parentChannelId'] == allowed[0]
    posted = live_bot.wait_for_bot_message(thread, after_id=follow_up.id)
    assert [m.content for m in posted] == ['D03 stub answer']

    # Same shape in a thread whose parent is NOT allowlisted: dropped.
    guest_parent = live_bot.post(live_bot.guest, '[LIVE-TEST D03] guest thread parent')
    guest_thread = live_bot.create_thread(guest_parent, 'LIVE-TEST D03 guest thread')
    guest_follow = live_bot.post(guest_thread, '[LIVE-TEST D03] guest follow-up')

    blocked = StubTarget(answer='D03 must not be used')
    endpoint2 = make_endpoint(live_bot.bot, target=blocked, channelIds=allowed)
    _gate(live_bot, endpoint2, with_author(guest_follow, SynthUser(SYNTH_HUMAN_ID)))
    assert blocked.pipes == [], 'thread under a non-allowlisted parent must be dropped'


# ---------------------------------------------------------------------------
# D04 — per-channel mention gating
# ---------------------------------------------------------------------------


def test_d04_per_channel_mention_gating(live_bot):
    """The mention gate applies only in the listed channel; mentions are real."""
    primary_id = live_bot.ids['primaryChannelId']
    guest_id = live_bot.ids['guestChannelId']
    mention_allowed = discord.AllowedMentions(everyone=False, roles=False, users=[live_bot.bot.user])

    cases = []
    for label, channel, mention in (
        ('primary-plain', live_bot.primary, False),
        ('primary-mention', live_bot.primary, True),
        ('guest-plain', live_bot.guest, False),
        ('guest-mention', live_bot.guest, True),
    ):
        body = f'<@{live_bot.bot_user_id}> ping' if mention else 'plain'
        message = live_bot.post(
            channel,
            f'[LIVE-TEST D04] {label} {body}',
            allowed_mentions=mention_allowed if mention else None,
        )
        if mention:
            assert live_bot.bot.user in message.mentions, 'Discord did not resolve the bot mention'
        target = StubTarget(answer='')
        endpoint = make_endpoint(
            live_bot.bot,
            target=target,
            channelIds=[primary_id, guest_id],
            requireMentionChannelIds=[guest_id],
            sendResponses=False,
        )
        _gate(live_bot, endpoint, with_author(message, SynthUser(SYNTH_HUMAN_ID)))
        cases.append((label, bool(target.pipes)))

    assert cases == [
        ('primary-plain', True),
        ('primary-mention', True),
        ('guest-plain', False),
        ('guest-mention', True),
    ]


# ---------------------------------------------------------------------------
# D05 — bot allowlist
# ---------------------------------------------------------------------------


def test_d05_bot_allowlist_and_own_message_drop(live_bot):
    """The bot allowlist lets a bot author through; own messages never pass."""
    message = live_bot.post(live_bot.primary, '[LIVE-TEST D05] driver-bot message')

    allowed = StubTarget(answer='')
    endpoint = make_endpoint(
        live_bot.bot, target=allowed, ignoreBots=True, allowedBotIds=[str(SYNTH_DRIVER_BOT_ID)], sendResponses=False
    )
    _gate(live_bot, endpoint, with_author(message, SynthUser(SYNTH_DRIVER_BOT_ID, is_bot=True)))
    assert len(allowed.pipes) == 1, 'allowlisted bot author was dropped'

    blocked = StubTarget(answer='')
    endpoint = make_endpoint(live_bot.bot, target=blocked, ignoreBots=True, allowedBotIds=[], sendResponses=False)
    _gate(live_bot, endpoint, with_author(message, SynthUser(SYNTH_DRIVER_BOT_ID, is_bot=True)))
    assert blocked.pipes == [], 'bot author must be dropped without an allowlist'

    # The real message, really authored by the bot under test: always dropped,
    # even with its own id explicitly allowlisted.
    own = live_bot.fetch(live_bot.primary, message.id)
    own_target = StubTarget(answer='')
    endpoint = make_endpoint(
        live_bot.bot,
        target=own_target,
        ignoreBots=True,
        allowedBotIds=[str(live_bot.bot_user_id)],
        sendResponses=False,
    )
    _gate(live_bot, endpoint, own)
    assert own_target.pipes == [], 'own message must never be processed'


# ---------------------------------------------------------------------------
# D06 — outbound mention control
# ---------------------------------------------------------------------------


def _mention_answer(live_bot, role_id):
    user_id = live_bot.human_user_id()
    return f'D06 escalation: @everyone <@&{role_id}> <@{user_id}> please look'


def test_d06a_mention_suppression_default(live_bot):
    """By default the node's answer cannot ping anyone."""
    role = live_bot.team_role()
    role_id = role.id if role is not None else live_bot.guild.roles[-1].id
    target = StubTarget(answer=_mention_answer(live_bot, role_id))
    endpoint = make_endpoint(live_bot.bot, target=target)
    message = live_bot.post(live_bot.primary, '[LIVE-TEST D06a] suppression default')

    _process(live_bot, endpoint, message)

    replies = live_bot.wait_for_bot_message(live_bot.primary, after_id=message.id)
    assert len(replies) == 1
    reply = replies[0]
    assert reply.mentions == [], f'reply pinged users: {reply.mentions}'
    assert reply.role_mentions == [], f'reply pinged roles: {reply.role_mentions}'
    assert reply.mention_everyone is False


def test_d06b_allowed_role_ping(live_bot):
    """The role allowlist is the only way a role ping gets through."""
    role = live_bot.team_role()
    if role is None:
        pytest.skip(
            'no non-managed, non-default role in the guild (teamRoleId not provided); '
            'bot-managed roles are unmentionable by anyone'
        )
    target = StubTarget(answer=_mention_answer(live_bot, role.id))
    endpoint = make_endpoint(live_bot.bot, target=target, allowedMentionRoleIds=[str(role.id)])
    message = live_bot.post(live_bot.primary, '[LIVE-TEST D06b] allowed role ping')

    _process(live_bot, endpoint, message)

    replies = live_bot.wait_for_bot_message(live_bot.primary, after_id=message.id)
    assert len(replies) == 1
    assert [r.id for r in replies[0].role_mentions] == [role.id]
    assert replies[0].mention_everyone is False


def test_d06c_allowed_user_ping(live_bot):
    """The user allowlist lets exactly the listed user be pinged."""
    user_id = live_bot.human_user_id()
    role = live_bot.team_role()
    role_id = role.id if role is not None else live_bot.guild.roles[-1].id
    target = StubTarget(answer=_mention_answer(live_bot, role_id))
    endpoint = make_endpoint(live_bot.bot, target=target, allowedMentionUserIds=[str(user_id)])
    message = live_bot.post(live_bot.primary, '[LIVE-TEST D06c] allowed user ping')

    _process(live_bot, endpoint, message)

    replies = live_bot.wait_for_bot_message(live_bot.primary, after_id=message.id)
    assert len(replies) == 1
    assert [u.id for u in replies[0].mentions] == [user_id]
    assert replies[0].role_mentions == []
    assert replies[0].mention_everyone is False


# ---------------------------------------------------------------------------
# D07 — attachments
# ---------------------------------------------------------------------------

D07A_PIPE_BODY = b'{"components": {"a": 1}, "padding": "' + b'p' * 120 + b'"}'
D07A_MD_BODY = b'# notes\n' + b'markdown body line\n' * 8


def test_d07a_text_like_attachments(live_bot):
    """.pipe/.md attachments are framed onto the text lane and truncated."""
    target = StubTarget(answer='')
    endpoint = make_endpoint(live_bot.bot, target=target, textAttachmentMaxChars=50, sendResponses=False)
    message = live_bot.post(
        live_bot.primary,
        '[LIVE-TEST D07a] text-like attachments',
        files=[_file('x.pipe', D07A_PIPE_BODY), _file('notes.md', D07A_MD_BODY)],
    )

    _process(live_bot, endpoint, message)

    framed = [pipe for pipe in target.text_pipes if pipe.texts[0].startswith('[attachment ')]
    assert len(framed) == 2, f'expected two framed attachment texts, got {[p.name for p in target.pipes]}'
    assert target.tag_pipes == [], 'text-like attachments must not use the tag lane'
    bodies = {}
    for pipe in framed:
        header, _, body = pipe.texts[0].partition('\n')
        bodies[header] = body
        assert len(body) <= 50, f'{header} not truncated to textAttachmentMaxChars: {len(body)}'
    assert set(bodies) == {'[attachment x.pipe]', '[attachment notes.md]'}
    assert bodies['[attachment x.pipe]'] == D07A_PIPE_BODY.decode()[:50]
    assert bodies['[attachment notes.md]'] == D07A_MD_BODY.decode()[:50]


def test_d07b_binary_attachment_routing(live_bot):
    """PNG goes to the image lane; PDF goes to the tag lane with its MIME type."""
    png = b'\x89PNG\r\n\x1a\n' + b'0' * 64
    pdf = b'%PDF-1.4\n' + b'1' * 64
    target = StubTarget(answer='')
    endpoint = make_endpoint(live_bot.bot, target=target, sendResponses=False)
    message = live_bot.post(
        live_bot.primary,
        '[LIVE-TEST D07b] binary attachments',
        files=[_file('a.png', png), _file('doc.pdf', pdf)],
    )

    _process(live_bot, endpoint, message)

    image_pipes = [pipe for pipe in target.pipes if pipe.images]
    assert len(image_pipes) == 1
    assert [action for action, _, _ in image_pipes[0].images] == ['BEGIN', 'WRITE', 'END']
    assert {mime for _, mime, _ in image_pipes[0].images} == {'image/png'}
    assert image_pipes[0].images[1][2] == len(png)
    assert image_pipes[0].entry.obj['mimeType'] == 'image/png'

    tag_pipes = target.tag_pipes
    assert len(tag_pipes) == 1
    assert tag_pipes[0].tag_calls == ['beginObject', 'beginStream', 'data', 'endStream', 'endObject']
    assert tag_pipes[0].tag_data == pdf
    assert tag_pipes[0].entry.obj['mimeType'] == 'application/pdf'


def test_d07c_oversized_attachment_skipped(live_bot):
    """An attachment over maxAttachmentBytes is never opened and not counted."""
    target = StubTarget(answer='')
    endpoint = make_endpoint(live_bot.bot, target=target, maxAttachmentBytes=100, sendResponses=False)
    message = live_bot.post(
        live_bot.primary,
        '[LIVE-TEST D07c] oversized attachment',
        files=[_file('big.bin', b'z' * 1024)],
    )

    _process(live_bot, endpoint, message)

    assert len(target.pipes) == 1, 'oversized attachment opened a pipe'
    assert target.pipes[0].texts, 'the text lane object is the only one expected'
    assert target.pipes[0].meta['groupSize'] == 1, 'skipped attachment must not count towards groupSize'


# ---------------------------------------------------------------------------
# D08 — object identity + metadata
# ---------------------------------------------------------------------------


def test_d08_object_identity_and_metadata(live_bot):
    """One message with two attachments yields three correlated objects."""
    png = b'\x89PNG\r\n\x1a\n' + b'0' * 32
    pdf = b'%PDF-1.4\n' + b'1' * 32
    target = StubTarget(answer='')
    endpoint = make_endpoint(live_bot.bot, target=target, sendResponses=False)
    message = live_bot.post(
        live_bot.primary,
        '[LIVE-TEST D08] identity and metadata',
        files=[_file('a.png', png), _file('doc.pdf', pdf)],
    )
    attachments = live_bot.fetch(live_bot.primary, message.id).attachments

    _process(live_bot, endpoint, message)

    assert len(target.pipes) == 3
    assert target.names == [str(message.id), f'{message.id}:0', f'{message.id}:1']
    channel_id = message.channel.id
    assert target.pipes[0].url == f'discord://{channel_id}/{message.id}'
    assert [pipe.url for pipe in target.pipes[1:]] == [
        f'discord://{channel_id}/{message.id}/{attachments[0].id}',
        f'discord://{channel_id}/{message.id}/{attachments[1].id}',
    ]
    assert [pipe.meta['groupIndex'] for pipe in target.pipes] == [0, 1, 2]
    assert {pipe.meta['groupSize'] for pipe in target.pipes} == {3}
    assert {pipe.meta['correlationId'] for pipe in target.pipes} == {str(message.id)}
    assert {pipe.meta['eventType'] for pipe in target.pipes} == {'message'}

    meta = target.pipes[0].meta
    assert set(meta) == METADATA_KEYS, f'metadata key drift: {set(meta) ^ METADATA_KEYS}'
    assert meta['messageId'] == str(message.id)
    assert meta['channelId'] == str(channel_id)
    assert meta['guildId'] == live_bot.ids['guildId']
    assert meta['threadId'] is None and meta['parentChannelId'] is None
    assert meta['authorId'] == str(live_bot.bot_user_id)
    assert meta['authorIsBot'] is True
    assert meta['botUserId'] == str(live_bot.bot_user_id)
    assert meta['createdAt'] is not None
    assert [entry['name'] for entry in meta['attachments']] == ['a.png', 'doc.pdf']
    assert [entry['contentType'] for entry in meta['attachments']] == ['image/png', 'application/pdf']


def test_d08b_member_metadata(live_bot):
    """Member metadata fills display name and role ids from a real member."""
    if not live_bot.members_intent:
        pytest.skip(
            'privileged members intent disabled in the Developer Portal '
            '(discord.PrivilegedIntentsRequired on connect); includeMemberMetadata cannot run live'
        )
    member = live_bot.run(live_bot.guild.fetch_member(live_bot.human_user_id()))
    role = live_bot.team_role()
    role_id = role.id if role is not None else live_bot.guild.roles[-1].id
    target = StubTarget(answer='')
    endpoint = make_endpoint(live_bot.bot, target=target, includeMemberMetadata=True, sendResponses=False)
    message = live_bot.post(live_bot.primary, f'[LIVE-TEST D08b] member metadata <@&{role_id}>')

    _process(live_bot, endpoint, with_author(message, member))

    meta = target.pipes[0].meta
    assert meta['authorDisplayName'] == member.display_name
    assert meta['authorRoleIds'] == [str(r.id) for r in member.roles]
    assert meta['mentionedRoleIds'] == [str(r.id) for r in message.role_mentions]


# ---------------------------------------------------------------------------
# D09 — code-fence chunking
# ---------------------------------------------------------------------------


def _fenced_answer(total: int = 4500) -> str:
    head = 'D09 prose before the fence, line of context.\n' * 3
    tail = '\nD09 trailing prose after the fence.\n'
    body = 'print("padding padding padding padding padding")\n'
    fixed = len(head) + len('```python\n') + len('```') + len(tail)
    answer = head + '```python\n' + body * ((total - fixed) // len(body)) + '```' + tail
    return answer + 'x' * max(0, total - len(answer))


def _unfence(chunks):
    """Undo the reopen/close fences the chunker adds at message boundaries."""
    parts = []
    for index, chunk in enumerate(chunks):
        if index > 0 and chunk.startswith('```') and chunks[index - 1].endswith('\n```'):
            chunk = chunk.split('\n', 1)[1]
        if index + 1 < len(chunks) and chunk.endswith('\n```') and chunks[index + 1].startswith('```'):
            chunk = chunk[:-4]
        parts.append(chunk)
    return ''.join(parts)


def test_d09_code_fence_chunking(live_bot):
    """A 4500-char answer with a fence across the 2000 boundary posts intact."""
    answer = _fenced_answer()
    expected = text_utils.chunk_message(answer)
    assert len(expected) == 3, f'test input no longer produces 3 chunks: {[len(c) for c in expected]}'

    target = StubTarget(answer=answer)
    endpoint = make_endpoint(live_bot.bot, target=target, replyMode='channel')
    message = live_bot.post(live_bot.primary, '[LIVE-TEST D09] fenced chunking')

    _process(live_bot, endpoint, message)

    posted = live_bot.wait_for_bot_message(live_bot.primary, after_id=message.id, expected=3, timeout=40)
    assert len(posted) == 3, f'expected 3 posted chunks, got {len(posted)}'
    contents = [m.content for m in posted]
    for chunk in contents:
        assert len(chunk) <= 2000
        assert chunk.count('```') % 2 == 0, 'unbalanced code fence in a posted chunk'
    assert contents == expected, 'Discord-visible chunks differ from chunk_message output'
    assert _unfence(contents) == answer


# ---------------------------------------------------------------------------
# D10 — event emission
# ---------------------------------------------------------------------------


def test_d10a_emit_reactions(live_bot):
    """Raw reaction add/remove become one tagged event each."""
    target = StubTarget(answer='')
    endpoint = make_endpoint(live_bot.bot, target=target, emitReactions=True, sendResponses=False)
    message = live_bot.post(live_bot.primary, '[LIVE-TEST D10a] reaction target')
    emoji = '\N{WHITE HEAVY CHECK MARK}'

    live_bot.drain_reactions()
    live_bot.run(message.add_reaction(emoji))
    added = live_bot.wait_for_raw_reaction('add', message.id)
    live_bot.run(endpoint._on_raw_reaction(added, True))
    time.sleep(1.0)
    live_bot.run(message.remove_reaction(emoji, live_bot.bot.user))
    removed = live_bot.wait_for_raw_reaction('remove', message.id)
    live_bot.run(endpoint._on_raw_reaction(removed, False))

    assert len(target.pipes) == 2
    assert target.names == [f'{message.id}:reaction', f'{message.id}:reaction']
    for pipe, expected_added in zip(target.pipes, (True, False)):
        assert pipe.tag_calls == ['beginObject', 'beginStream', 'data', 'endStream', 'endObject']
        event = pipe.tag_json
        assert event['eventType'] == 'reaction'
        assert event['added'] is expected_added
        assert event['emoji'] == emoji
        assert event['userId'] == str(live_bot.bot_user_id)
        assert pipe.meta['eventType'] == 'reaction'
        assert pipe.meta['correlationId'] == str(message.id)
        assert pipe.meta['messageId'] == str(message.id)


def test_d10b_emit_no_reply(live_bot):
    """An empty answer and a failing pipeline each emit one no_reply event."""
    empty = StubTarget(answer='')
    endpoint = make_endpoint(live_bot.bot, target=empty, emitNoReply=True)
    message = live_bot.post(live_bot.primary, '[LIVE-TEST D10b] no reply')

    _process(live_bot, endpoint, message)

    events = [pipe for pipe in empty.pipes if pipe.name.endswith(':no_reply')]
    assert len(events) == 1
    assert events[0].name == f'{message.id}:no_reply'
    assert events[0].tag_json['reason'] == 'no_answer'
    assert events[0].meta['eventType'] == 'no_reply'
    live_bot.assert_no_bot_message(live_bot.primary, message.id)

    boom = StubTarget(answer='unused', raises=RuntimeError('D10b pipeline exploded'), raise_on={'writeText'})
    endpoint = make_endpoint(live_bot.bot, target=boom, emitNoReply=True)
    message2 = live_bot.post(live_bot.primary, '[LIVE-TEST D10b] pipeline error')

    _process(live_bot, endpoint, message2)

    events = [pipe for pipe in boom.pipes if pipe.name.endswith(':no_reply')]
    assert len(events) == 1
    assert events[0].tag_json['reason'] == 'D10b pipeline exploded'
    live_bot.assert_no_bot_message(live_bot.primary, message2.id)


def test_d10c_emit_outbound(live_bot):
    """The outbound event reports the real posted message ids and destination."""
    target = StubTarget(answer='D10c stub answer')
    endpoint = make_endpoint(live_bot.bot, target=target, emitOutbound=True, replyMode='reply')
    message = live_bot.post(live_bot.primary, '[LIVE-TEST D10c] outbound event')

    _process(live_bot, endpoint, message)

    replies = live_bot.wait_for_bot_message(live_bot.primary, after_id=message.id)
    assert len(replies) == 1
    events = [pipe for pipe in target.pipes if pipe.name.endswith(':outbound')]
    assert len(events) == 1
    assert events[0].name == f'{message.id}:outbound'
    event = events[0].tag_json
    assert event['eventType'] == 'outbound'
    assert event['messageIds'] == [str(replies[0].id)]
    assert event['destination'] == 'reply'
    assert event['text'] == 'D10c stub answer'


# ---------------------------------------------------------------------------
# D11 — backfill
# ---------------------------------------------------------------------------


def test_d11_backfill(live_bot):
    """Backfill processes the newest N messages oldest-first and stays quiet."""
    seeds = [live_bot.post(live_bot.primary, f'[LIVE-TEST D11] backfill seed {index}') for index in range(5)]

    target = StubTarget(answer='D11 must not be posted')
    endpoint = make_endpoint(
        BotProxy(live_bot.bot, SYNTH_SELF_ID),
        target=target,
        backfillLimit=3,
        sendResponses=False,
        channelIds=[live_bot.ids['primaryChannelId']],
        ignoreBots=False,
    )

    live_bot.run(endpoint._run_backfill(), timeout=180)

    assert target.names == [str(message.id) for message in seeds[2:]], 'expected the newest 3, oldest first'
    live_bot.assert_no_bot_message(live_bot.primary, seeds[-1].id)


# ---------------------------------------------------------------------------
# D12 — silence on empty answer
# ---------------------------------------------------------------------------


def test_d12_silence_on_empty_answer(live_bot):
    """An empty answer posts nothing and, with emitNoReply off, emits nothing."""
    target = StubTarget(answer='')
    endpoint = make_endpoint(live_bot.bot, target=target)
    message = live_bot.post(live_bot.primary, '[LIVE-TEST D12] empty answer')

    _process(live_bot, endpoint, message)

    assert len(target.pipes) == 1, 'no event object should be emitted with emitNoReply=false'
    assert target.pipes[0].texts == ['[LIVE-TEST D12] empty answer']
    live_bot.assert_no_bot_message(live_bot.primary, message.id)


# ---------------------------------------------------------------------------
# D13 — "aimed at someone else" metadata
# ---------------------------------------------------------------------------


def test_d13_mention_and_reply_metadata(live_bot):
    """Metadata exposes who was mentioned, what was replied to, and our own id."""
    user_id = live_bot.human_user_id()
    first = live_bot.post(
        live_bot.primary,
        f'[LIVE-TEST D13] question for <@{user_id}>',
        allowed_mentions=discord.AllowedMentions(everyone=False, roles=False, users=[discord.Object(id=user_id)]),
    )
    first = live_bot.fetch(live_bot.primary, first.id)
    second = live_bot.run(first.reply('[LIVE-TEST D13] reply to the previous message', mention_author=False))
    live_bot.register(second)
    time.sleep(1.5)

    target = StubTarget(answer='')
    endpoint = make_endpoint(live_bot.bot, target=target, sendResponses=False)
    _process(live_bot, endpoint, first)
    meta_first = target.pipes[0].meta
    target.reset()
    _process(live_bot, endpoint, second)
    meta_second = target.pipes[0].meta

    assert meta_first['mentionedUserIds'] == [str(user_id)]
    assert meta_first['repliedToMessageId'] is None
    assert meta_second['repliedToMessageId'] == str(first.id)
    assert meta_second['botUserId'] == str(live_bot.bot_user_id)


# ---------------------------------------------------------------------------
# D14 — typing indicator
# ---------------------------------------------------------------------------


def test_d14_typing_indicator(live_bot):
    """The typing indicator is entered and exited around a slow answer."""
    entered = []
    exited = []
    original = discord.TextChannel.typing

    class _TypingSpy:
        def __init__(self, inner):
            self._inner = inner

        async def __aenter__(self):
            entered.append(1)
            return await self._inner.__aenter__()

        async def __aexit__(self, *args):
            exited.append(1)
            return await self._inner.__aexit__(*args)

    def _spy(channel):
        return _TypingSpy(original(channel))

    def _slow_answer(_entry):
        time.sleep(2.0)
        return 'D14 stub answer'

    target = StubTarget(answer=_slow_answer)
    endpoint = make_endpoint(live_bot.bot, target=target, showTyping=True)
    message = live_bot.post(live_bot.primary, '[LIVE-TEST D14] typing indicator')

    with mock.patch.object(discord.TextChannel, 'typing', _spy):
        _process(live_bot, endpoint, message)

    assert entered == [1], 'typing context was not entered'
    assert exited == [1], 'typing context was not exited'
    replies = live_bot.wait_for_bot_message(live_bot.primary, after_id=message.id)
    assert [m.content for m in replies] == ['D14 stub answer']


# ---------------------------------------------------------------------------
# D15 — fatal startup paths
# ---------------------------------------------------------------------------


def test_d15_fatal_startup_paths(live_bot):
    """Missing token, invalid token, and a missing privileged intent all fail fast."""
    missing = make_endpoint(live_bot.bot, botToken='')
    with pytest.raises(RuntimeError, match='missing bot token'):
        live_bot.run(missing._startup())
    print('\nD15 missing token: RuntimeError raised by _startup')

    invalid = make_endpoint(live_bot.bot, botToken='live-harness-deliberately-invalid-token')
    live_bot.run(invalid._startup())
    assert invalid._shutdown_event.wait(timeout=60), '_bot_runner never reported a terminal failure'
    assert invalid._fatal_error == 'Discord Bot: login failed (invalid token)'
    live_bot.run(invalid._shutdown(), timeout=60)
    print(f'D15 invalid token: {invalid._fatal_error}')

    if live_bot.members_intent:
        print('D15 privileged intent: SKIPPED sub-case (members intent is enabled for this bot)')
        return
    from .live_support import load_token

    intent = make_endpoint(live_bot.bot, botToken=load_token(), includeMemberMetadata=True)
    live_bot.run(intent._startup())
    assert intent._shutdown_event.wait(timeout=60), 'missing privileged intent did not fail the source'
    assert intent._fatal_error is not None
    live_bot.run(intent._shutdown(), timeout=60)
    print(f'D15 privileged intent: {intent._fatal_error}')
    assert 'Intent' in intent._fatal_error


# ---------------------------------------------------------------------------
# D16..D19 — support-bot parity behaviors (thread context, pause, ack, feedback)
# ---------------------------------------------------------------------------


def _d16_thread(live_bot, message):
    """The thread the node created on ``message`` (its id is the message id)."""
    thread = live_bot.track_thread(live_bot.bot.get_channel(message.id))
    assert isinstance(thread, discord.Thread), 'node did not create a thread on the message'
    return thread


def test_d16_thread_history_context(live_bot):
    """Thread history is handed to the pipeline as context when enabled."""
    target = StubTarget(answer='D16 stub answer')
    endpoint = make_endpoint(
        live_bot.bot,
        target=target,
        replyMode='thread',
        threadName='D16 {content}',
        threadNameMaxLength=40,
        threadHistoryLimit=25,
    )

    opening = live_bot.post(live_bot.primary, '[LIVE-TEST D16] how do I start a pipeline?')
    _process(live_bot, endpoint, opening)
    thread = _d16_thread(live_bot, opening)
    assert [m.content for m in live_bot.wait_for_bot_message(thread)] == ['D16 stub answer']
    # The opening message is not in a thread: no context, and the pipeline text
    # is exactly what the user wrote.
    assert target.text_pipes[0].texts[0] == '[LIVE-TEST D16] how do I start a pipeline?'

    target.reset()
    follow_up = live_bot.post(thread, '[LIVE-TEST D16] and how do I stop it?')

    _process(live_bot, endpoint, follow_up)

    text = target.text_pipes[0].texts[0]
    assert text.startswith("User's latest message: [LIVE-TEST D16] and how do I stop it?"), text[:120]
    assert 'Earlier in this thread (oldest first, for context):' in text
    assert f'{live_bot.bot.user.display_name}: D16 stub answer' in text, text
    assert '[LIVE-TEST D16] and how do I stop it?' not in text.split('for context):\n', 1)[1], (
        'the current message must be excluded from its own context'
    )
    # The metadata contract is unchanged and the answer still lands in the thread.
    assert target.text_pipes[0].meta['threadId'] == str(thread.id)
    assert [m.content for m in live_bot.wait_for_bot_message(thread, after_id=follow_up.id)] == ['D16 stub answer']


def test_d17_escalation_pause(live_bot):
    """An escalated thread goes quiet until the bot is @mentioned again."""
    marker = '<@&900000000000000017>'  # a role that does not exist: it can never ping
    answer = {'text': f'D17 escalating this one {marker}'}
    target = StubTarget(answer=lambda _entry: answer['text'])
    endpoint = make_endpoint(
        live_bot.bot,
        target=target,
        replyMode='thread',
        threadName='D17 {content}',
        threadNameMaxLength=40,
        escalationPause=True,
        escalationMarkers=[marker],
        emitNoReply=True,
    )

    opening = live_bot.post(live_bot.primary, '[LIVE-TEST D17] please escalate this')
    _process(live_bot, endpoint, opening)
    thread = _d16_thread(live_bot, opening)
    posted = live_bot.wait_for_bot_message(thread)
    assert len(posted) == 1 and marker in posted[0].content
    assert posted[0].role_mentions == [], 'the marker must not ping (no allowlisted role)'
    assert str(thread.id) in endpoint._paused_threads, 'the escalated thread was not paused'

    # A follow-up without a mention: nothing posted, one no_reply(paused).
    target.reset()
    answer['text'] = 'D17 must not be posted'
    quiet = live_bot.post(thread, '[LIVE-TEST D17] any update?')

    _process(live_bot, endpoint, quiet)

    assert target.text_pipes == [], 'a paused thread must not be ingested'
    events = [pipe for pipe in target.pipes if pipe.name.endswith(':no_reply')]
    assert len(events) == 1 and events[0].tag_json['reason'] == 'paused'
    live_bot.assert_no_bot_message(thread, quiet.id)

    # A follow-up that mentions the bot re-engages it.
    target.reset()
    answer['text'] = 'D17 resumed answer'
    mention_allowed = discord.AllowedMentions(everyone=False, roles=False, users=[live_bot.bot.user])
    mentioned = live_bot.post(
        thread,
        f'[LIVE-TEST D17] <@{live_bot.bot_user_id}> still stuck',
        allowed_mentions=mention_allowed,
    )
    assert live_bot.bot.user in mentioned.mentions, 'Discord did not resolve the bot mention'

    _process(live_bot, endpoint, mentioned)

    assert [m.content for m in live_bot.wait_for_bot_message(thread, after_id=mentioned.id)] == ['D17 resumed answer']
    assert str(thread.id) not in endpoint._paused_threads


def test_d18_aimed_at_someone_else(live_bot):
    """A message aimed at another member is acknowledged with a reaction only."""
    try:
        user_id = live_bot.human_user_id()
    except Exception as error:  # owner not cached / not fetchable
        pytest.skip(f'no human user id available for the mention ({type(error).__name__})')
    if not user_id or user_id == live_bot.bot_user_id:
        pytest.skip('no human user id available (humanUserId empty and the guild owner is this bot)')

    ack = '\N{EYES}'
    target = StubTarget(answer='D18 must not be posted')
    endpoint = make_endpoint(
        live_bot.bot,
        target=target,
        ignoreAimedAtOthers=True,
        ackEmoji=ack,
        emitNoReply=True,
    )
    message = live_bot.post(
        live_bot.primary,
        f'[LIVE-TEST D18] <@{user_id}> could you take a look?',
        allowed_mentions=discord.AllowedMentions(everyone=False, roles=False, users=[discord.Object(id=user_id)]),
    )
    message = live_bot.fetch(live_bot.primary, message.id)
    assert [u.id for u in message.mentions] == [user_id], 'Discord did not resolve the member mention'

    _process(live_bot, endpoint, message)

    assert live_bot.reactions_on(live_bot.primary, message.id) == [ack], 'acknowledgement reaction missing'
    assert target.text_pipes == [], 'a message aimed elsewhere must not be ingested'
    events = [pipe for pipe in target.pipes if pipe.name.endswith(':no_reply')]
    assert len(events) == 1 and events[0].tag_json['reason'] == 'aimed_elsewhere'
    live_bot.assert_no_bot_message(live_bot.primary, message.id)


def test_d19_feedback_reactions(live_bot):
    """Feedback emojis land on the last posted chunk, in order, and are reported."""
    emojis = ['\N{WHITE HEAVY CHECK MARK}', '\N{CROSS MARK}']
    answer = '\n'.join(f'D19 answer line {index} with padding padding padding' for index in range(55))
    expected = text_utils.chunk_message(answer)
    assert len(expected) == 2, f'test input no longer produces 2 chunks: {[len(c) for c in expected]}'

    target = StubTarget(answer=answer)
    endpoint = make_endpoint(
        live_bot.bot,
        target=target,
        replyMode='channel',
        feedbackReactions=True,
        feedbackEmojis=emojis,
        emitOutbound=True,
    )
    message = live_bot.post(live_bot.primary, '[LIVE-TEST D19] feedback reactions')

    _process(live_bot, endpoint, message)

    posted = live_bot.wait_for_bot_message(live_bot.primary, after_id=message.id, expected=2, timeout=40)
    assert len(posted) == 2, f'expected 2 posted chunks, got {len(posted)}'
    assert live_bot.reactions_on(live_bot.primary, posted[-1].id, expected=2) == emojis
    assert live_bot.reactions_on(live_bot.primary, posted[0].id, expected=0, timeout=0) == [], (
        'only the last chunk carries the affordances'
    )

    events = [pipe for pipe in target.pipes if pipe.name.endswith(':outbound')]
    assert len(events) == 1
    event = events[0].tag_json
    assert event['messageIds'] == [str(m.id) for m in posted]
    assert event['feedbackEmojis'] == emojis
