# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Offline tests for the tool_masky tool surface (29 tools).

No engine, no network: the driver gets a ``FakeClient`` that records every call
and returns canned Masky response bodies. ``rocketlib`` / ``ai.common.tools``
are stubbed only long enough to import the node (same pattern as
test_tool_masky.py, whose minimal loader is duplicated here).
"""

from __future__ import annotations

import json
import sys
import threading
import time
import types

import pytest

from ._stubs import scoped_stubs

with scoped_stubs():
    from tool_masky import masky_core as core  # noqa: E402
    from tool_masky import masky_driver as driver_mod  # noqa: E402
    from tool_masky.masky_client import MaskyClient  # noqa: E402
    from tool_masky.masky_core import MaskyCancelled, MaskyError  # noqa: E402
    from tool_masky.masky_driver import DELETE_TOOLS, READ_ONLY_REFUSAL, READ_TOOLS, MaskyDriver  # noqa: E402


# ---------------------------------------------------------------------------
# Canned Masky bodies
# ---------------------------------------------------------------------------

AUDIO_URL = 'https://storage.googleapis.com/b/a.mp3?Expires=1792193106&GoogleAccessId=x&Signature=y'
VIDEO_URL = 'https://storage.googleapis.com/b/v.mp4?Expires=1792193106&GoogleAccessId=x&Signature=y'
IMAGE_URL = 'https://firebasestorage.googleapis.com/x.png?alt=media&token=t'
LOOK_FB = 'https://firebasestorage.googleapis.com/o/l1.jpeg?alt=media&token=t'
LOOK_LH = 'https://lh3.googleusercontent.com/a/p=s96-c'

SPEAK_POST = (202, {'reused': False, 'async': True, 'generationId': 'G1', 'userId': 'U', 'firestorePath': 'users/U/x'})


def gen(status='audio', output='audio', **over):
    g = {
        'generationId': 'G1',
        'status': status,
        'output': output,
        'spokenText': 'hello there',
        'warnings': [],
        'creditsCharged': 0.004,
        'error': None,
        'videoError': None,
        'audioUrl': AUDIO_URL,
        'videoUrl': None,
        'shareUrl': 'https://masky.ai/g-1',
        'userId': 'U',
        'firestorePath': 'users/U/x',
        'createdAt': 1000,
        'updatedAt': 4000,
    }
    g.update(over)
    return {'generation': g}


VIDEO_POST = {
    'generationId': 'V1',
    'slug': 'v',
    'url': 'https://masky.ai/v/1',
    'status': 'queued',
    'seconds': 5,
    'creditCost': 0.075,
}
IMAGE_BODY = {'imageUrl': IMAGE_URL, 'aspectRatio': '1:1', 'creditCost': 0.005}
IMAGES = {
    'avatarId': 'A',
    'avatarOwnerUserId': 'U',
    'images': [
        {'url': LOOK_LH, 'assetId': None, 'isPrimary': True},
        {'url': LOOK_FB, 'assetId': 'L1', 'isPrimary': False},
    ],
}
AVATARS = {
    'avatars': [
        {
            'avatarId': 'A',
            'avatarOwnerUserId': 'U',
            'displayName': 'Me',
            'voiceId': 'v1',
            'avatarImageUrl': 'https://cdn.example/a.png',
        }
    ],
    'owner': {'userId': 'U'},
}
CONVERSATION = {
    'conversationId': 'C1',
    'shareSlug': 'c-26-10-abcd',
    'shareUrl': 'https://masky.ai/c-26-10-abcd',
    'viewerToken': 'tok',
    'liveUrl': 'https://masky.ai/live/c-26-10-abcd?token=tok',
}
TURN = {
    'turn': {'id': 'T1', 'role': 'user', 'userText': 'hi', 'output': 'audio', 'status': 'pending'},
    'firestorePath': 'x',
    'async': True,
}


class FakeClient:
    """Records every call as (method, args); responses come from ``self.r``.

    For the polled endpoints (QUEUED) a list response is consumed one item per
    call (the last item repeats); an Exception instance is raised.
    """

    QUEUED = ('get_speak', 'get_video', 'get_conversation')

    def __init__(self, **responses):
        self.r = {
            'list_avatars': AVATARS,
            'list_public_avatars': [],
            'list_images': IMAGES,
            'speak': SPEAK_POST,
            'get_speak': gen(),
            'generate_video': VIDEO_POST,
            'get_video': dict(VIDEO_POST, status='ready', videoUrl=VIDEO_URL),
            'generate_image': IMAGE_BODY,
            'edit_image': IMAGE_BODY,
            'create_conversation': CONVERSATION,
            'send_turn': TURN,
            'get_conversation': {'turns': []},
            'set_conversation_image': {'ok': True},
            'put_binding': {'avatarId': 'A', 'agentBinding': {'pubkey': 'p'}},
            'get_binding': {'avatarId': 'A', 'agentBinding': None},
            'delete_binding': {'avatarId': 'A', 'agentBinding': None},
            'delete_conversation': {'ok': True},
            'delete_turn': {'ok': True},
            'restore_turn': {'ok': True},
            'set_avatar_public': {'ok': True},
            'set_conversation_visibility': {'ok': True},
            # Default: pricing endpoint unreachable. Pass a dict for a configured body.
            'get_video_pricing': MaskyError('Masky pricing is unreachable (ConnectionError).'),
        }
        self.r.update(responses)
        self.calls = []
        self.pricing_calls = 0  # kept out of ``calls`` so "no client call" assertions stay about paid/tool traffic
        self.closed = False

    def _do(self, name, *args):
        self.calls.append((name, *args))
        resp = self.r.get(name, {})
        if name in self.QUEUED and isinstance(resp, list):
            resp = resp.pop(0) if len(resp) > 1 else resp[0]
        if isinstance(resp, Exception):
            raise resp
        return resp

    def names(self):
        return [c[0] for c in self.calls]

    def args_of(self, name):
        return [c[1:] for c in self.calls if c[0] == name]

    def close(self):
        self.closed = True

    def list_voices(self):
        return self._do('list_voices')

    def list_avatars(self):
        return self._do('list_avatars')

    def list_public_avatars(self):
        return self._do('list_public_avatars')

    def lookup(self, user):
        return self._do('lookup', user)

    def create_avatar(self, body):
        return self._do('create_avatar', body)

    def train_avatar(self, avatar_id):
        return self._do('train_avatar', avatar_id)

    def set_avatar_voice(self, avatar_id, voice_id):
        return self._do('set_avatar_voice', avatar_id, voice_id)

    def get_stream_identity(self):
        return self._do('get_stream_identity')

    def set_stream_identity(self, avatar_id, image_url=None):
        return self._do('set_stream_identity', avatar_id, image_url)

    def list_images(self, avatar_id, owner=None):
        return self._do('list_images', avatar_id, owner)

    def add_image(self, avatar_id, image_url):
        return self._do('add_image', avatar_id, image_url)

    def speak(self, avatar_id, body):
        return self._do('speak', avatar_id, body)

    def get_speak(self, generation_id):
        return self._do('get_speak', generation_id)

    def generate_video(self, body):
        return self._do('generate_video', body)

    def get_video(self, generation_id):
        return self._do('get_video', generation_id)

    def generate_image(self, body):
        return self._do('generate_image', body)

    def edit_image(self, body):
        return self._do('edit_image', body)

    def create_conversation(self, owner, avatar_id):
        return self._do('create_conversation', owner, avatar_id)

    def send_turn(self, conversation_id, body):
        return self._do('send_turn', conversation_id, body)

    def get_conversation(self, slug):
        return self._do('get_conversation', slug)

    def set_avatar_public(self, avatar_id, public):
        return self._do('set_avatar_public', avatar_id, public)

    def set_conversation_visibility(self, conversation_id, public):
        return self._do('set_conversation_visibility', conversation_id, public)

    def get_video_pricing(self, *, timeout=5):
        self.pricing_calls += 1
        time.sleep(0.01)  # widen the window for the concurrency test
        resp = self.r['get_video_pricing']
        if isinstance(resp, Exception):
            raise resp
        return resp

    def set_conversation_image(self, conversation_id, url):
        return self._do('set_conversation_image', conversation_id, url)

    def get_binding(self, avatar_id):
        return self._do('get_binding', avatar_id)

    def put_binding(self, avatar_id, body):
        return self._do('put_binding', avatar_id, body)

    def delete_binding(self, avatar_id):
        return self._do('delete_binding', avatar_id)

    def delete_conversation(self, conversation_id):
        return self._do('delete_conversation', conversation_id)

    def delete_turn(self, conversation_id, turn_id):
        return self._do('delete_turn', conversation_id, turn_id)

    def restore_turn(self, conversation_id, turn_id):
        return self._do('restore_turn', conversation_id, turn_id)


def _driver(client=None, **kw):
    settings = kw.pop('settings', None)
    return MaskyDriver(server_name='masky', client=client or FakeClient(), settings=settings, **kw)


def _run(d, tool, **args):
    return d._tool_invoke(tool_name=f'masky.{tool}', input_obj=args)


class Clock:
    """Fake monotonic clock; sleep advances it."""

    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, s):
        self.sleeps.append(s)
        self.now += s


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    # masky_core.poll reads time.sleep / time.monotonic from its module global.
    monkeypatch.setattr(core, 'time', types.SimpleNamespace(sleep=c.sleep, monotonic=c.monotonic, time=lambda: 0.0))
    return c


def _keys(o):
    if isinstance(o, dict):
        for k, v in o.items():
            yield k
            yield from _keys(v)
    elif isinstance(o, list):
        for v in o:
            yield from _keys(v)


# ---------------------------------------------------------------------------
# 1. Validation raises before any client call
# ---------------------------------------------------------------------------

AV = {'avatar_id': 'A'}
X = 'x'

BAD_INPUTS = [
    # avatars / voices / looks
    ('list_avatars', {'query': 5}),
    ('list_avatars', {'include_public': []}),
    ('get_avatar', {}),
    ('get_avatar', {'avatar_id': 'A', 'handle': 'bob'}),
    ('get_avatar', {'handle': 'a', 'twitch_name': 'b'}),
    ('create_avatar', {'image_url': 'https://i/x.png'}),
    ('create_avatar', {'name': 'n'}),
    ('create_avatar', {'name': X * 81, 'image_url': 'https://i/x.png'}),
    ('create_avatar', {'name': 'n', 'image_url': 'file:///etc/passwd'}),
    ('create_avatar', {'name': 'n', 'image_url': 'https://i/x.png', 'personality': X * 4001}),
    (
        'create_avatar',
        {'name': 'n', 'image_url': 'https://i/x.png', 'knowledge_urls': ['https://k/%d' % i for i in range(11)]},
    ),
    ('create_avatar', {'name': 'n', 'image_url': 'https://i/x.png', 'knowledge_urls': ['file:///x']}),
    ('train_avatar', {}),
    ('set_stream_identity', {}),
    ('set_stream_identity', {'avatar_id': 'A', 'look_id': 'L1', 'look_url': 'https://i/x.png'}),
    ('list_voices', {'query': 5}),
    ('set_avatar_voice', {'avatar_id': 'A'}),
    ('add_look', {'avatar_id': 'A'}),
    ('add_look', {'avatar_id': 'A', 'image_url': 'file:///x.png'}),
    ('list_looks', {}),
    # speak
    ('speak', {'avatar_id': 'A'}),
    ('speak', {'text': 'hi'}),
    ('speak', {'avatar_id': 'A', 'text': X * 501}),
    ('speak', {'avatar_id': 'A', 'text': 'hi', 'output': 'gif'}),
    ('speak', {'avatar_id': 'A', 'text': 'hi', 'text_mode': 'x'}),
    ('speak', {'avatar_id': 'A', 'text': 'hi', 'look_id': 'L1', 'look_url': 'https://i/x.png'}),
    ('speak', {'avatar_id': 'A', 'text': 'hi', 'look_url': 'file:///x.png'}),
    # generate_video
    ('generate_video', {}),
    ('generate_video', {'prompt': X * 2001}),
    ('generate_video', {'prompt': 'p', 'speech_text': X * 301, 'avatar_id': 'A'}),
    ('generate_video', {'prompt': 'p', 'speech_text': 'hi'}),
    ('generate_video', {'prompt': 'p', 'speech_text': 'hi', 'audio_url': 'https://a/x.mp3', 'avatar_id': 'A'}),
    ('generate_video', {'prompt': 'p', 'image_url': 'https://i/x.png', 'look_id': 'L1', 'avatar_id': 'A'}),
    ('generate_video', {'prompt': 'p', 'look_id': 'L1'}),
    ('generate_video', {'prompt': 'p', 'image_url': 'file:///x.png'}),
    ('generate_video', {'prompt': 'p', 'audio_url': 'file:///x.mp3'}),
    ('generate_video', {'prompt': 'p', 'duration_sec': 21}),
    ('generate_video', {'prompt': 'p', 'duration_sec': 0}),
    ('generate_video', {'prompt': 'p', 'resolution': '4k'}),
    ('generate_video', {'prompt': 'p', 'fps': 30}),
    ('generate_video', {'prompt': 'p', 'aspect_ratio': '5:4'}),
    ('generate_video', {'prompt': 'p', 'share': 'none'}),
    ('generate_video', {'prompt': 'p', 'seed': -1}),
    ('generate_video', {'prompt': 'p', 'draft': []}),
    # images
    ('generate_image', {}),
    ('generate_image', {'prompt': X * 2001}),
    ('generate_image', {'prompt': 'p', 'engine': 'qwen'}),
    ('generate_image', {'prompt': 'p', 'aspect_ratio': '5:4'}),
    ('edit_image', {'prompt': 'p'}),
    ('edit_image', {'image_url': 'file:///x.png', 'prompt': 'p'}),
    ('edit_image', {'image_url': 'https://i/x.png'}),
    ('edit_image', {'image_url': 'https://i/x.png', 'prompt': 'p', 'engine': 'ideogram'}),
    # get_generation / estimate_cost
    ('get_generation', {}),
    ('get_generation', {'generation_id': 'rawid'}),
    ('get_generation', {'generation_id': 'rawid', 'kind': 'audio'}),
    ('get_generation', {'generation_id': 'speak:G1', 'kind': 'video'}),
    ('estimate_cost', {}),
    ('estimate_cost', {'kind': 'audio'}),
    ('estimate_cost', {'kind': 'speak'}),
    ('estimate_cost', {'kind': 'turn', 'text': 'hi', 'mode': 'x'}),
    ('estimate_cost', {'kind': 'video', 'resolution': '4k'}),
    ('estimate_cost', {'kind': 'image', 'engine': 'qwen'}),
    ('estimate_cost', {'kind': 'image', 'engine': 'ideogram', 'image_url': 'https://i/x.png'}),
    # live
    ('create_conversation', {}),
    ('create_conversation', {'avatar_id': 'A', 'look_id': 'L1', 'look_url': 'https://i/x.png'}),
    ('send_turn', {'text': 'hi'}),
    ('send_turn', {'slug': 'c-1'}),
    ('send_turn', {'slug': 'c-1', 'text': X * 501}),
    ('send_turn', {'slug': 'c-1', 'text': 'hi', 'mode': 'shout'}),
    ('send_turn', {'slug': 'c-1', 'text': 'hi', 'output': 'gif'}),
    ('get_turns', {}),
    ('get_turns', {'slug': 'c-1', 'limit': 0}),
    ('get_turns', {'slug': 'c-1', 'limit': 101}),
    ('get_turns', {'slug': 'c-1', 'since': True}),
    ('set_conversation_look', {'look_id': 'L1'}),
    ('set_conversation_look', {'slug': 'c-1'}),
    ('set_conversation_look', {'slug': 'c-1', 'look_id': 'L1', 'look_url': 'https://i/x.png'}),
    # binding
    ('bind_agent', {'pubkey': '0' * 64, 'relay': 'wss://r'}),
    ('bind_agent', {'avatar_id': 'A', 'pubkey': 'abc', 'relay': 'wss://r'}),
    ('bind_agent', {'avatar_id': 'A', 'pubkey': 'A' * 64, 'relay': 'wss://r'}),
    ('bind_agent', {'avatar_id': 'A', 'pubkey': '0' * 63, 'relay': 'wss://r'}),
    ('bind_agent', {'avatar_id': 'A', 'pubkey': '0' * 64, 'relay': 'ws://r'}),
    ('bind_agent', {'avatar_id': 'A', 'pubkey': '0' * 64, 'relay': 'https://r'}),
    ('bind_agent', {'avatar_id': 'A', 'pubkey': '0' * 64, 'relay': 'wss://r', 'timeout_sec': 4}),
    ('bind_agent', {'avatar_id': 'A', 'pubkey': '0' * 64, 'relay': 'wss://r', 'timeout_sec': 121}),
    ('bind_agent', {'avatar_id': 'A', 'pubkey': '0' * 64, 'relay': 'wss://r', 'fallback': 'retry'}),
    ('bind_agent', {'avatar_id': 'A', 'pubkey': '0' * 64, 'relay': 'wss://r', 'extra_tags': ['t']}),
    ('get_binding', {}),
    ('unbind_agent', {}),
]


@pytest.mark.parametrize('tool,args', BAD_INPUTS, ids=[f'{i}-{t}' for i, (t, _) in enumerate(BAD_INPUTS)])
def test_validation_raises_before_any_client_call(tool, args):
    client = FakeClient()
    with pytest.raises(ValueError):
        _run(_driver(client), tool, **args)
    assert client.calls == []


def test_validation_unknown_tool_lists_available():
    client = FakeClient()
    with pytest.raises(ValueError) as ei:
        _driver(client)._tool_invoke(tool_name='masky.nope', input_obj={})
    assert 'masky.speak' in str(ei.value) and 'masky.bind_agent' in str(ei.value)
    assert client.calls == []


@pytest.mark.parametrize('bad', [['x'], 'x', 5, 1.5, True])
def test_validation_non_object_input_is_refused(bad):
    client = FakeClient()
    with pytest.raises(ValueError, match='Tool input must be a JSON object'):
        _driver(client)._tool_invoke(tool_name='masky.speak', input_obj=bad)
    assert client.calls == []


@pytest.mark.parametrize('bad', [[], ['x'], 5, 'not json', '[1]'])
def test_validation_non_object_input_is_refused_even_without_required_args(bad):
    client = FakeClient()
    with pytest.raises(ValueError, match='Tool input must be a JSON object'):
        _driver(client)._tool_invoke(tool_name='masky.list_voices', input_obj=bad)
    assert client.calls == []


@pytest.mark.parametrize('empty', [None, {}, '', '{}', {'input': {}}])
def test_validation_empty_object_input_still_reaches_required_arg_check(empty):
    client = FakeClient()
    with pytest.raises(ValueError, match='"text" is required'):
        _driver(client)._tool_invoke(tool_name='masky.speak', input_obj=empty)
    assert client.calls == []


def test_input_accepts_json_string_and_input_envelope():
    d = _driver(FakeClient(), settings={'default_avatar': 'A'})
    d._tool_validate(tool_name='masky.speak', input_obj='{"text": "hi"}')
    d._tool_validate(tool_name='masky.speak', input_obj={'input': {'text': 'hi'}})
    client = FakeClient(get_conversation=TURNS)
    d = _driver(client)
    for raw in ('{"slug": "c-1", "limit": 1}', {'input': {'slug': 'c-1', 'limit': 1}}):
        assert d._tool_invoke(tool_name='masky.get_turns', input_obj=raw)['count'] == 1
    assert client.args_of('get_conversation') == [('c-1',), ('c-1',)]


def test_numeric_string_int_args_are_coerced():
    client = FakeClient(get_conversation=TURNS)
    d = _driver(client)
    assert _run(d, 'get_turns', slug='c-1', limit='2')['count'] == 2
    assert _run(d, 'estimate_cost', kind='video', duration_sec='5')['estimated_credits'] == 0.077
    calls = len(client.calls)
    for bad in (True, 1.5, 'many'):
        with pytest.raises(ValueError, match='"limit" must be an integer between 1 and 100'):
            _run(d, 'get_turns', slug='c-1', limit=bad)
    assert len(client.calls) == calls


def test_validation_default_avatar_satisfies_avatar_requirement():
    d = _driver(FakeClient(), settings={'default_avatar': 'A'})
    d._tool_validate(tool_name='masky.speak', input_obj={'text': 'hi'})


def test_validation_boundaries_accepted():
    d = _driver(FakeClient())
    d._tool_validate(tool_name='masky.speak', input_obj={'avatar_id': 'A', 'text': X * 500})
    d._tool_validate(
        tool_name='masky.bind_agent',
        input_obj={'avatar_id': 'A', 'pubkey': 'a' * 64, 'relay': 'wss://r', 'timeout_sec': 5},
    )
    d._tool_validate(
        tool_name='masky.bind_agent',
        input_obj={'avatar_id': 'A', 'pubkey': 'a' * 64, 'relay': 'wss://r', 'timeout_sec': 120},
    )
    d._tool_validate(
        tool_name='masky.create_avatar',
        input_obj={'name': X * 80, 'image_url': 'https://i/x.png', 'knowledge_urls': ['https://k'] * 10},
    )


# ---------------------------------------------------------------------------
# 2. Job ids
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('kind', ['speak', 'video', 'image'])
def test_job_id_round_trip(kind):
    jid = core.encode_job_id(kind, 'abc')
    assert jid == f'{kind}:abc'
    assert core.decode_job_id(jid) == (kind, 'abc')
    assert core.decode_job_id(jid, kind) == (kind, 'abc')


def test_job_id_raw_with_kind():
    assert core.decode_job_id('rawid', 'video') == ('video', 'rawid')


def test_job_id_raw_without_kind_errors():
    with pytest.raises(ValueError):
        core.decode_job_id('rawid')
    with pytest.raises(ValueError):
        core.decode_job_id('')


def test_job_id_kind_mismatch_errors():
    with pytest.raises(ValueError):
        core.decode_job_id('speak:G1', 'video')


def test_job_id_empty_after_prefix_and_bad_kind_error():
    with pytest.raises(ValueError):
        core.decode_job_id('speak:')
    with pytest.raises(ValueError):
        core.decode_job_id('rawid', 'audio')


def test_image_job_id_stable_across_query():
    a = core.image_job_id('https://x/i.png?token=1')
    assert a == core.image_job_id('https://x/i.png?token=2')
    assert a.startswith('image:') and a != core.image_job_id('https://x/other.png')


# ---------------------------------------------------------------------------
# 3. Look ids
# ---------------------------------------------------------------------------


def test_look_id_uses_asset_id_else_hash_ignoring_query():
    assert core.look_id_for('https://x/a.png', 'L9') == 'L9'
    h = core.look_id_for('https://x/a.png?t=1')
    assert h.startswith('look_') and len(h) == len('look_') + 10
    assert all(c in '0123456789abcdef' for c in h[5:])
    assert h == core.look_id_for('https://x/a.png?t=2')
    assert h != core.look_id_for('https://x/b.png')


def test_resolve_look_by_id_and_url():
    looks = IMAGES['images']
    hash_id = core.look_id_for(LOOK_LH)
    assert core.resolve_look('L1', looks) == LOOK_FB
    assert core.resolve_look(hash_id, looks) == LOOK_FB.replace(LOOK_FB, LOOK_LH)
    assert core.resolve_look(LOOK_FB, looks) == LOOK_FB
    # same file, different signed query string
    assert core.resolve_look('https://firebasestorage.googleapis.com/o/l1.jpeg?alt=media&token=NEW', looks) == LOOK_FB


def test_resolve_look_unknown_lists_valid_ids():
    with pytest.raises(MaskyError) as ei:
        core.resolve_look('nope', IMAGES['images'])
    assert 'L1' in str(ei.value) and core.look_id_for(LOOK_LH) in str(ei.value)
    with pytest.raises(MaskyError) as ei:
        core.resolve_look('nope', [])
    assert 'none registered' in str(ei.value)


def test_speak_with_look_id_sends_avatar_image_url():
    client = FakeClient()
    _run(_driver(client), 'speak', avatar_id='A', text='hi', look_id='L1')
    ((avatar, body),) = client.args_of('speak')
    assert avatar == 'A' and body['avatarImageUrl'] == LOOK_FB


def test_speak_with_look_url_and_unknown_look():
    client = FakeClient()
    d = _driver(client)
    _run(d, 'speak', avatar_id='A', text='hi', look_url=LOOK_LH)
    assert client.args_of('speak')[0][1]['avatarImageUrl'] == LOOK_LH
    client2 = FakeClient()
    with pytest.raises(MaskyError):
        _run(_driver(client2), 'speak', avatar_id='A', text='hi', look_id='zzz')
    assert 'speak' not in client2.names()


def test_speak_without_look_omits_avatar_image_url():
    client = FakeClient()
    _run(_driver(client), 'speak', avatar_id='A', text='hi')
    body = client.args_of('speak')[0][1]
    assert 'avatarImageUrl' not in body
    assert body['output'] == 'video' and body['textMode'] == 'literal' and body['language'] == 'en'


# ---------------------------------------------------------------------------
# 4. Cost
# ---------------------------------------------------------------------------


def test_round_up_credits():
    assert core.round_up_credits(0.0041) == 0.005
    assert core.round_up_credits(0.004) == 0.004
    assert core.round_up_credits(0.0045) == 0.005
    assert core.round_up_credits(0.0) == 0.0


def test_estimate_speak_audio_32_chars():
    est = core.estimate_speak('x' * 32, 'audio')
    assert est['credits'] == 0.004 and est['verified'] is True
    assert est['price_table_date'] == core.PRICE_TABLE_DATE and '2 s' in est['basis']


def test_estimate_speak_talking_head_verified():
    # 0.0265 credits per rendered second was measured on 2026-10-20 (15.04 s cost 0.3985).
    est = core.estimate_speak('x' * 32, 'video')
    assert est['credits'] == 0.054 and est['verified'] is True  # 2 s x 0.0265 + 0.001 text step


@pytest.mark.parametrize(
    ('chars', 'output', 'credits', 'seconds'),
    [(32, 'audio', 0.004, 2), (223, 'video', 0.3985, 15), (400, 'video', 0.7165, 27)],
)
def test_estimate_speak_reproduces_measured_masky_charges(chars, output, credits, seconds):
    assert core.billed_speech_seconds(chars) == seconds
    assert core.estimate_speak('x' * chars, output)['credits'] == credits


@pytest.mark.parametrize(
    ('chars', 'seconds'),
    [
        (0, 1),
        (1, 1),
        (2, 1),
        (3, 1),
        (4, 1),
        (5, 1),
        (6, 1),
        (7, 1),
        (8, 1),
        (22, 1),
        (23, 2),
        (37, 2),
        (38, 3),
        (105, 7),
    ],
)
def test_billed_speech_seconds_edges(chars, seconds):
    assert core.billed_speech_seconds(chars) == seconds


def test_personality_video_passes_default_cap_and_is_refused_at_a_lower_one():
    client = FakeClient()
    _run(_driver(client), 'speak', avatar_id='A', text='hi', output='video', text_mode='personality')  # 0.8755 < 1.0
    assert 'speak' in client.names()
    low = FakeClient()
    with pytest.raises(MaskyError) as ei:
        _run(
            _driver(low, settings={'max_credits_per_call': 0.8}),
            'speak',
            avatar_id='A',
            text='hi',
            output='video',
            text_mode='personality',
        )
    assert 'Max Credits per Call' in str(ei.value)
    assert low.calls == []


def test_500_char_literal_talking_head_video_passes_default_cap():
    est = core.estimate_speak('x' * 500, 'video')
    assert est['credits'] == 0.8755  # 33 s
    core.check_budget(est, 1.0)
    client = FakeClient()
    _run(_driver(client), 'speak', avatar_id='A', text='x' * 500, output='video')
    assert 'speak' in client.names()


def test_estimate_video_rates():
    assert core.estimate_video(resolution='720p', draft=True, duration_sec=5)['credits'] == 0.077
    assert core.estimate_video(resolution='720p', draft=False, duration_sec=5)['credits'] == 0.128
    assert core.estimate_video(resolution='1080p', draft=False, duration_sec=5)['credits'] == 0.255
    assert core.estimate_video(resolution='1080p', draft=True, duration_sec=5)['credits'] == 0.153
    assert core.estimate_video(resolution='720p', draft=False)['credits'] == 0.128  # default 5 s
    assert core.estimate_video(resolution='720p', draft=False, duration_sec=5)['verified'] is True


def test_estimate_video_speech_sets_length():
    # 24 chars -> 2 s; duration_sec is ignored
    assert (
        core.estimate_video(resolution='720p', draft=False, duration_sec=20, speech_text='x' * 24)['credits'] == 0.053
    )
    # very long speech is capped at the 20 s maximum
    assert core.estimate_video(resolution='720p', draft=False, speech_text='x' * 300)['credits'] == 0.503


def test_estimate_video_audio_url_assumes_20s():
    est = core.estimate_video(resolution='720p', draft=False, duration_sec=1, audio_url='https://a/x.mp3')
    assert est['credits'] == 0.503 and '20' in est['basis']


def test_estimate_image_edit_and_generate():
    gen_default = core.estimate_image(edit=False, engine='default')
    assert gen_default['credits'] == 0.005 and gen_default['verified'] is True  # measured 2026-10-20
    ideogram = core.estimate_image(edit=False, engine='ideogram')
    assert ideogram['credits'] == 0.015 and ideogram['verified'] is False  # docs page only
    edit_default = core.estimate_image(edit=True, engine='default')
    assert edit_default['credits'] == 0.01 and edit_default['verified'] is True
    assert core.estimate_image(edit=True, engine='qwen')['credits'] == 0.03


def test_estimate_turn_chat_vs_speak():
    # Masky bills turns like speech: max(1, round(chars / 15)) s x rate + 0.001.
    speak = core.estimate_turn('x' * 24, mode='speak', output='audio')
    assert speak['credits'] == 0.004 and speak['verified'] is True  # 2 s
    chat = core.estimate_turn('x', mode='chat', output='audio')
    assert chat['credits'] == 0.0505 and chat['verified'] is False  # 500 assumed chars -> 33 s
    assert chat['credits'] > speak['credits']
    assert core.estimate_turn('x' * 24, mode='speak', output='video')['credits'] == 0.054
    assert core.estimate_turn('x', mode='chat', output='video')['credits'] == 0.8755


def test_check_budget_message_and_disable():
    est = core.estimate_speak('x' * 500, 'video')
    with pytest.raises(MaskyError) as ei:
        core.check_budget(est, 0.5)
    assert str(est['credits']) in str(ei.value) and '0.5' in str(ei.value)
    core.check_budget(est, 0)  # cap 0 disables the guard
    core.check_budget(est, est['credits'])  # equal to the cap is allowed


def test_driver_speak_over_cap_makes_no_client_call():
    client = FakeClient()
    with pytest.raises(MaskyError) as ei:
        _run(_driver(client, settings={'max_credits_per_call': 0.5}), 'speak', avatar_id='A', text='x' * 500)
    assert 'cap' in str(ei.value)  # 500 chars as video is 0.8755 credits > cap 0.5
    assert client.calls == []


def test_driver_cap_zero_allows_expensive_speak():
    client = FakeClient()
    _run(_driver(client, settings={'max_credits_per_call': 0}), 'speak', avatar_id='A', text='x' * 500)
    assert 'speak' in client.names()


def test_driver_other_renders_respect_cap():
    client = FakeClient()
    d = _driver(client, settings={'max_credits_per_call': 0.001})
    for tool, args in (
        ('generate_video', {'prompt': 'p'}),
        ('generate_image', {'prompt': 'p'}),
        ('edit_image', {'prompt': 'p', 'image_url': 'https://i/x.png'}),
        ('send_turn', {'slug': 'c-1', 'text': 'hi', 'mode': 'speak'}),
    ):
        with pytest.raises(MaskyError):
            _run(d, tool, **args)
    assert client.calls == []


def test_driver_estimate_cost_within_cap():
    client = FakeClient()
    out = _run(_driver(client), 'estimate_cost', kind='speak', text='x' * 32, output='audio')
    assert (
        out['estimated_credits'] == 0.004 and out['cap'] == 1.0 and out['within_cap'] is True and out['kind'] == 'speak'
    )
    out = _run(
        _driver(client, settings={'max_credits_per_call': 0.001}),
        'estimate_cost',
        kind='speak',
        text='x' * 32,
        output='audio',
    )
    assert out['within_cap'] is False
    out = _run(_driver(client, settings={'max_credits_per_call': 0}), 'estimate_cost', kind='speak', text='x' * 500)
    assert out['within_cap'] is True
    assert client.calls == []  # estimating never calls Masky


def test_driver_estimate_cost_kinds():
    d = _driver(FakeClient())
    assert _run(d, 'estimate_cost', kind='video', duration_sec=5)['estimated_credits'] == 0.077  # default 720p-draft
    assert (
        _run(d, 'estimate_cost', kind='video', duration_sec=5, resolution='1080p', draft=False)['estimated_credits']
        == 0.255
    )
    assert _run(d, 'estimate_cost', kind='image')['estimated_credits'] == 0.005
    assert _run(d, 'estimate_cost', kind='image', engine='ideogram')['estimated_credits'] == 0.015
    assert _run(d, 'estimate_cost', kind='image', image_url='https://i/x.png')['estimated_credits'] == 0.01
    assert (
        _run(d, 'estimate_cost', kind='image', image_url='https://i/x.png', engine='qwen')['estimated_credits'] == 0.03
    )
    assert _run(d, 'estimate_cost', kind='turn', text='hi')['estimated_credits'] == 0.0505  # chat default
    assert _run(d, 'estimate_cost', kind='turn', text='hi', mode='speak')['estimated_credits'] == 0.0025


# ---------------------------------------------------------------------------
# 5. 402 mapping
# ---------------------------------------------------------------------------


def test_driver_402_mentions_estimate():
    client = FakeClient(speak=core.error_for_status(402, {}, method='POST', path='/avatars/A/speak'))
    with pytest.raises(MaskyError) as ei:
        _run(_driver(client), 'speak', avatar_id='A', text='x' * 32, output='audio')
    msg = str(ei.value)
    assert msg.count('insufficient credits') == 1 and msg.count('Top up') == 1
    assert 'estimated at 0.004' in msg
    assert ei.value.status == 402


def test_driver_402_keeps_masky_credit_numbers_without_repeating():
    err = core.error_for_status(402, {'requiredCredits': 12.5, 'availableCredits': 3}, method='POST', path='/x')
    client = FakeClient(speak=err)
    with pytest.raises(MaskyError) as ei:
        _run(_driver(client), 'speak', avatar_id='A', text='x' * 32, output='audio')
    msg = str(ei.value)
    assert '(needs 12.5, available 3)' in msg and 'estimated at 0.004' in msg
    assert msg.count('insufficient credits') == 1 and msg.count('Top up') == 1


def test_driver_402_on_video_image_turn():
    err = core.error_for_status(402, {}, method='POST', path='/x')
    for tool, args, key in (
        ('generate_video', {'prompt': 'p'}, 'generate_video'),
        ('generate_image', {'prompt': 'p'}, 'generate_image'),
        ('edit_image', {'prompt': 'p', 'image_url': 'https://i/x.png'}, 'edit_image'),
        ('send_turn', {'slug': 'c-1', 'text': 'hi', 'conversation_id': 'C1'}, 'send_turn'),
    ):
        with pytest.raises(MaskyError) as ei:
            _run(_driver(FakeClient(**{key: err})), tool, **args)
        msg = str(ei.value)
        assert msg.count('insufficient credits') == 1 and msg.count('Top up') == 1, tool
        assert 'estimated at' in msg and ei.value.status == 402, tool


def test_driver_non_402_error_passes_through():
    client = FakeClient(speak=MaskyError('boom', status=500))
    with pytest.raises(MaskyError) as ei:
        _run(_driver(client), 'speak', avatar_id='A', text='hi')
    assert str(ei.value) == 'boom' and ei.value.status == 500


# ---------------------------------------------------------------------------
# 6. Receipts
# ---------------------------------------------------------------------------

EST = {'credits': 0.005}


def _speak_receipt(body, output='audio'):
    return core.speak_receipt(body, output=output, estimate=EST, elapsed_sec=1.234)


def test_speak_receipt_fields_and_no_internal_ids():
    r = _speak_receipt(gen())
    dumped = json.dumps(r)
    assert 'userId' not in dumped and 'firestorePath' not in dumped and 'users/U' not in dumped
    assert r['generation_id'] == 'speak:G1' and r['kind'] == 'speak'
    assert r['spoken_text'] == 'hello there' and r['warnings'] == []
    assert r['share_url'] == 'https://masky.ai/g-1' and r['reused'] is False
    assert r['credits_charged'] == 0.004 and r['estimated_credits'] == 0.005
    assert r['elapsed_sec'] == 1.2
    assert r['media'] == {'mime': 'audio/mpeg', 'url': AUDIO_URL, 'url_expires_at': '2026-10-16T23:25:06Z'}


def test_speak_receipt_post_body_shape_and_reused():
    r = _speak_receipt(SPEAK_POST[1])
    assert r['generation_id'] == 'speak:G1' and r['reused'] is False and r['status'] == 'running'
    assert 'userId' not in json.dumps(r) and 'firestorePath' not in json.dumps(r)
    assert _speak_receipt(dict(SPEAK_POST[1], reused=True))['reused'] is True


def test_speak_receipt_warnings_passed_through():
    r = _speak_receipt(gen(warnings=['trimmed', 7]))
    assert r['warnings'] == ['trimmed', '7']


def test_speak_status_rules():
    assert _speak_receipt(gen('audio', 'audio'), 'audio')['status'] == 'done'
    assert _speak_receipt(gen('audio', 'video'), 'video')['status'] == 'running'
    assert _speak_receipt(gen('video', 'video', videoUrl=VIDEO_URL), 'video')['status'] == 'done'
    assert _speak_receipt(gen('pending'), 'audio')['status'] == 'running'


def test_speak_video_done_attaches_video_media():
    r = _speak_receipt(gen('video', 'video', videoUrl=VIDEO_URL), 'video')
    assert r['media']['mime'] == 'video/mp4' and r['media']['url'] == VIDEO_URL


def test_speak_error_with_audio_and_audio_output_is_done_with_warning():
    r = _speak_receipt(gen('error', 'audio', error='late failure'), 'audio')
    assert r['status'] == 'done' and 'error' not in r
    assert any('late failure' in w for w in r['warnings'])
    assert r['media']['url'] == AUDIO_URL


def test_speak_error_with_audio_and_video_output_is_failed_with_audio_attached():
    r = _speak_receipt(gen('error', 'video', videoError='lipsync crashed'), 'video')
    assert r['status'] == 'failed'
    assert 'lipsync crashed' in r['error'] and 'speak:G1' in r['error']
    assert r['media']['mime'] == 'audio/mpeg' and r['media']['url'] == AUDIO_URL
    assert any('audio rendered' in w for w in r['warnings'])


def test_speak_error_without_audio_is_failed():
    for output in ('audio', 'video'):
        r = _speak_receipt(gen('error', output, audioUrl=None, error='bad'), output)
        assert r['status'] == 'failed' and 'bad' in r['error']
        assert 'url' not in r['media']
    r = _speak_receipt(gen('error', 'audio', audioUrl=None), 'audio')
    assert 'no detail' in r['error']


def test_url_expires_at():
    assert core.url_expires_at(AUDIO_URL) == '2026-10-16T23:25:06Z'
    assert core.url_expires_at(None) is None
    assert core.url_expires_at('https://x/a.mp3') is None
    assert core.url_expires_at('https://x/a.mp3?Expires=soon') is None


@pytest.mark.parametrize(
    'raw,status',
    [('queued', 'queued'), ('rendering', 'running'), ('ready', 'done'), ('error', 'failed'), ('weird', 'running')],
)
def test_video_receipt_status_mapping(raw, status):
    r = core.video_receipt(dict(VIDEO_POST, status=raw, videoUrl=VIDEO_URL, error='nope'), estimate=EST, elapsed_sec=2)
    assert r['status'] == status and r['generation_id'] == 'video:V1' and r['kind'] == 'video'
    assert r['credits_charged'] == 0.075 and r['share_url'] == 'https://masky.ai/v/1'
    if status == 'done':
        assert r['media']['url'] == VIDEO_URL and r['media']['mime'] == 'video/mp4'
    else:
        assert 'url' not in r['media']
    if status == 'failed':
        assert 'nope' in r['error']
    else:
        assert 'error' not in r


def test_image_receipt():
    r = core.image_receipt(IMAGE_BODY, estimate=EST, elapsed_sec=0.5)
    assert r['status'] == 'done' and r['kind'] == 'image' and r['generation_id'] == core.image_job_id(IMAGE_URL)
    assert r['media'] == {'mime': 'image/png', 'url': IMAGE_URL}
    assert r['credits_charged'] == 0.005
    assert (
        core.image_receipt({'imageUrl': 'https://x/a.JPG?q=1'}, estimate=EST, elapsed_sec=0)['media']['mime']
        == 'image/jpeg'
    )


def test_driver_speak_202_is_queued_and_records_cost():
    d = _driver(FakeClient())
    r = _run(d, 'speak', avatar_id='A', text='x' * 32, output='audio')
    assert r['status'] == 'queued' and r['generation_id'] == 'speak:G1'
    assert r['estimated_credits'] == 0.004 and r['media'] == {'mime': 'audio/mpeg'}
    assert 'userId' not in json.dumps(r) and 'firestorePath' not in json.dumps(r)


def test_driver_speak_inline_200_is_not_queued():
    client = FakeClient(speak=(200, dict(gen()['generation'], async_=False)))
    r = _run(_driver(client), 'speak', avatar_id='A', text='hi', output='audio')
    assert r['status'] == 'done' and r['media']['url'] == AUDIO_URL


# ---------------------------------------------------------------------------
# 7. include_media_urls False
# ---------------------------------------------------------------------------

FORBIDDEN_KEYS = {'url', 'url_expires_at', 'live_url', 'image_url'}
FORBIDDEN_TEXT = ('storage.googleapis.com', 'firebasestorage', 'token=', 'googleusercontent')


def _assert_clean(result):
    assert not (set(_keys(result)) & FORBIDDEN_KEYS), set(_keys(result))
    dumped = json.dumps(result)
    for bad in FORBIDDEN_TEXT:
        assert bad not in dumped, bad


def _quiet_driver(client=None, **settings):
    return _driver(
        client or FakeClient(),
        include_media_urls=False,
        settings=dict({'timeout_sec': 5, 'poll_interval_sec': 1}, **settings),
    )


def test_no_media_urls_speak(clock):
    r = _run(_quiet_driver(), 'speak', avatar_id='A', text='hi', output='audio', wait_for_completion=True)
    assert r['status'] == 'done' and r['media'] == {'mime': 'audio/mpeg'}
    _assert_clean(r)
    assert r['share_url'] == 'https://masky.ai/g-1'


def test_no_media_urls_speak_video_failed_with_audio(clock):
    client = FakeClient(get_speak=gen('error', 'video', videoError='x'))
    r = _run(_quiet_driver(client), 'speak', avatar_id='A', text='hi', wait_for_completion=True)
    assert r['status'] == 'failed'
    _assert_clean(r)


def test_no_media_urls_generate_video(clock):
    r = _run(_quiet_driver(), 'generate_video', prompt='p', wait_for_completion=True)
    assert r['status'] == 'done' and r['media'] == {'mime': 'video/mp4'}
    _assert_clean(r)
    assert r['share_url'] == 'https://masky.ai/v/1'


def test_no_media_urls_images():
    d = _quiet_driver()
    for r in (_run(d, 'generate_image', prompt='p'), _run(d, 'edit_image', prompt='p', image_url='https://i/x.png')):
        assert r['media'] == {'mime': 'image/png'}
        _assert_clean(r)
        _assert_clean(_run(d, 'get_generation', generation_id=r['generation_id']))


def test_no_media_urls_get_generation(clock):
    d = _quiet_driver()
    _assert_clean(_run(d, 'get_generation', generation_id='speak:G1'))
    _assert_clean(_run(d, 'get_generation', generation_id='G1', kind='video'))


def test_no_media_urls_looks_and_avatars():
    d = _quiet_driver()
    looks = _run(d, 'list_looks', avatar_id='A')
    assert [x['look_id'] for x in looks['looks']] == [core.look_id_for(LOOK_LH), 'L1']
    _assert_clean(looks)
    _assert_clean(_run(d, 'list_avatars'))
    _assert_clean(_run(d, 'get_avatar', avatar_id='A'))


def test_no_media_urls_add_look_and_stream_identity():
    client = FakeClient(
        add_image={'avatarId': 'A', 'assetId': 'L2', 'url': LOOK_FB},
        get_stream_identity={
            'streamIdentity': {'avatarId': 'A', 'imageUrl': LOOK_FB, 'displayName': 'Me', 'voiceId': 'v1'}
        },
    )
    d = _quiet_driver(client)
    out = _run(d, 'add_look', avatar_id='A', image_url='https://i/x.png')
    assert out['look_id'] == 'L2'
    _assert_clean(out)
    _assert_clean(_run(d, 'get_stream_identity'))


def test_no_media_urls_create_conversation_and_turns():
    client = FakeClient()
    d = _quiet_driver(client)
    out = _run(d, 'create_conversation', avatar_id='A')
    assert 'live_url' not in out and out['share_url'] == 'https://masky.ai/c-26-10-abcd'
    _assert_clean(out)
    client.r['get_conversation'] = {
        'turns': [{'id': 'T1', 'createdAt': 1, 'status': 'audio', 'output': 'audio', 'audioUrl': AUDIO_URL}]
    }
    turns = _run(d, 'get_turns', slug='c-26-10-abcd')
    assert turns['count'] == 1
    _assert_clean(turns)


def test_media_urls_present_when_enabled(clock):
    d = _driver(FakeClient(), settings={'timeout_sec': 5, 'poll_interval_sec': 1})
    r = _run(d, 'speak', avatar_id='A', text='hi', output='audio', wait_for_completion=True)
    assert r['media']['url'] == AUDIO_URL and r['media']['url_expires_at'] == '2026-10-16T23:25:06Z'
    out = _run(d, 'create_conversation', avatar_id='A')
    assert out['live_url'] == CONVERSATION['liveUrl']
    assert {'url', 'is_primary'} <= set(_run(d, 'list_looks', avatar_id='A')['looks'][0])


# ---------------------------------------------------------------------------
# 8. Polling
# ---------------------------------------------------------------------------


def test_poll_done_on_second_fetch(clock):
    seq = ['pending', 'done']
    calls = []

    def fetch():
        calls.append(clock.now)
        return seq.pop(0)

    result, finished = core.poll(fetch, lambda r: r == 'done', timeout_sec=10, interval_sec=2)
    assert (result, finished) == ('done', True)
    assert calls == [0.0, 2.0]


def test_poll_done_immediately_never_sleeps(clock):
    assert core.poll(lambda: 'done', lambda r: True, timeout_sec=10, interval_sec=2) == ('done', True)
    assert clock.sleeps == []


def test_poll_timeout_returns_last_and_false(clock):
    n = []

    def fetch():
        n.append(1)
        return f'r{len(n)}'

    result, finished = core.poll(fetch, lambda r: False, timeout_sec=5, interval_sec=2)
    assert finished is False and result == f'r{len(n)}'
    assert clock.now >= 5
    assert max(clock.sleeps) <= 1.0  # waits in slices of at most 1 s


def test_poll_cancelled_raises(clock):
    with pytest.raises(MaskyCancelled) as ei:
        core.poll(lambda: 'pending', lambda r: False, timeout_sec=10, interval_sec=2, is_cancelled=lambda: True)
    assert isinstance(ei.value, MaskyError)


def test_poll_cancelled_mid_wait(clock):
    state = {'n': 0}

    def cancelled():
        state['n'] += 1
        return state['n'] > 3

    with pytest.raises(MaskyCancelled):
        core.poll(lambda: 'pending', lambda r: False, timeout_sec=60, interval_sec=10, is_cancelled=cancelled)
    assert clock.now < 10


def test_poll_failed_terminal_counts_as_done(clock):
    result, finished = core.poll(
        lambda: {'status': 'error'}, lambda r: r['status'] in ('ready', 'error'), timeout_sec=10, interval_sec=2
    )
    assert finished is True and result == {'status': 'error'}


def test_driver_speak_waits_until_done(clock):
    client = FakeClient(get_speak=[gen('pending'), gen('pending'), gen('audio')])
    d = _driver(client, settings={'timeout_sec': 60, 'poll_interval_sec': 2})
    r = _run(d, 'speak', avatar_id='A', text='hi', output='audio', wait_for_completion=True)
    assert r['status'] == 'done' and r['warnings'] == []
    assert client.args_of('get_speak') == [('G1',)] * 3
    assert clock.now >= 4


def test_driver_speak_without_wait_does_not_poll():
    client = FakeClient()
    _run(_driver(client), 'speak', avatar_id='A', text='hi')
    assert 'get_speak' not in client.names()


def test_driver_speak_timeout_adds_warning(clock):
    client = FakeClient(get_speak=gen('pending'))
    d = _driver(client, settings={'timeout_sec': 5, 'poll_interval_sec': 2})
    r = _run(d, 'speak', avatar_id='A', text='hi', output='audio', wait_for_completion=True)
    assert r['status'] == 'running'
    assert any('Still rendering after 5 s (job speak:G1)' in w for w in r['warnings'])


def test_driver_video_timeout_adds_warning(clock):
    client = FakeClient(get_video=dict(VIDEO_POST, status='rendering'))
    d = _driver(client, settings={'timeout_sec': 4, 'poll_interval_sec': 2})
    r = _run(d, 'generate_video', prompt='p', wait_for_completion=True)
    assert r['status'] == 'running'
    assert any('Still rendering after 4 s (job video:V1)' in w for w in r['warnings'])


def test_driver_video_failed_is_terminal_without_timeout_warning(clock):
    client = FakeClient(get_video=dict(VIDEO_POST, status='error', error='gpu on fire'))
    d = _driver(client, settings={'timeout_sec': 30, 'poll_interval_sec': 2})
    r = _run(d, 'generate_video', prompt='p', wait_for_completion=True)
    assert r['status'] == 'failed' and 'gpu on fire' in r['error']
    assert r['warnings'] == [] and clock.sleeps == []


def test_driver_speak_cancelled_raises(clock):
    client = FakeClient(get_speak=gen('pending'))
    d = _driver(client, settings={'timeout_sec': 30, 'poll_interval_sec': 2}, is_cancelled=lambda: True)
    with pytest.raises(MaskyCancelled):
        _run(d, 'speak', avatar_id='A', text='hi', output='audio', wait_for_completion=True)


def test_driver_get_generation_wait_and_timeout(clock):
    client = FakeClient(get_speak=[gen('pending'), gen('audio')])
    d = _driver(client, settings={'timeout_sec': 30, 'poll_interval_sec': 2})
    r = _run(d, 'get_generation', generation_id='speak:G1', wait_for_completion=True)
    assert r['status'] == 'done'
    assert r['elapsed_sec'] == 3.0  # (updatedAt - createdAt) / 1000 for a job this run did not start

    client2 = FakeClient(get_video=dict(VIDEO_POST, status='queued'))
    d2 = _driver(client2, settings={'timeout_sec': 3, 'poll_interval_sec': 1})
    r = _run(d2, 'get_generation', generation_id='V1', kind='video', wait_for_completion=True)
    assert r['status'] == 'queued' and any('Still rendering after 3 s' in w for w in r['warnings'])


def test_driver_get_generation_no_wait_fetches_once():
    client = FakeClient(get_speak=gen('pending'))
    r = _run(_driver(client), 'get_generation', generation_id='speak:G1')
    assert r['status'] == 'running' and client.names() == ['get_speak']


def test_driver_get_generation_uses_requested_output_from_job():
    client = FakeClient(get_speak=gen('audio', 'video'))
    d = _driver(client)
    _run(d, 'speak', avatar_id='A', text='hi', output='video')
    # job remembers output=video, so an audio-stage generation is still running
    assert _run(d, 'get_generation', generation_id='speak:G1')['status'] == 'running'


# ---------------------------------------------------------------------------
# 9. Images
# ---------------------------------------------------------------------------


def test_generate_image_cached_for_get_generation():
    client = FakeClient()
    d = _driver(client)
    r = _run(d, 'generate_image', prompt='a cat', engine='ideogram', aspect_ratio='1:1')
    assert client.args_of('generate_image') == [({'prompt': 'a cat', 'model': 'ideogram', 'aspectRatio': '1:1'},)]
    assert r['estimated_credits'] == 0.015
    again = _run(d, 'get_generation', generation_id=r['generation_id'])
    assert again == r
    assert again is not r and again['media'] is not r['media']
    assert client.names() == ['generate_image']  # served from the run cache


def test_edit_image_cached_and_body():
    client = FakeClient()
    d = _driver(client)
    r = _run(d, 'edit_image', prompt='studio', image_url='https://i/x.png', engine='qwen')
    assert client.args_of('edit_image') == [({'prompt': 'studio', 'imageUrl': 'https://i/x.png', 'model': 'qwen'},)]
    assert r['estimated_credits'] == 0.03
    assert _run(d, 'get_generation', generation_id=r['generation_id']) == r


def test_get_generation_image_with_raw_id_and_kind():
    d = _driver(FakeClient())
    r = _run(d, 'generate_image', prompt='p')
    raw = r['generation_id'].split(':', 1)[1]
    assert _run(d, 'get_generation', generation_id=raw, kind='image') == r


def test_get_generation_image_unknown_in_fresh_driver():
    r = _run(_driver(FakeClient()), 'generate_image', prompt='p')
    fresh = _driver(FakeClient())
    with pytest.raises(MaskyError) as ei:
        _run(fresh, 'get_generation', generation_id=r['generation_id'])
    assert 'cannot be looked up later' in str(ei.value)


# ---------------------------------------------------------------------------
# 10. Live conversations
# ---------------------------------------------------------------------------


def test_create_conversation_resolves_owner_and_caches_slug():
    client = FakeClient()
    d = _driver(client)
    out = _run(d, 'create_conversation', avatar_id='A')
    assert client.args_of('create_conversation') == [('U', 'A')]
    assert 'list_avatars' in client.names()
    assert out == {
        'conversation_slug': 'c-26-10-abcd',
        'conversation_id': 'C1',
        'share_url': 'https://masky.ai/c-26-10-abcd',
        'live_url': CONVERSATION['liveUrl'],
    }
    assert d._conversations['c-26-10-abcd']['conversation_id'] == 'C1'
    assert 'viewerToken' not in json.dumps(out) and 'tok' not in out.values()


def test_create_conversation_owner_falls_back_to_public_and_errors():
    client = FakeClient(
        list_avatars={'avatars': [], 'owner': {}}, list_public_avatars=[{'avatarId': 'A', 'avatarOwnerUserId': 'P'}]
    )
    _run(_driver(client), 'create_conversation', avatar_id='A')
    assert client.args_of('create_conversation') == [('P', 'A')]
    client = FakeClient(list_avatars={'avatars': [], 'owner': {}})
    with pytest.raises(MaskyError):
        _run(_driver(client), 'create_conversation', avatar_id='A')
    assert 'create_conversation' not in client.names()


def test_create_conversation_with_look_sets_image():
    client = FakeClient()
    _run(_driver(client), 'create_conversation', avatar_id='A', look_id='L1')
    assert client.args_of('set_conversation_image') == [('C1', LOOK_FB)]


def test_send_turn_uses_cached_conversation_and_payload():
    client = FakeClient()
    d = _driver(client)
    _run(d, 'create_conversation', avatar_id='A')
    out = _run(d, 'send_turn', slug='c-26-10-abcd', text='hi', mode='speak', output='audio')
    assert client.args_of('send_turn') == [('C1', {'userText': 'hi', 'mode': 'speak', 'output': 'audio'})]
    assert 'get_conversation' not in client.names()
    assert out['turn_id'] == 'T1' and out['status'] == 'running' and out['user_text'] == 'hi'
    assert out['conversation_slug'] == 'c-26-10-abcd' and out['estimated_credits'] == 0.0025


def test_send_turn_defaults_chat_audio_and_conversation_id():
    client = FakeClient()
    out = _run(_driver(client), 'send_turn', conversation_id='C7', text='hi')
    assert client.args_of('send_turn') == [('C7', {'userText': 'hi', 'mode': 'chat', 'output': 'audio'})]
    assert out['estimated_credits'] == 0.0505


def test_send_turn_unknown_slug_fetches_conversation():
    client = FakeClient(get_conversation={'conversationId': 'C9', 'turns': []})
    d = _driver(client)
    _run(d, 'send_turn', slug='c-other', text='hi')
    assert client.args_of('get_conversation') == [('c-other',)]
    assert client.args_of('send_turn')[0][0] == 'C9'
    _run(d, 'send_turn', slug='c-other', text='again')
    assert client.names().count('get_conversation') == 1  # cached after first lookup


def test_send_turn_no_id_in_conversation_errors():
    client = FakeClient(get_conversation={'turns': []})
    with pytest.raises(MaskyError):
        _run(_driver(client), 'send_turn', slug='c-x', text='hi')
    assert 'send_turn' not in client.names()


def test_send_turn_wait_for_agent(clock):
    done = {
        'turns': [
            {
                'id': 'T1',
                'createdAt': 1,
                'status': 'audio',
                'output': 'audio',
                'avatarText': 'hello!',
                'audioUrl': AUDIO_URL,
            }
        ]
    }
    pending = {'turns': [{'id': 'T1', 'createdAt': 1, 'status': 'pending'}]}
    client = FakeClient(get_conversation=[pending, done])
    d = _driver(client, settings={'timeout_sec': 30, 'poll_interval_sec': 2})
    out = _run(d, 'send_turn', slug='c-s', conversation_id='C1', text='hi', wait_for_agent=True)
    assert out['status'] == 'done' and out['avatar_text'] == 'hello!' and out['media']['url'] == AUDIO_URL
    assert 'warnings' not in out


def test_send_turn_wait_for_agent_timeout(clock):
    client = FakeClient(get_conversation={'turns': [{'id': 'T1', 'createdAt': 1, 'status': 'pending'}]})
    d = _driver(client, settings={'timeout_sec': 3, 'poll_interval_sec': 1})
    out = _run(d, 'send_turn', slug='c-s', conversation_id='C1', text='hi', wait_for_agent=True)
    assert out['status'] == 'running' and 'Still rendering after 3 s' in out['warnings'][0]


TURNS = {
    'turns': [
        {'id': 't3', 'createdAt': 3000, 'status': 'audio', 'audioUrl': AUDIO_URL},
        {'id': 't1', 'createdAt': 1000, 'status': 'audio', 'audioUrl': AUDIO_URL},
        {'id': 't2', 'createdAt': 2000, 'status': 'pending'},
    ]
}


def _turn_ids(out):
    return [t['turn_id'] for t in out['turns']]


def test_get_turns_sorted_oldest_first():
    out = _run(_driver(FakeClient(get_conversation=TURNS)), 'get_turns', slug='c-1')
    assert _turn_ids(out) == ['t1', 't2', 't3'] and out['count'] == 3 and out['conversation_slug'] == 'c-1'
    assert [t['status'] for t in out['turns']] == ['done', 'running', 'done']


def test_get_turns_since_turn_id_and_epoch():
    d = _driver(FakeClient(get_conversation=TURNS))
    assert _turn_ids(_run(d, 'get_turns', slug='c-1', since='t1')) == ['t2', 't3']
    assert _turn_ids(_run(d, 'get_turns', slug='c-1', since='t3')) == []
    assert _turn_ids(_run(d, 'get_turns', slug='c-1', since=1000)) == ['t2', 't3']
    assert _turn_ids(_run(d, 'get_turns', slug='c-1', since=2000)) == ['t3']
    assert _turn_ids(_run(d, 'get_turns', slug='c-1', since='unknown')) == ['t1', 't2', 't3']


def test_get_turns_limit_keeps_newest():
    d = _driver(FakeClient(get_conversation=TURNS))
    assert _turn_ids(_run(d, 'get_turns', slug='c-1', limit=1)) == ['t3']
    assert _turn_ids(_run(d, 'get_turns', slug='c-1', limit=2)) == ['t2', 't3']
    assert _turn_ids(_run(d, 'get_turns', slug='c-1', since='t1', limit=1)) == ['t3']


def test_get_turns_nested_conversation_shape():
    d = _driver(FakeClient(get_conversation={'conversation': {'turns': TURNS['turns']}}))
    assert _run(d, 'get_turns', slug='c-1')['count'] == 3


def test_set_conversation_look_resolves_and_calls_client():
    client = FakeClient()
    d = _driver(client)
    _run(d, 'create_conversation', avatar_id='A')
    out = _run(d, 'set_conversation_look', slug='c-26-10-abcd', look_id='L1')
    assert out['ok'] is True
    assert client.args_of('list_images')[-1] == ('A', 'U')
    assert client.args_of('set_conversation_image') == [('C1', LOOK_FB)]


def test_set_conversation_look_by_url_and_unknown_look():
    client = FakeClient()
    d = _driver(client)
    _run(d, 'set_conversation_look', conversation_id='C5', avatar_id='A', look_url=LOOK_LH)
    assert client.args_of('set_conversation_image') == [('C5', LOOK_LH)]
    with pytest.raises(MaskyError):
        _run(d, 'set_conversation_look', conversation_id='C5', avatar_id='A', look_id='nope')
    assert len(client.args_of('set_conversation_image')) == 1


def test_set_conversation_look_needs_avatar_when_unknown():
    client = FakeClient()
    with pytest.raises(MaskyError):
        _run(_driver(client), 'set_conversation_look', conversation_id='C5', look_id='L1')
    assert 'set_conversation_image' not in client.names()


# ---------------------------------------------------------------------------
# 11. Agent binding
# ---------------------------------------------------------------------------

PUB = 'ab' * 32


def test_bind_agent_maps_fields():
    client = FakeClient()
    out = _run(
        _driver(client),
        'bind_agent',
        avatar_id='A',
        pubkey=PUB,
        relay='wss://relay.example',
        timeout_sec=60,
        fallback='fail',
        enabled=False,
        extra_tags=[['t', 'support']],
    )
    assert client.args_of('put_binding') == [
        (
            'A',
            {
                'pubkey': PUB,
                'relay': 'wss://relay.example',
                'timeoutSec': 60,
                'fallback': 'fail',
                'enabled': False,
                'extraTags': [['t', 'support']],
            },
        )
    ]
    assert out == {'avatar_id': 'A', 'agent_binding': {'pubkey': 'p'}}


def test_bind_agent_minimal_body_omits_optionals():
    client = FakeClient()
    _run(_driver(client), 'bind_agent', avatar_id='A', pubkey=PUB, relay='WSS://relay.example')
    assert client.args_of('put_binding') == [('A', {'pubkey': PUB, 'relay': 'WSS://relay.example'})]


def test_get_binding_and_unbind_pass_through():
    client = FakeClient(get_binding={'avatarId': 'A', 'agentBinding': {'relay': 'wss://r'}})
    d = _driver(client, settings={'allow_delete': True})
    assert _run(d, 'get_binding', avatar_id='A') == {'avatar_id': 'A', 'agent_binding': {'relay': 'wss://r'}}
    assert _run(d, 'unbind_agent', avatar_id='A') == {'avatar_id': 'A', 'agent_binding': None}
    assert client.names() == ['get_binding', 'delete_binding']
    assert client.args_of('delete_binding') == [('A',)]


# ---------------------------------------------------------------------------
# Remaining tools: smoke and request shaping
# ---------------------------------------------------------------------------


def test_generate_video_body_with_speech_and_look():
    client = FakeClient()
    _run(
        _driver(client, settings={'allow_public_sharing': True}),
        'generate_video',
        prompt='p',
        avatar_id='A',
        look_id='L1',
        speech_text='x' * 24,
        duration_sec=9,
        resolution='1080p',
        draft=False,
        fps=48,
        aspect_ratio='9:16',
        share='public',
        silent=True,
        seed=0,
    )
    (body,) = client.args_of('generate_video')[0]
    assert body['avatarId'] == 'A' and body['image'] == LOOK_FB and body['speechText'] == 'x' * 24
    assert 'duration' not in body and 'audio' not in body
    assert (body['resolution'], body['draft'], body['fps'], body['aspectRatio']) == ('1080p', False, 48, '9:16')
    assert (body['visibility'], body['saveAudio'], body['seed']) == ('public', False, 0)


def test_generate_video_plain_uses_defaults_and_duration():
    client = FakeClient()
    r = _run(_driver(client), 'generate_video', prompt='p')
    (body,) = client.args_of('generate_video')[0]
    assert body['duration'] == 5 and body['resolution'] == '720p' and body['draft'] is True
    assert 'avatarId' not in body and r['estimated_credits'] == 0.077 and r['status'] == 'queued'


def test_generate_video_audio_url_sets_audio_not_duration():
    client = FakeClient()
    _run(_driver(client), 'generate_video', prompt='p', audio_url='https://a/x.mp3')
    (body,) = client.args_of('generate_video')[0]
    assert body['audio'] == 'https://a/x.mp3' and 'duration' not in body


def test_create_avatar_body_and_result():
    client = FakeClient(create_avatar={'avatar': {'avatarId': 'N1', 'displayName': 'Nova', 'voiceId': 'v2'}})
    out = _run(
        _driver(client),
        'create_avatar',
        name=' Nova ',
        image_url='https://i/x.png',
        personality='kind',
        voice_id='v2',
        knowledge_urls=[' https://k/1 '],
    )
    assert client.args_of('create_avatar') == [
        (
            {
                'displayName': 'Nova',
                'imageUrl': 'https://i/x.png',
                'personalityPrompt': 'kind',
                'voiceId': 'v2',
                'knowledgeBaseUrls': ['https://k/1'],
            },
        )
    ]
    assert out == {'avatar_id': 'N1', 'name': 'Nova', 'voice_id': 'v2', 'public': False}


def test_train_set_voice_add_look_and_stream_identity():
    client = FakeClient(
        add_image={'avatarId': 'A', 'assetId': 'L2', 'url': LOOK_FB},
        set_stream_identity={'streamIdentity': {'avatarId': 'A', 'imageUrl': LOOK_FB}},
    )
    d = _driver(client)
    assert _run(d, 'train_avatar', avatar_id='A')['status'] == 'requested'
    assert _run(d, 'set_avatar_voice', avatar_id='A', voice_id='v1')['ok'] is True
    assert _run(d, 'add_look', avatar_id='A', image_url='https://i/x.png')['look_id'] == 'L2'
    out = _run(d, 'set_stream_identity', avatar_id='A', look_id='L1')
    assert client.args_of('set_stream_identity') == [('A', LOOK_FB)]
    assert out['stream_identity']['avatar_id'] == 'A'
    assert _run(_driver(FakeClient(get_stream_identity={'streamIdentity': None})), 'get_stream_identity') == {
        'stream_identity': None
    }


def test_get_avatar_by_id_includes_looks():
    out = _run(_driver(FakeClient()), 'get_avatar', avatar_id='A')
    assert out['avatar_id'] == 'A' and out['own'] is True
    assert [x['look_id'] for x in out['looks']] == [core.look_id_for(LOOK_LH), 'L1']


def test_get_avatar_not_found():
    with pytest.raises(MaskyError):
        _run(_driver(FakeClient()), 'get_avatar', avatar_id='ZZ')


@pytest.mark.parametrize('key', ['avatar_id', 'handle', 'twitch_name'])
def test_get_avatar_refuses_a_non_string_id(key):
    _refused(_driver(FakeClient()), 'get_avatar', f'"{key}" must be a string', **{key: 123})


def test_speak_handle_resolves_via_lookup():
    client = FakeClient(
        lookup={'found': True, 'owner': {'userId': 'U'}, 'avatars': [{'avatarId': 'H1', 'avatarOwnerUserId': 'U2'}]}
    )
    _run(_driver(client), 'speak', avatar_id='@bob', text='hi')
    avatar, body = client.args_of('speak')[0]
    assert avatar == 'H1' and body['avatarOwnerUserId'] == 'U2'
    assert client.args_of('lookup') == [('bob',)]


def test_close_closes_client():
    client = FakeClient()
    _driver(client).close()
    assert client.closed is True


# ---------------------------------------------------------------------------
# Regressions: look ids use Masky's assetId everywhere; URL fields reject non-strings
# ---------------------------------------------------------------------------


def test_stream_identity_reports_asset_look_id():
    fc = FakeClient(get_stream_identity={'streamIdentity': {'avatarId': 'A', 'imageUrl': LOOK_FB, 'displayName': 'Me'}})
    out = _run(_driver(fc), 'get_stream_identity')
    assert out['stream_identity']['look_id'] == 'L1'


def test_set_conversation_look_returns_asset_look_id():
    d = _driver(FakeClient())
    slug = _run(d, 'create_conversation', avatar_id='A')['conversation_slug']
    out = _run(d, 'set_conversation_look', slug=slug, look_id='L1')
    assert out == {'ok': True, 'look_id': 'L1'}


@pytest.mark.parametrize('field', ['image_url', 'audio_url', 'look_url'])
def test_non_string_url_fields_are_rejected(field):
    fc = FakeClient()
    args = {'prompt': 'p', 'avatar_id': 'A', field: 5}
    with pytest.raises(ValueError, match=f'"{field}" must be a string'):
        _run(_driver(fc), 'generate_video', **args)
    assert fc.calls == []


# ---------------------------------------------------------------------------
# Public job methods used by the pipeline lanes
# ---------------------------------------------------------------------------


def test_live_conversation_creates_once_across_calls():
    client = FakeClient()
    d = _driver(client, settings={'default_avatar': 'A'})
    first = d.live_conversation('')
    assert d.live_conversation('') == first and d.live_conversation() == first
    assert client.names().count('create_conversation') == 1
    assert first['conversation_slug'] == 'c-26-10-abcd' and first['conversation_id'] == 'C1'


def test_live_conversation_creates_once_across_threads():
    import threading

    client = FakeClient()
    d = _driver(client, settings={'default_avatar': 'A'})
    results, errors = [], []
    barrier = threading.Barrier(3)

    def work():
        try:
            barrier.wait()
            results.append(d.live_conversation(''))
        except Exception as e:  # pragma: no cover
            errors.append(e)

    threads = [threading.Thread(target=work) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors and len(results) == 3
    assert results[0] == results[1] == results[2]
    assert client.names().count('create_conversation') == 1


def test_live_conversation_with_slug_resolves_without_creating():
    client = FakeClient(
        get_conversation={'conversationId': 'C9', 'shareUrl': 'https://masky.ai/c-26-10-abcd', 'turns': []}
    )
    d = _driver(client)
    out = d.live_conversation('c-26-10-abcd')
    assert out['conversation_id'] == 'C9' and out['conversation_slug'] == 'c-26-10-abcd'
    assert out['share_url'] == 'https://masky.ai/c-26-10-abcd'
    assert 'create_conversation' not in client.names()
    assert client.args_of('get_conversation') == [('c-26-10-abcd',)]
    d.live_conversation('c-26-10-abcd')
    assert client.names().count('get_conversation') == 1


def test_conversation_job_returns_live_url():
    out = _driver(FakeClient()).conversation_job(avatar='A')
    assert out == {
        'conversation_slug': 'c-26-10-abcd',
        'conversation_id': 'C1',
        'share_url': 'https://masky.ai/c-26-10-abcd',
        'live_url': 'https://masky.ai/live/c-26-10-abcd?token=tok',
    }


def test_create_conversation_tool_hides_live_url_without_media_urls():
    d = _driver(FakeClient(), include_media_urls=False)
    out = _run(d, 'create_conversation', avatar_id='A')
    assert 'live_url' not in out and out['conversation_slug'] == 'c-26-10-abcd'
    assert _run(_driver(FakeClient()), 'create_conversation', avatar_id='A')['live_url']


def test_turn_job_include_urls_flag():
    turn = {
        'turn': {
            'id': 'T1',
            'role': 'user',
            'userText': 'hi',
            'output': 'audio',
            'status': 'audio',
            'audioUrl': AUDIO_URL,
        }
    }
    kw = dict(conversation_id='C1', slug='c-1', text='hi', mode='chat', output='audio', wait=False)
    out = _driver(FakeClient(send_turn=turn)).turn_job(include_urls=False, **kw)
    assert 'url' not in out['media'] and 'url_expires_at' not in out['media']
    assert out['status'] == 'done' and out['turn_id'] == 'T1' and out['conversation_slug'] == 'c-1'
    assert out['estimated_credits'] > 0
    shown = _driver(FakeClient(send_turn=turn)).turn_job(**kw)
    assert shown['media']['url'] == AUDIO_URL


def test_send_turn_over_cap_makes_no_client_call_even_for_unknown_slug():
    client = FakeClient()
    d = _driver(client, settings={'max_credits_per_call': 0.0001})
    with pytest.raises(MaskyError):
        _run(d, 'send_turn', slug='c-unknown', text='hi', mode='speak')
    assert client.calls == []


def _video(d, **kw):
    kw.setdefault('resolution', '720p')
    kw.setdefault('draft', True)
    kw.setdefault('wait', False)
    return d.video_job(prompt='a fox', **kw)


def test_video_job_speech_without_avatar_fails_before_client_call():
    client = FakeClient()
    with pytest.raises(MaskyError, match='needs an avatar'):
        _video(_driver(client), speech_text='hello')
    assert client.calls == []


def test_video_job_speech_with_default_avatar():
    client = FakeClient()
    _video(_driver(client, settings={'default_avatar': 'A'}), speech_text='hello')
    body = client.args_of('generate_video')[0][0]
    assert body['avatarId'] == 'A' and body['speechText'] == 'hello'
    assert 'duration' not in body and 'audio' not in body


def test_video_job_audio_url_has_no_duration():
    client = FakeClient()
    _video(_driver(client), audio_url='https://a/x.mp3')
    body = client.args_of('generate_video')[0][0]
    assert body['audio'] == 'https://a/x.mp3' and 'duration' not in body and 'speechText' not in body


def test_video_job_image_url_and_duration_default():
    client = FakeClient()
    _video(_driver(client), image_url='https://i/x.png')
    body = client.args_of('generate_video')[0][0]
    assert body['image'] == 'https://i/x.png' and body['duration'] == 5
    assert body['resolution'] == '720p' and body['draft'] is True and body['prompt'] == 'a fox'
    assert 'avatarId' not in body


def test_video_job_silent_controls_save_audio():
    client = FakeClient()
    d = _driver(client)
    _video(d, silent=True)
    _video(d, silent=False)
    _video(d)
    bodies = [a[0] for a in client.args_of('generate_video')]
    assert [b['saveAudio'] for b in bodies] == [False, True, True]


def test_video_job_wait_returns_ready_receipt(clock):
    client = FakeClient()
    receipt = _video(_driver(client), wait=True)
    assert receipt['status'] == 'done' and 'get_video' in client.names()


def test_turn_receipt_never_passes_on_maskys_zero_credit_cost():
    # Masky charges every rendered turn, but its turn record shows creditCost 0 (a Masky bug,
    # confirmed 2026-10-22): the receipt must say "unknown" (null), never 0.
    d = _driver(FakeClient())
    shaped = d._shape_turn({'id': 'T1', 'status': 'audio', 'output': 'audio', 'creditCost': 0}, 'audio')
    assert shaped['credits_charged'] is None and shaped['status'] == 'done'
    missing = d._shape_turn({'id': 'T2', 'status': 'audio', 'output': 'audio'}, 'audio')
    assert missing['credits_charged'] is None


def test_turn_receipt_passes_on_a_real_charge_once_masky_reports_it():
    d = _driver(FakeClient())
    shaped = d._shape_turn({'id': 'T1', 'status': 'audio', 'output': 'audio', 'creditCost': 0.004}, 'audio')
    assert shaped['credits_charged'] == 0.004


# ---------------------------------------------------------------------------
# Phase 5: new tools and options
# ---------------------------------------------------------------------------

PRICING = {
    'perSecond': {'720p': {'full': 0.04, 'draft': 0.02}, '1080p': {'full': 0.08, 'draft': 0.05}},
    'audioPerSecond': 0.003,
}


def _refused(d, tool, match=None, **args):
    """The call must raise before any client traffic."""
    with pytest.raises((ValueError, TypeError, MaskyError)) as ei:
        _run(d, tool, **args)
    if match:
        assert match in str(ei.value)
    assert d._client.calls == []
    assert d._client.pricing_calls == 0
    return ei


def test_set_avatar_public_happy_path_and_refuses_string_bools():
    client = FakeClient()
    d = _driver(client, settings={'allow_public_sharing': True})
    assert _run(d, 'set_avatar_public', avatar_id=' A ', public=True) == {'avatar_id': 'A', 'public': True}
    assert _run(d, 'set_avatar_public', avatar_id='A', public=False) == {'avatar_id': 'A', 'public': False}
    assert client.args_of('set_avatar_public') == [('A', True), ('A', False)]
    for bad in ('true', 'false'):
        with pytest.raises(ValueError, match='"public" must be a boolean'):
            _run(d, 'set_avatar_public', avatar_id='A', public=bad)
    assert len(client.calls) == 2


def test_set_avatar_public_validation_before_any_call():
    d = _driver(FakeClient())
    _refused(d, 'set_avatar_public', '"public" is required', avatar_id='A')
    _refused(d, 'set_avatar_public', 'avatar_id', public=True)
    _refused(d, 'set_avatar_public', '"public" must be a boolean', avatar_id='A', public='maybe')


def test_set_conversation_visibility_by_id_and_by_slug_refuses_string_bools():
    client = FakeClient(get_conversation={'conversationId': 'C9', 'turns': []})
    d = _driver(client, settings={'allow_public_sharing': True})
    assert _run(d, 'set_conversation_visibility', conversation_id='C1', public=True) == {
        'conversation_slug': None,
        'conversation_id': 'C1',
        'public': True,
    }
    assert client.names() == ['set_conversation_visibility']
    out = _run(d, 'set_conversation_visibility', slug='c-1', public=False)
    assert out == {'conversation_slug': 'c-1', 'conversation_id': 'C9', 'public': False}
    assert client.args_of('set_conversation_visibility') == [('C1', True), ('C9', False)]
    assert client.args_of('get_conversation') == [('c-1',)]
    with pytest.raises(ValueError, match='"public" must be a boolean'):
        _run(d, 'set_conversation_visibility', conversation_id='C1', public='false')
    assert len(client.calls) == 3


def test_set_conversation_visibility_validation_before_any_call():
    d = _driver(FakeClient())
    _refused(d, 'set_conversation_visibility', '"public" is required', slug='c-1')
    _refused(d, 'set_conversation_visibility', 'slug or conversation_id', public=True)
    _refused(d, 'set_conversation_visibility', '"public" must be a boolean', slug='c-1', public='sure')


def test_create_avatar_public_flag():
    client = FakeClient(create_avatar={'avatar': {'avatarId': 'N1', 'displayName': 'Nova', 'publiclyRenderable': True}})
    out = _run(
        _driver(client, settings={'allow_public_sharing': True}),
        'create_avatar',
        name='Nova',
        image_url='https://i/x.png',
        public=True,
    )
    (body,) = client.args_of('create_avatar')[0]
    assert body['publiclyRenderable'] is True
    assert out['public'] is True
    # Omitted -> no key in the body.
    client2 = FakeClient()
    _run(_driver(client2), 'create_avatar', name='Nova', image_url='https://i/x.png')
    assert 'publiclyRenderable' not in client2.args_of('create_avatar')[0][0]
    _refused(_driver(FakeClient()), 'create_avatar', name='Nova', image_url='https://i/x.png', public=5)
    _refused(
        _driver(FakeClient(), settings={'allow_public_sharing': True}),
        'create_avatar',
        '"public" must be a boolean',
        name='Nova',
        image_url='https://i/x.png',
        public='true',
    )


def test_edit_image_single_source_uses_image_url():
    client = FakeClient()
    _run(_driver(client), 'edit_image', prompt='p', image_url='https://i/a.png')
    (body,) = client.args_of('edit_image')[0]
    assert body['imageUrl'] == 'https://i/a.png' and 'images' not in body
    # images list of one behaves the same, and duplicates collapse.
    client = FakeClient()
    _run(_driver(client), 'edit_image', prompt='p', image_url='https://i/a.png', images=['https://i/a.png'])
    (body,) = client.args_of('edit_image')[0]
    assert body['imageUrl'] == 'https://i/a.png' and 'images' not in body


def test_edit_image_several_sources_use_images_list():
    client = FakeClient()
    _run(
        _driver(client),
        'edit_image',
        prompt='p',
        image_url='https://i/a.png',
        images=['https://i/b.png', 'https://i/a.png', 'https://i/c.png'],
    )
    (body,) = client.args_of('edit_image')[0]
    assert body['images'] == ['https://i/a.png', 'https://i/b.png', 'https://i/c.png']
    assert 'imageUrl' not in body
    client = FakeClient()
    _run(_driver(client), 'edit_image', prompt='p', images=['https://i/a.png', 'https://i/b.png'])
    (body,) = client.args_of('edit_image')[0]
    assert body['images'] == ['https://i/a.png', 'https://i/b.png'] and 'imageUrl' not in body


def test_edit_image_validation_before_any_call():
    d = _driver(FakeClient())
    _refused(d, 'edit_image', 'image_url or images is required', prompt='p')
    _refused(d, 'edit_image', 'image_url or images is required', prompt='p', images=[])
    six = [f'https://i/{n}.png' for n in range(6)]
    _refused(d, 'edit_image', 'up to 5 images', prompt='p', images=six)
    _refused(d, 'edit_image', 'up to 5 images', prompt='p', image_url='https://i/x.png', images=six[:5])
    _refused(d, 'edit_image', 'http', prompt='p', images=['ftp://i/a.png'])
    _refused(d, 'edit_image', 'http', prompt='p', images=['https://i/a.png', 'data:image/png;base64,AAAA'])
    _refused(d, 'edit_image', 'list', prompt='p', images='https://i/a.png')
    _refused(d, 'edit_image', 'http', prompt='p', image_url='file:///tmp/a.png')


def test_edit_image_five_sources_is_allowed():
    client = FakeClient()
    five = [f'https://i/{n}.png' for n in range(5)]
    _run(_driver(client), 'edit_image', prompt='p', images=five)
    assert client.args_of('edit_image')[0][0]['images'] == five


def test_generate_video_last_frame_image():
    client = FakeClient()
    _run(_driver(client), 'generate_video', prompt='p', last_frame_image_url='https://i/last.png')
    (body,) = client.args_of('generate_video')[0]
    assert body['lastFrameImage'] == 'https://i/last.png'
    client = FakeClient()
    _run(_driver(client), 'generate_video', prompt='p')
    assert 'lastFrameImage' not in client.args_of('generate_video')[0][0]
    d = _driver(FakeClient())
    _refused(d, 'generate_video', 'http', prompt='p', last_frame_image_url='ftp://x/y.png')
    _refused(d, 'generate_video', 'http', prompt='p', last_frame_image_url='/local/file.png')


def test_video_job_last_frame_image_argument():
    client = FakeClient()
    _video(_driver(client), last_frame_image='https://i/last.png')
    assert client.args_of('generate_video')[0][0]['lastFrameImage'] == 'https://i/last.png'


def test_send_turn_reinterpret():
    client = FakeClient()
    d = _driver(client)
    _run(d, 'send_turn', conversation_id='C1', text='hi', mode='speak', reinterpret=True)
    assert client.args_of('send_turn')[0] == (
        'C1',
        {'userText': 'hi', 'mode': 'speak', 'output': 'audio', 'reinterpret': True},
    )
    _run(d, 'send_turn', conversation_id='C1', text='hi', mode='speak', reinterpret=False)
    _run(d, 'send_turn', conversation_id='C1', text='hi', mode='speak')
    assert all('reinterpret' not in c[1] for c in client.args_of('send_turn')[1:])
    _run(d, 'send_turn', conversation_id='C1', text='hi', mode='chat', reinterpret=False)
    assert 'reinterpret' not in client.args_of('send_turn')[-1][1]


def test_send_turn_reinterpret_refuses_string_true_and_turn_job():
    client = FakeClient()
    d = _driver(client)
    _refused(
        d,
        'send_turn',
        '"reinterpret" must be a boolean',
        conversation_id='C1',
        text='hi',
        mode='speak',
        reinterpret='true',
    )
    d.turn_job(conversation_id='C1', slug=None, text='hi', mode='speak', output='audio', wait=False, reinterpret=True)
    assert client.args_of('send_turn')[0][1]['reinterpret'] is True
    # turn_job itself drops the flag outside speak mode.
    d.turn_job(conversation_id='C1', slug=None, text='hi', mode='chat', output='audio', wait=False, reinterpret=True)
    assert 'reinterpret' not in client.args_of('send_turn')[1][1]


def test_send_turn_reinterpret_validation_before_any_call():
    d = _driver(FakeClient())
    _refused(
        d, 'send_turn', 'reinterpret only applies to mode=speak', conversation_id='C1', text='hi', reinterpret=True
    )
    _refused(
        d,
        'send_turn',
        'reinterpret only applies to mode=speak',
        conversation_id='C1',
        text='hi',
        mode='chat',
        reinterpret=True,
    )
    _refused(d, 'send_turn', '"reinterpret" must be a boolean', slug='c-1', text='hi', mode='chat', reinterpret='true')


def test_set_stream_identity_clear_refuses_string_bool():
    client = FakeClient(set_stream_identity={'streamIdentity': None})
    out = _run(_driver(client), 'set_stream_identity', clear=True)
    assert out == {'stream_identity': None}
    assert client.args_of('set_stream_identity') == [(None, None)]
    client = FakeClient(set_stream_identity={'streamIdentity': {'avatarId': 'A', 'imageUrl': LOOK_FB}})
    out = _run(_driver(client), 'set_stream_identity', clear=True)
    assert client.args_of('set_stream_identity') == [(None, None)]
    assert out['stream_identity']['avatar_id'] == 'A'
    client = FakeClient()
    _refused(_driver(client), 'set_stream_identity', '"clear" must be a boolean', clear='true')


def test_set_stream_identity_validation_before_any_call():
    d = _driver(FakeClient())
    _refused(d, 'set_stream_identity', 'avatar_id is required')
    _refused(d, 'set_stream_identity', 'avatar_id is required', clear=False)
    _refused(d, 'set_stream_identity', 'clear=true on its own', clear=True, avatar_id='A')
    _refused(d, 'set_stream_identity', 'clear=true on its own', clear=True, look_id='L1')
    _refused(d, 'set_stream_identity', 'clear=true on its own', clear=True, look_url='https://i/x.png')


def test_tool_schemas_for_phase5():
    tools = {t['name']: t['inputSchema'] for t in _driver(FakeClient())._tool_query()}
    assert tools['masky.set_stream_identity'].get('required', []) == []
    assert (
        'public' in tools['masky.set_avatar_public']['required']
        and 'avatar_id' in tools['masky.set_avatar_public']['required']
    )
    assert 'public' in tools['masky.set_conversation_visibility']['required']
    assert 'images' in tools['masky.edit_image']['properties']
    assert 'image_url' not in tools['masky.edit_image'].get('required', [])


# ---------------------------------------------------------------------------
# Live pricing: parsing, estimates, loading
# ---------------------------------------------------------------------------


def test_rates_from_pricing_real_shape():
    rates = core.rates_from_pricing(PRICING)
    assert rates == {
        'video_per_sec': {('720p', False): 0.04, ('720p', True): 0.02, ('1080p', False): 0.08, ('1080p', True): 0.05},
        'audio_per_sec': 0.003,
    }


def test_rates_from_pricing_audio_optional():
    rates = core.rates_from_pricing({'perSecond': {'720p': {'full': 0.04}}})
    assert rates == {'video_per_sec': {('720p', False): 0.04}}


@pytest.mark.parametrize(
    'bad',
    [
        None,
        [],
        'x',
        42,
        {},
        {'perSecond': None},
        {'perSecond': []},
        {'perSecond': {}},
        {'perSecond': {'720p': 'cheap'}},
        {'perSecond': {'720p': {'full': 0, 'draft': -0.1}}},
        {'perSecond': {'720p': {'full': True, 'draft': False}}},
        {'perSecond': {'720p': {'full': 'x', 'draft': None}}},
        {'audioPerSecond': 0.003},
    ],
)
def test_rates_from_pricing_bad_shapes_are_none(bad):
    assert core.rates_from_pricing(bad) is None


def test_rates_from_pricing_ignores_bool_and_negative_rates():
    rates = core.rates_from_pricing(
        {
            'perSecond': {'720p': {'full': True, 'draft': 0.02}, '1080p': {'full': -1, 'draft': 0.05}},
            'audioPerSecond': True,
        }
    )
    assert rates == {'video_per_sec': {('720p', True): 0.02, ('1080p', True): 0.05}}
    assert core.rates_from_pricing({'perSecond': {'720p': {'full': 0.04}}, 'audioPerSecond': -0.5}) == {
        'video_per_sec': {('720p', False): 0.04}
    }


def test_estimate_video_uses_live_rate_when_present():
    live = core.rates_from_pricing(PRICING)
    table = core.estimate_video(resolution='720p', draft=True, duration_sec=5)
    est = core.estimate_video(resolution='720p', draft=True, duration_sec=5, live_rates=live)
    assert 'live Masky pricing' in est['basis'] and '0.02 credits/s' in est['basis']
    assert 'live Masky pricing' not in table['basis'] and core.PRICE_TABLE_DATE in table['basis']
    assert est['credits'] == core.round_up_credits((5 + core.VIDEO_BILLING_MARGIN_SEC) * 0.02)
    assert est['credits'] != table['credits']


def test_estimate_video_missing_tier_falls_back_to_table():
    live = core.rates_from_pricing({'perSecond': {'1080p': {'full': 0.08}}})
    est = core.estimate_video(resolution='720p', draft=True, duration_sec=5, live_rates=live)
    assert est == core.estimate_video(resolution='720p', draft=True, duration_sec=5)
    assert 'live Masky pricing' not in est['basis']
    # Empty/None live rates behave like no live rates.
    assert core.estimate_video(resolution='720p', draft=True, duration_sec=5, live_rates={}) == est


def test_estimate_speak_has_no_live_rates_parameter_and_uses_the_table():
    import inspect

    assert list(inspect.signature(core.estimate_speak).parameters) == ['text', 'output', 'text_mode']
    text = 'x' * 120  # 8 billed seconds
    audio = core.estimate_speak(text, 'audio')
    assert audio['credits'] == round(8 * core.PRICES['audio_per_sec'] + 0.001, 4) == 0.013
    assert f'{core.PRICES["audio_per_sec"]} credits/s' in audio['basis']
    with pytest.raises(TypeError):
        core.estimate_speak(text, 'audio', 'literal', core.rates_from_pricing(PRICING))


def test_load_pricing_fetches_once():
    client = FakeClient(get_video_pricing=PRICING)
    d = _driver(client)
    first = d.load_pricing()
    assert d.load_pricing() is first and d.load_pricing() is first
    assert client.pricing_calls == 1
    assert first['video_per_sec'][('720p', True)] == 0.02
    assert client.calls == []


def test_load_pricing_failure_returns_none_and_estimates_use_table():
    client = FakeClient()  # default: unreachable
    d = _driver(client)
    assert d.load_pricing() is None
    assert d.load_pricing() is None
    assert client.pricing_calls == 1  # never refetches after a failure
    out = _run(d, 'estimate_cost', kind='video', resolution='720p', draft=True, duration_sec=5)
    assert 'live Masky pricing' not in out['basis'] and core.PRICE_TABLE_DATE in out['basis']
    assert out['estimated_credits'] == core.estimate_video(resolution='720p', draft=True, duration_sec=5)['credits']


@pytest.mark.parametrize('exc', [RuntimeError('boom'), ValueError('bad'), KeyError('k'), TimeoutError()])
def test_load_pricing_swallows_any_exception(exc):
    d = _driver(FakeClient(get_video_pricing=exc))
    assert d.load_pricing() is None


def test_load_pricing_unusable_body_is_none():
    client = FakeClient(get_video_pricing={'perSecond': {}})
    d = _driver(client)
    assert d.load_pricing() is None
    assert d.load_pricing() is None and client.pricing_calls == 1


def test_load_pricing_client_without_method():
    class Bare:
        calls = []

        def close(self):
            pass

    d = MaskyDriver(server_name='masky', client=Bare(), settings=None)
    assert d.load_pricing() is None
    assert d.load_pricing() is None


def test_load_pricing_concurrent_calls_fetch_once():
    client = FakeClient(get_video_pricing=PRICING)
    d = _driver(client)
    barrier = threading.Barrier(3)
    results = []

    def work():
        barrier.wait()
        results.append(d.load_pricing())

    threads = [threading.Thread(target=work) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert client.pricing_calls == 1
    assert len(results) == 3 and all(r is results[0] and r is not None for r in results)


def test_estimate_cost_uses_live_pricing():
    d = _driver(FakeClient(get_video_pricing=PRICING))
    video = _run(d, 'estimate_cost', kind='video', resolution='720p', draft=True, duration_sec=5)
    assert 'live Masky pricing' in video['basis']
    assert video['estimated_credits'] == core.round_up_credits(5.1 * 0.02)
    audio = _run(d, 'estimate_cost', kind='speak', text='x' * 120, output='audio')
    assert audio['estimated_credits'] == 0.013  # speech is never priced from the live audio rate


def test_render_uses_live_rate_in_receipt_estimate():
    client = FakeClient(get_video_pricing=PRICING)
    r = _run(_driver(client), 'generate_video', prompt='p', duration_sec=5)
    assert r['estimated_credits'] == core.round_up_credits(5.1 * 0.02)


def test_cost_guard_makes_no_client_call_when_pricing_preloaded():
    client = FakeClient(get_video_pricing=PRICING)
    d = _driver(client, settings={'max_credits_per_call': 0.05})
    assert d.load_pricing() is not None
    client.calls.clear()
    fetched = client.pricing_calls
    with pytest.raises(MaskyError) as ei:
        _run(d, 'speak', avatar_id='A', text='x' * 500)  # video speech ~ 1.1 credits
    assert 'cap' in str(ei.value)
    with pytest.raises(MaskyError):
        _run(d, 'generate_video', prompt='p', duration_sec=20, resolution='1080p', draft=False)  # 20.1 * 0.08
    assert client.calls == []
    assert client.pricing_calls == fetched


# ---------------------------------------------------------------------------
# MaskyClient.get_video_pricing (requests stubbed)
# ---------------------------------------------------------------------------


class _PriceResp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError('no json')
        return self._body


@pytest.fixture
def pricing_requests(monkeypatch):
    req = types.ModuleType('requests')
    req.RequestException = type('RequestException', (Exception,), {})
    req.Timeout = type('Timeout', (req.RequestException,), {})
    state = {'gets': [], 'resp': _PriceResp(200, PRICING), 'exc': None, 'requests': req}

    def get(url, **kw):
        state['gets'].append((url, kw))
        if state['exc']:
            raise state['exc']
        return state['resp']

    def request(*a, **k):  # any other verb would be a bug in this call path
        raise AssertionError('get_video_pricing must use requests.get')

    req.get = get
    req.request = request
    monkeypatch.setitem(sys.modules, 'requests', req)
    return state


def test_client_get_video_pricing_no_auth_header_and_timeout(pricing_requests):
    client = MaskyClient('mky_SECRET_KEY_123', base_url='https://api.example/v1/')
    assert client.get_video_pricing() == PRICING
    ((url, kw),) = pricing_requests['gets']
    assert url == 'https://api.example/v1/videos/pricing'
    assert kw['timeout'] == 5
    assert not any(k.lower() == 'authorization' for k in kw['headers'])
    assert 'mky_SECRET_KEY_123' not in json.dumps(kw, default=str)
    client.get_video_pricing(timeout=2)
    assert pricing_requests['gets'][-1][1]['timeout'] == 2


def test_client_get_video_pricing_single_attempt_on_500(pricing_requests):
    pricing_requests['resp'] = _PriceResp(500, {'error': 'x'})
    with pytest.raises(MaskyError) as ei:
        MaskyClient('k').get_video_pricing()
    assert '500' in str(ei.value)
    assert len(pricing_requests['gets']) == 1  # no retries


def test_client_get_video_pricing_non_json(pricing_requests):
    pricing_requests['resp'] = _PriceResp(200, None)
    with pytest.raises(MaskyError) as ei:
        MaskyClient('k').get_video_pricing()
    assert 'non-JSON' in str(ei.value)


@pytest.mark.parametrize('which', ['RequestException', 'Timeout'])
def test_client_get_video_pricing_request_exception(pricing_requests, which):
    pricing_requests['exc'] = getattr(pricing_requests['requests'], which)('https://secret.example/boom')
    with pytest.raises(MaskyError) as ei:
        MaskyClient('mky_SECRET_KEY_123').get_video_pricing()
    assert 'secret.example' not in str(ei.value) and 'mky_SECRET' not in str(ei.value)
    assert len(pricing_requests['gets']) == 1


@pytest.mark.parametrize(
    ('tool', 'args'),
    [
        ('create_avatar', {'name': 'n', 'image_url': 'https://i/x.png', 'public': 'maybe'}),
        ('send_turn', {'slug': 'c-1', 'text': 'hi', 'mode': 'speak', 'reinterpret': 'nope'}),
        ('list_avatars', {'include_public': 'sometimes'}),
        ('speak', {'text': 'hi', 'avatar_id': 'A', 'wait_for_completion': 2}),
    ],
)
def test_optional_booleans_reject_non_bool_values(tool, args):
    fc = FakeClient()
    with pytest.raises(ValueError, match='must be a boolean'):
        _run(_driver(fc), tool, **args)
    assert fc.calls == []


# ---------------------------------------------------------------------------
# Code-review regression tests (F1-F15)
# ---------------------------------------------------------------------------

TABLE_720_DRAFT = core.estimate_video(resolution='720p', draft=True, duration_sec=5)  # 0.077


def test_estimate_video_table_value_is_what_the_cap_tests_assume():
    assert TABLE_720_DRAFT['credits'] == 0.077


def test_estimate_video_live_below_table_uses_table_and_says_so():
    live = {'video_per_sec': {('720p', True): 0.001}}
    est = core.estimate_video(resolution='720p', draft=True, duration_sec=5, live_rates=live)
    assert est == TABLE_720_DRAFT
    assert 'live Masky pricing' not in est['basis'] and core.PRICE_TABLE_DATE in est['basis']


def test_estimate_video_live_equal_or_above_table_names_live_pricing():
    table_rate = core.PRICES['video_per_sec'][('720p', True)]
    equal = core.estimate_video(
        resolution='720p', draft=True, duration_sec=5, live_rates={'video_per_sec': {('720p', True): table_rate}}
    )
    assert 'live Masky pricing' in equal['basis'] and equal['credits'] == TABLE_720_DRAFT['credits']
    above = core.estimate_video(
        resolution='720p', draft=True, duration_sec=5, live_rates={'video_per_sec': {('720p', True): 0.03}}
    )
    assert 'live Masky pricing' in above['basis'] and above['credits'] == core.round_up_credits(5.1 * 0.03)
    assert above['credits'] > TABLE_720_DRAFT['credits']


@pytest.mark.parametrize('bad', [1e-9, 0, 0.0, -1, -0.5, None])
def test_estimate_video_poisoned_live_rate_never_lowers_the_estimate(bad):
    est = core.estimate_video(
        resolution='720p', draft=True, duration_sec=5, live_rates={'video_per_sec': {('720p', True): bad}}
    )
    assert est['credits'] >= TABLE_720_DRAFT['credits']
    assert est == TABLE_720_DRAFT


@pytest.mark.parametrize('bad', [1e-9, 0, -1, -0.5, True, False, float('nan'), 'cheap', None, [], {}])
def test_poisoned_pricing_body_never_lowers_an_estimate_below_the_table(bad):
    body = {
        'perSecond': {'720p': {'full': bad, 'draft': bad}, '1080p': {'full': bad, 'draft': bad}},
        'audioPerSecond': bad,
    }
    live = core.rates_from_pricing(body)
    for res, draft in (('720p', True), ('720p', False), ('1080p', True), ('1080p', False)):
        table = core.estimate_video(resolution=res, draft=draft, duration_sec=5)
        est = core.estimate_video(resolution=res, draft=draft, duration_sec=5, live_rates=live)
        # A rate that survives parsing (True counts as 1) can only raise the estimate.
        assert est['credits'] >= table['credits']


@pytest.mark.parametrize('bad', [1e-9, 0, -1, True, float('nan')])
def test_driver_poisoned_live_pricing_keeps_estimates_and_the_cap_at_the_table(bad):
    body = {'perSecond': {'720p': {'full': bad, 'draft': bad}}, 'audioPerSecond': bad}
    client = FakeClient(get_video_pricing=body)
    d = _driver(client, settings={'max_credits_per_call': 0.07})
    out = _run(d, 'estimate_cost', kind='video', duration_sec=5)
    assert out['estimated_credits'] >= 0.077 and out['within_cap'] is False
    with pytest.raises(MaskyError, match='cap'):
        _run(d, 'generate_video', prompt='p', duration_sec=5)
    assert client.calls == []


def test_cap_with_a_realistic_value_refuses_a_5s_720p_draft_video():
    client = FakeClient()
    d = _driver(client, settings={'max_credits_per_call': 0.07})
    out = _run(d, 'estimate_cost', kind='video', duration_sec=5)
    assert out['estimated_credits'] == 0.077 and out['within_cap'] is False
    with pytest.raises(MaskyError, match='cap'):
        _run(d, 'generate_video', prompt='p', duration_sec=5)
    assert client.calls == []
    # The exact estimate is allowed through (equal to the cap is allowed).
    ok = _driver(client, settings={'max_credits_per_call': 0.077})
    _run(ok, 'generate_video', prompt='p', duration_sec=5)
    assert client.names() == ['generate_video']


def test_estimate_speak_personality_assumes_500_chars_and_is_unverified():
    assert core.CHAT_REPLY_CHARS == 500
    lit = core.estimate_speak('hi', 'audio')
    per = core.estimate_speak('hi', 'audio', 'personality')
    assert lit['credits'] == 0.0025 and lit['verified'] is True
    assert per['credits'] == 0.0505 and per['verified'] is False  # 500 chars -> 33 s
    assert per['assumed_rewrite'] is True
    assert core.estimate_speak('hi', 'video', 'personality')['credits'] == 0.8755
    long = core.estimate_speak('x' * 600, 'audio', 'personality')
    assert long['credits'] == round(40 * 0.0015 + 0.001, 4)  # never below the text length
    assert core.estimate_speak('x' * 24, 'audio', 'literal') == core.estimate_speak('x' * 24, 'audio')


def test_estimate_turn_reinterpret_and_chat_assume_reply_length_plain_speak_does_not():
    assert core.estimate_turn('hi', mode='speak', output='audio')['credits'] == 0.0025
    assert core.estimate_turn('hi', mode='speak', output='audio', reinterpret=True)['credits'] == 0.0505
    assert core.estimate_turn('hi', mode='chat', output='audio')['credits'] == 0.0505
    assert core.estimate_turn('hi', mode='chat', output='audio', reinterpret=True)['credits'] == 0.0505
    # the assumption is a floor, never below the text itself
    assert core.estimate_turn('x' * 600, mode='speak', output='audio', reinterpret=True)['credits'] == round(
        40 * 0.0015 + 0.001, 4
    )  # 600 chars -> 40 s
    assert core.estimate_turn('x' * 600, mode='speak', output='audio')['credits'] == round(
        40 * 0.0015 + 0.001, 4
    )  # 600 chars -> 40 s
    # Masky's formula is confirmed: only the assumed-length cases (chat, reinterpret) are unverified.
    for m, r in (('chat', False), ('chat', True), ('speak', True)):
        assert core.estimate_turn('hi', mode=m, output='audio', reinterpret=r)['verified'] is False
    assert core.estimate_turn('hi', mode='speak', output='audio')['verified'] is True


def test_estimate_cost_accepts_text_mode_and_reinterpret():
    d = _driver(FakeClient())
    assert _run(d, 'estimate_cost', kind='speak', text='hi', output='audio')['estimated_credits'] == 0.0025
    personality = _run(d, 'estimate_cost', kind='speak', text='hi', output='audio', text_mode='personality')
    assert personality['estimated_credits'] == 0.0505 and personality['verified'] is False
    assert _run(d, 'estimate_cost', kind='turn', text='hi', mode='speak')['estimated_credits'] == 0.0025
    assert (
        _run(d, 'estimate_cost', kind='turn', text='hi', mode='speak', reinterpret=True)['estimated_credits'] == 0.0505
    )


def test_speak_job_passes_text_mode_to_the_estimate_and_the_cap():
    client = FakeClient()
    d = _driver(client, settings={'max_credits_per_call': 0.5})
    with pytest.raises(MaskyError, match='cap'):
        _run(d, 'speak', avatar_id='A', text='hi', output='video', text_mode='personality')  # 0.8755 assumed
    assert client.calls == []
    out = _run(d, 'speak', avatar_id='A', text='hi', output='video', text_mode='literal')  # 0.054
    assert client.args_of('speak')[0][1]['textMode'] == 'literal'
    assert out['estimated_credits'] <= 0.5
    # personality is the estimate recorded on the receipt too, when the cap allows it
    big = _driver(FakeClient(), settings={'max_credits_per_call': 2})
    assert (
        _run(big, 'speak', avatar_id='A', text='hi', output='video', text_mode='personality')['estimated_credits']
        == 0.8755
    )


def test_send_turn_precheck_includes_reinterpret():
    client = FakeClient()
    d = _driver(client, settings={'max_credits_per_call': 0.05})
    with pytest.raises(MaskyError, match='cap'):
        _run(d, 'send_turn', conversation_id='C1', text='hi', mode='speak', reinterpret=True)  # 0.063 > 0.05
    assert client.calls == []
    _run(d, 'send_turn', conversation_id='C1', text='hi', mode='speak')  # 0.002
    assert client.names() == ['send_turn']
    assert client.args_of('send_turn')[0][1] == {'userText': 'hi', 'mode': 'speak', 'output': 'audio'}


def test_send_turn_conversation_id_only_uses_cached_slug_so_waiting_works(clock):
    done = {
        'turns': [
            {
                'id': 'T1',
                'createdAt': 1,
                'status': 'audio',
                'output': 'audio',
                'avatarText': 'hello!',
                'audioUrl': AUDIO_URL,
            }
        ]
    }
    client = FakeClient(get_conversation=done)
    d = _driver(client, settings={'timeout_sec': 30, 'poll_interval_sec': 2})
    _run(d, 'create_conversation', avatar_id='A')  # caches C1 <-> c-26-10-abcd
    out = _run(d, 'send_turn', conversation_id='C1', text='hi', wait_for_agent=True)
    assert out['conversation_slug'] == 'c-26-10-abcd'
    assert out['status'] == 'done' and out['avatar_text'] == 'hello!'
    assert 'warnings' not in out
    assert client.args_of('get_conversation') == [('c-26-10-abcd',)]


def test_send_turn_unknown_conversation_id_cannot_wait_and_says_so():
    client = FakeClient()
    out = _run(_driver(client), 'send_turn', conversation_id='C7', text='hi', wait_for_agent=True)
    assert out['conversation_slug'] is None
    assert any('Not waited for' in w for w in out['warnings'])
    assert 'get_conversation' not in client.names()
    quiet = _run(_driver(FakeClient()), 'send_turn', conversation_id='C7', text='hi')
    assert 'warnings' not in quiet


SETTINGS_THAT_MUST_NOT_LEAK = {
    'quality': '1080p',
    'fps': 48,
    'seed': 7,
    'share': 'public',
    'engine': 'ideogram',
    'edit_engine': 'qwen',
    'text_mode': 'personality',
    'aspect_ratio': '1:1',
    'duration_sec': 20,
    'silent': True,
    'expand_prompt': False,
    'output': 'audio',
    'max_credits_per_call': 0,
}


def test_tool_defaults_are_the_documented_fixed_values():
    assert driver_mod.TOOL_DEFAULTS == {
        'text_mode': 'literal',
        'resolution': '720p',
        'draft': True,
        'fps': 24,
        'aspect_ratio': '16:9',
        'duration_sec': 5,
        'silent': False,
        'expand_prompt': True,
        'share': 'private',
        'engine': 'default',
        'edit_engine': 'default',
    }


def test_agent_generate_video_ignores_pipeline_settings():
    client = FakeClient()
    _run(_driver(client, settings=dict(SETTINGS_THAT_MUST_NOT_LEAK)), 'generate_video', prompt='p')
    (body,) = client.args_of('generate_video')[0]
    assert body == {
        'prompt': 'p',
        'resolution': '720p',
        'draft': True,
        'fps': 24,
        'aspectRatio': '16:9',
        'saveAudio': True,
        'promptUpsampling': True,
        'visibility': 'private',
        'duration': 5,
    }
    assert 'seed' not in body


def test_agent_explicit_arguments_still_override_the_tool_defaults():
    client = FakeClient()
    _run(
        _driver(client, settings={**SETTINGS_THAT_MUST_NOT_LEAK, 'allow_public_sharing': True}),
        'generate_video',
        prompt='p',
        resolution='1080p',
        draft=False,
        fps=48,
        seed=3,
        share='public',
        silent=True,
    )
    (body,) = client.args_of('generate_video')[0]
    assert body['resolution'] == '1080p' and body['draft'] is False and body['fps'] == 48
    assert body['seed'] == 3 and body['visibility'] == 'public' and body['saveAudio'] is False


def test_agent_speak_and_images_ignore_pipeline_settings():
    client = FakeClient()
    d = _driver(client, settings=dict(SETTINGS_THAT_MUST_NOT_LEAK))
    _run(d, 'speak', avatar_id='A', text='hi')
    assert client.args_of('speak')[0][1]['textMode'] == 'literal'
    assert client.args_of('speak')[0][1]['output'] == 'video'
    _run(d, 'generate_image', prompt='p')
    assert client.args_of('generate_image') == [({'prompt': 'p', 'model': 'default'},)]
    _run(d, 'edit_image', prompt='p', image_url='https://i/x.png')
    assert client.args_of('edit_image') == [({'prompt': 'p', 'model': 'default', 'imageUrl': 'https://i/x.png'},)]


def test_agent_estimate_cost_ignores_pipeline_settings():
    d = _driver(FakeClient(), settings=dict(SETTINGS_THAT_MUST_NOT_LEAK))
    assert _run(d, 'estimate_cost', kind='video')['estimated_credits'] == 0.077
    assert _run(d, 'estimate_cost', kind='image')['estimated_credits'] == 0.005
    assert _run(d, 'estimate_cost', kind='image', image_url='https://i/x.png')['estimated_credits'] == 0.01
    assert _run(d, 'estimate_cost', kind='speak', text='hi', output='audio')['estimated_credits'] == 0.0025


def test_bind_agent_kind_maps_to_body():
    client = FakeClient()
    _run(_driver(client), 'bind_agent', avatar_id='A', pubkey=PUB, relay='wss://r.example', kind=3)
    assert client.args_of('put_binding')[0][1]['kind'] == 3
    omitted = FakeClient()
    _run(_driver(omitted), 'bind_agent', avatar_id='A', pubkey=PUB, relay='wss://r.example')
    assert 'kind' not in omitted.args_of('put_binding')[0][1]


@pytest.mark.parametrize('kind', [0, -1, True, 'abc', []])
def test_bind_agent_kind_must_be_a_positive_integer(kind):
    client = FakeClient()
    with pytest.raises(ValueError, match='kind'):
        _run(_driver(client), 'bind_agent', avatar_id='A', pubkey=PUB, relay='wss://r.example', kind=kind)
    assert client.calls == []


def test_get_turns_since_schema_is_a_string_and_digits_are_epoch_ms():
    d = _driver(FakeClient(get_conversation=TURNS))
    assert d._tools['get_turns']['schema']['properties']['since']['type'] == 'string'
    assert _turn_ids(_run(d, 'get_turns', slug='c-1', since='1000')) == ['t2', 't3']
    assert _turn_ids(_run(d, 'get_turns', slug='c-1', since=' 2000 ')) == ['t3']
    assert _turn_ids(_run(d, 'get_turns', slug='c-1', since='3000')) == []
    assert _turn_ids(_run(d, 'get_turns', slug='c-1', since='t2')) == ['t3']  # non-digits stay a turn id


@pytest.mark.parametrize(
    'body',
    [
        {'conversationId': 'C9', 'liveUrl': 'https://masky.ai/live/top', 'turns': []},
        {'conversation': {'conversationId': 'C9', 'liveUrl': 'https://masky.ai/live/top'}},
    ],
    ids=['top-level', 'nested'],
)
def test_live_conversation_by_slug_reads_live_url(body):
    d = _driver(FakeClient(get_conversation=body))
    got = d.live_conversation('c-existing')
    assert got['conversation_id'] == 'C9' and got['conversation_slug'] == 'c-existing'
    assert got['live_url'] == 'https://masky.ai/live/top'


def test_live_conversation_by_slug_without_live_url_is_none():
    got = _driver(FakeClient(get_conversation={'conversationId': 'C9', 'turns': []})).live_conversation('c-existing')
    assert got['live_url'] is None


def test_edit_image_qwen_with_more_than_two_images_is_refused_before_any_call():
    client = FakeClient()
    three = ['https://i/1.png', 'https://i/2.png', 'https://i/3.png']
    with pytest.raises(ValueError, match='qwen'):
        _run(_driver(client), 'edit_image', prompt='p', images=three, engine='qwen')
    with pytest.raises(ValueError, match='qwen'):
        _driver(client).image_job(prompt='p', source_urls=three, engine='qwen')
    assert client.calls == []
    _run(_driver(client), 'edit_image', prompt='p', images=three[:2], engine='qwen')
    _run(_driver(client), 'edit_image', prompt='p', images=three, engine='default')
    assert client.names() == ['edit_image', 'edit_image']


def test_job_cache_is_bounded_and_keeps_the_newest():
    class Many(FakeClient):
        def __init__(self):
            super().__init__()
            self.n = 0

        def generate_video(self, body):
            self.n += 1
            return dict(VIDEO_POST, generationId=f'V{self.n}')

    assert driver_mod.CACHE_LIMIT == 500
    d = _driver(Many(), settings={'max_credits_per_call': 0})
    for _ in range(600):
        _run(d, 'generate_video', prompt='p')
    assert len(d._jobs) == driver_mod.CACHE_LIMIT
    assert 'video:V600' in d._jobs and 'video:V101' in d._jobs
    assert 'video:V100' not in d._jobs and 'video:V1' not in d._jobs


def test_image_cache_is_bounded_and_keeps_the_newest():
    class Many(FakeClient):
        def __init__(self):
            super().__init__()
            self.n = 0

        def generate_image(self, body):
            self.n += 1
            return dict(IMAGE_BODY, imageUrl=f'https://firebasestorage.googleapis.com/x{self.n}.png?alt=media&token=t')

    d = _driver(Many(), settings={'max_credits_per_call': 0})
    ids = [_run(d, 'generate_image', prompt='p')['generation_id'] for _ in range(600)]
    assert len(set(ids)) == 600
    assert len(d._images) == driver_mod.CACHE_LIMIT
    assert set(d._images) == set(ids[-driver_mod.CACHE_LIMIT :])


def test_remember_reinserting_a_key_refreshes_its_age():
    cache = {}
    for i in range(driver_mod.CACHE_LIMIT):
        driver_mod._remember(cache, f'k{i}', i)
    driver_mod._remember(cache, 'k0', 'again')  # oldest becomes newest
    driver_mod._remember(cache, 'new', 1)
    assert 'k0' in cache and 'k1' not in cache and len(cache) == driver_mod.CACHE_LIMIT


def test_paid_calls_over_the_cap_make_no_client_request():
    client = FakeClient()
    d = _driver(client, settings={'max_credits_per_call': 0.001})
    for tool, args in (
        ('speak', {'avatar_id': 'A', 'text': 'hi', 'text_mode': 'personality'}),
        ('generate_video', {'prompt': 'p'}),
        ('generate_image', {'prompt': 'p'}),
        ('edit_image', {'prompt': 'p', 'image_url': 'https://i/x.png'}),
        ('send_turn', {'conversation_id': 'C1', 'text': 'hi', 'mode': 'speak', 'reinterpret': True}),
        ('send_turn', {'slug': 'c-1', 'text': 'hi'}),
    ):
        with pytest.raises(MaskyError, match='cap'):
            _run(d, tool, **args)
    assert client.calls == []


def test_infinite_live_rate_is_ignored_and_estimates_stay_finite():
    rates = core.rates_from_pricing({'perSecond': {'720p': {'draft': float('inf'), 'full': 0.025}}})
    assert ('720p', True) not in (rates or {}).get('video_per_sec', {})
    est = core.estimate_video(resolution='720p', draft=True, duration_sec=5, live_rates=rates)
    assert est['credits'] == 0.077


def test_402_message_from_a_non_standard_error_is_not_garbled():
    fc = FakeClient(speak=MaskyError('Payment required.', status=402))
    with pytest.raises(MaskyError) as info:
        _run(_driver(fc), 'speak', text='hi', avatar_id='A', output='audio')
    message = str(info.value)
    assert message.startswith('Masky reports insufficient credits for a render estimated at')
    assert message.count('Top up') == 1


def test_bind_agent_rejects_fractional_kind():
    fc = FakeClient()
    with pytest.raises(ValueError):
        _run(_driver(fc), 'bind_agent', avatar_id='A', pubkey='a' * 64, relay='wss://r', kind=2.5)
    assert fc.calls == []


def test_remember_is_safe_under_concurrent_inserts():
    """Cache eviction runs after a paid request, so concurrent renders must never make it raise."""
    remember = MaskyDriver.__init__.__globals__['_remember']
    limit = MaskyDriver.__init__.__globals__['CACHE_LIMIT']
    cache = {}
    errors = []

    def worker(base):
        try:
            for i in range(400):
                remember(cache, f'{base}-{i}', i)
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(6)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert errors == [] and len(cache) == limit


def test_wait_without_turn_id_gets_accurate_warning():
    fc = FakeClient(send_turn={'turn': {'role': 'user', 'status': 'pending'}, 'async': True})
    d = _driver(fc)
    slug = _run(d, 'create_conversation', avatar_id='A')['conversation_slug']
    out = _run(d, 'send_turn', slug=slug, text='hi', mode='speak', wait_for_agent=True)
    assert out['warnings'] == [
        'Not waited for: Masky did not return a turn id to poll. Check the conversation with get_turns.'
    ]


@pytest.mark.parametrize(
    ('tool', 'args'),
    [
        ('send_turn', {'slug': 'c-1', 'text': 'hi', 'mode': 'chat', 'output': 'video'}),
        ('speak', {'text': 'Say hello.', 'avatar_id': 'A', 'output': 'video', 'text_mode': 'personality'}),
    ],
)
def test_assumed_rewrite_refusal_names_the_setting(tool, args):
    fc = FakeClient()
    with pytest.raises(MaskyError) as info:
        _run(_driver(fc, settings={'max_credits_per_call': 0.8}), tool, **args)  # estimated 0.8755
    message = str(info.value)
    assert 'Max Credits per Call' in message and 'writes 500 characters' in message
    assert fc.calls == []


def test_plain_refusal_has_no_rewrite_hint():
    with pytest.raises(MaskyError) as info:
        core.check_budget(core.estimate_speak('x' * 480, 'video'), 0.8)
    assert 'Max Credits per Call' in str(info.value) and 'writes 500 characters' not in str(info.value)


def test_turn_without_id_is_flagged_unconfirmed_not_timed_out():
    fc = FakeClient(send_turn={'turn': {'role': 'user', 'status': 'pending'}, 'async': True})
    d = _driver(fc)
    slug = _run(d, 'create_conversation', avatar_id='A')['conversation_slug']
    out = d.turn_job(conversation_id='C1', slug=slug, text='hi', mode='speak', output='audio', wait=True)
    assert out['unconfirmed'] is True and out['status'] == 'running'
    assert 'did not return a turn id' in out['warnings'][0]
    confirmed = d.turn_job(conversation_id='C1', slug=slug, text='hi', mode='speak', output='audio', wait=False)
    assert 'unconfirmed' not in confirmed


# ---------------------------------------------------------------------------
# Permission switches: readOnly, allowDelete, allowPublicSharing
# ---------------------------------------------------------------------------

EXPECTED_READ_TOOLS = {
    'list_avatars',
    'get_avatar',
    'get_stream_identity',
    'list_voices',
    'list_looks',
    'get_generation',
    'estimate_cost',
    'get_turns',
    'get_binding',
}


def _listed(d):
    return [t['name'].split('.', 1)[1] for t in d._tool_query()]


def test_read_tools_set_is_exactly_the_reviewed_one():
    assert set(READ_TOOLS) == EXPECTED_READ_TOOLS
    assert set(DELETE_TOOLS) == {'unbind_agent', 'delete_conversation', 'delete_turn'}
    assert EXPECTED_READ_TOOLS <= set(_driver()._tools)


def test_default_listing_hides_only_the_delete_tools():
    d = _driver()
    registered = list(d._tools)
    assert len(registered) == 29
    assert _listed(d) == [n for n in registered if n not in DELETE_TOOLS]
    assert len(_listed(d)) == 26


def test_allow_delete_lists_all_tools():
    d = _driver(settings={'allow_delete': True})
    assert _listed(d) == list(d._tools)


def test_read_only_lists_exactly_the_read_tools():
    d = _driver(settings={'read_only': True})
    assert set(_listed(d)) == EXPECTED_READ_TOOLS


def test_read_only_hides_every_other_registered_tool_and_refuses_it():
    client = FakeClient()
    d = _driver(client, settings={'read_only': True, 'allow_delete': True, 'allow_public_sharing': True})
    hidden = [n for n in d._tools if n not in EXPECTED_READ_TOOLS]
    assert hidden  # a new write tool must land here, not slip through
    assert not set(hidden) & set(_listed(d))
    for name in hidden:
        with pytest.raises(ValueError) as ei:
            _run(d, name)
        assert str(ei.value) == READ_ONLY_REFUSAL, name
    assert client.calls == []


def test_read_only_keeps_read_tools_working():
    d = _driver(FakeClient(), settings={'read_only': True})
    assert _run(d, 'get_avatar', avatar_id='A')['avatar_id'] == 'A'
    assert _run(d, 'estimate_cost', kind='speak', text='hi', output='audio')['estimated_credits'] == 0.0025


def test_read_only_blocks_unbind_agent_even_with_allow_delete():
    client = FakeClient()
    d = _driver(client, settings={'read_only': True, 'allow_delete': True})
    assert 'unbind_agent' not in _listed(d)
    _refused(d, 'unbind_agent', READ_ONLY_REFUSAL, avatar_id='A')
    assert client.calls == []


def test_unbind_agent_refused_without_allow_delete_even_when_not_read_only():
    client = FakeClient()
    d = _driver(client, settings={'read_only': False})
    assert 'unbind_agent' not in _listed(d)
    _refused(d, 'unbind_agent', "'allowDelete'", avatar_id='A')
    assert client.calls == []


def test_unbind_agent_works_with_allow_delete():
    client = FakeClient()
    d = _driver(client, settings={'allow_delete': True})
    assert 'unbind_agent' in _listed(d)
    assert _run(d, 'unbind_agent', avatar_id='A') == {'avatar_id': 'A', 'agent_binding': None}
    assert client.names() == ['delete_binding']


def test_missing_switches_default_to_off():
    d = _driver(settings={})
    assert 'unbind_agent' not in _listed(d)
    _refused(d, 'set_avatar_public', "'allowPublicSharing'", avatar_id='A', public=True)


@pytest.mark.parametrize(
    'tool,args',
    [
        ('set_avatar_public', {'avatar_id': 'A', 'public': True}),
        ('set_conversation_visibility', {'conversation_id': 'C1', 'public': True}),
        ('set_conversation_visibility', {'slug': 'c-1', 'public': True}),
        ('create_avatar', {'name': 'Nova', 'image_url': 'https://i/x.png', 'public': True}),
        ('generate_video', {'prompt': 'p', 'share': 'public'}),
    ],
)
def test_public_variants_refused_before_any_client_call(tool, args):
    d = _driver(FakeClient())
    _refused(d, tool, "'allowPublicSharing'", **args)


def test_public_sharing_tools_stay_listed_when_switch_is_off():
    listed = _listed(_driver())
    for name in ('set_avatar_public', 'set_conversation_visibility', 'create_avatar', 'generate_video'):
        assert name in listed


def test_private_variants_always_work_without_allow_public_sharing():
    client = FakeClient(get_conversation={'conversationId': 'C9', 'turns': []})
    d = _driver(client)
    assert _run(d, 'set_avatar_public', avatar_id='A', public=False)['public'] is False
    assert _run(d, 'set_conversation_visibility', conversation_id='C1', public=False)['public'] is False
    assert _run(d, 'create_avatar', name='Nova', image_url='https://i/x.png', public=False)
    assert _run(d, 'create_avatar', name='Nova', image_url='https://i/x.png')
    _run(d, 'generate_video', prompt='p', share='private')
    _run(d, 'generate_video', prompt='p')
    assert client.args_of('set_avatar_public') == [('A', False)]
    assert client.args_of('set_conversation_visibility') == [('C1', False)]


def test_public_variants_work_with_allow_public_sharing():
    client = FakeClient()
    d = _driver(client, settings={'allow_public_sharing': True})
    assert _run(d, 'set_avatar_public', avatar_id='A', public=True)['public'] is True
    _run(d, 'generate_video', prompt='p', share='public')
    assert client.args_of('set_avatar_public') == [('A', True)]


def test_read_only_hides_set_avatar_public_even_with_public_sharing_on():
    # readOnly hides writes; the public gate is a separate switch and stays independent.
    d = _driver(FakeClient(), settings={'read_only': True, 'allow_public_sharing': True})
    assert 'set_avatar_public' not in _listed(d)


# ---------------------------------------------------------------------------
# delete_conversation / delete_turn / restore_turn
# ---------------------------------------------------------------------------

_DEL_ARGS = {
    'delete_conversation': {'conversation_id': 'C1'},
    'delete_turn': {'conversation_id': 'C1', 'turn_id': 'T1'},
    'restore_turn': {'conversation_id': 'C1', 'turn_id': 'T1'},
}
_DEL_CALL = {
    'delete_conversation': ('C1',),
    'delete_turn': ('C1', 'T1'),
    'restore_turn': ('C1', 'T1'),
}


def test_delete_conversation_success():
    client = FakeClient()
    d = _driver(client, settings={'allow_delete': True})
    assert _run(d, 'delete_conversation', conversation_id='C1') == {'conversation_id': 'C1', 'deleted': True}
    assert client.calls == [('delete_conversation', 'C1')]


def test_delete_turn_success():
    client = FakeClient()
    d = _driver(client, settings={'allow_delete': True})
    out = _run(d, 'delete_turn', conversation_id='C1', turn_id='T1')
    assert out == {'conversation_id': 'C1', 'turn_id': 'T1', 'deleted': True, 'restorable': True}
    assert client.calls == [('delete_turn', 'C1', 'T1')]


@pytest.mark.parametrize('settings', [{'allow_delete': True}, {}])
def test_restore_turn_success_with_or_without_allow_delete(settings):
    client = FakeClient()
    d = _driver(client, settings=settings)
    out = _run(d, 'restore_turn', conversation_id='C1', turn_id='T1')
    assert out == {'conversation_id': 'C1', 'turn_id': 'T1', 'restored': True}
    assert client.calls == [('restore_turn', 'C1', 'T1')]


@pytest.mark.parametrize('tool', list(_DEL_ARGS))
@pytest.mark.parametrize('status,text', [(404, 'found nothing'), (403, 'refused access')])
def test_delete_tools_propagate_masky_errors(tool, status, text):
    err = MaskyError(f'Masky {text} at /conversations/C1.', status=status)
    client = FakeClient(**{tool: err})
    d = _driver(client, settings={'allow_delete': True})
    with pytest.raises(MaskyError) as ei:
        _run(d, tool, **_DEL_ARGS[tool])
    assert ei.value is err and ei.value.status == status
    assert client.calls == [(tool, *_DEL_CALL[tool])]


@pytest.mark.parametrize(
    'tool,args',
    [
        ('delete_conversation', {}),
        ('delete_conversation', {'conversation_id': ''}),
        ('delete_turn', {'turn_id': 'T1'}),
        ('delete_turn', {'conversation_id': 'C1'}),
        ('delete_turn', {}),
        ('restore_turn', {'turn_id': 'T1'}),
        ('restore_turn', {'conversation_id': 'C1'}),
        ('restore_turn', {}),
    ],
)
def test_delete_tools_validate_ids_before_any_client_call(tool, args):
    d = _driver(FakeClient(), settings={'allow_delete': True})
    _refused(d, tool, **args)


@pytest.mark.parametrize('tool', ['delete_conversation', 'delete_turn'])
def test_delete_tools_hidden_and_refused_without_allow_delete(tool):
    client = FakeClient()
    d = _driver(client, settings={'read_only': False})
    assert tool not in _listed(d)
    _refused(d, tool, "'allowDelete'", **_DEL_ARGS[tool])
    assert client.calls == []


def test_restore_turn_listed_without_allow_delete():
    d = _driver(FakeClient())
    assert 'restore_turn' in _listed(d)
    for name in ('delete_conversation', 'delete_turn', 'unbind_agent'):
        assert name not in _listed(d)


@pytest.mark.parametrize('tool', list(_DEL_ARGS))
def test_read_only_hides_and_refuses_delete_and_restore_tools(tool):
    client = FakeClient()
    d = _driver(client, settings={'read_only': True, 'allow_delete': True})
    assert tool not in _listed(d)
    _refused(d, tool, READ_ONLY_REFUSAL, **_DEL_ARGS[tool])
    assert client.calls == []


def test_delete_conversation_clears_cached_conversation():
    client = FakeClient(get_conversation={'conversationId': 'C1', 'turns': []})
    d = _driver(client, settings={'default_avatar': 'A', 'allow_delete': True})
    created = _run(d, 'create_conversation')
    slug = created['conversation_slug']
    assert slug in d._conversations
    _run(d, 'delete_conversation', conversation_id=created['conversation_id'])
    assert slug not in d._conversations
    _run(d, 'send_turn', slug=slug, text='hi')
    assert client.args_of('get_conversation') == [(slug,)]


def test_delete_conversation_keeps_other_cached_conversations():
    client = FakeClient()
    d = _driver(client, settings={'allow_delete': True})
    d._conversations['other'] = {'conversation_id': 'C2'}
    d._conversations['mine'] = {'conversation_id': 'C1'}
    _run(d, 'delete_conversation', conversation_id='C1')
    assert list(d._conversations) == ['other']


def test_delete_conversation_resets_pipeline_conversation():
    client = FakeClient()
    d = _driver(client, settings={'default_avatar': 'A', 'allow_delete': True})
    first = d.live_conversation('')
    assert client.names().count('create_conversation') == 1
    _run(d, 'delete_conversation', conversation_id=first['conversation_id'])
    d.live_conversation('')
    assert client.names().count('create_conversation') == 2


def test_delete_conversation_of_other_id_keeps_pipeline_conversation():
    client = FakeClient()
    d = _driver(client, settings={'default_avatar': 'A', 'allow_delete': True})
    first = d.live_conversation('')
    _run(d, 'delete_conversation', conversation_id='OTHER')
    assert d.live_conversation('') == first
    assert client.names().count('create_conversation') == 1


# ---------------------------------------------------------------------------
# rename_avatar (PATCH /avatars/{id}, from Masky's answers; not in the published spec)
# ---------------------------------------------------------------------------


class RenameClient(FakeClient):
    def rename_avatar(self, avatar_id, name):
        return self._do('rename_avatar', avatar_id, name)


def test_rename_avatar_success():
    fc = RenameClient(rename_avatar={'avatar': {'avatarId': 'A', 'displayName': 'New Name'}})
    out = _run(_driver(fc), 'rename_avatar', avatar_id='A', name='  New Name  ')
    assert fc.args_of('rename_avatar') == [('A', 'New Name')]
    assert out == {'avatar_id': 'A', 'name': 'New Name'}


@pytest.mark.parametrize(
    ('args', 'match'),
    [
        ({'name': 'x'}, '"avatar_id" is required'),
        ({'avatar_id': 'A'}, '"name" is required'),
        ({'avatar_id': 'A', 'name': '   '}, '"name" is required'),
        ({'avatar_id': 'A', 'name': 'x' * 81}, 'name is 81 characters; Masky accepts 80'),
    ],
)
def test_rename_avatar_validation_before_any_request(args, match):
    fc = RenameClient()
    with pytest.raises(ValueError, match=match):
        _run(_driver(fc), 'rename_avatar', **args)
    assert fc.calls == []


def test_rename_avatar_accepts_exactly_80_chars():
    fc = RenameClient(rename_avatar={'avatar': {'avatarId': 'A', 'displayName': 'y' * 80}})
    assert _run(_driver(fc), 'rename_avatar', avatar_id='A', name='y' * 80)['name'] == 'y' * 80


def test_rename_avatar_twitch_locked_name_gets_its_own_message():
    locked = MaskyError(
        'Masky refused access to /avatars/A (Name is locked to a linked Twitch identity (nameLocked)).', status=403
    )
    fc = RenameClient(rename_avatar=locked)
    with pytest.raises(MaskyError) as info:
        _run(_driver(fc), 'rename_avatar', avatar_id='A', name='New')
    assert (
        str(info.value) == "This avatar's name is locked to its linked Twitch account; change it on Twitch or masky.ai."
    )


def test_rename_avatar_other_403_and_404_pass_through():
    for err in (
        MaskyError('Masky refused access to /avatars/A (not your avatar).', status=403),
        MaskyError('Masky found nothing at /avatars/A. Check the id.', status=404),
    ):
        fc = RenameClient(rename_avatar=err)
        with pytest.raises(MaskyError) as info:
            _run(_driver(fc), 'rename_avatar', avatar_id='A', name='New')
        assert str(info.value) == str(err) and 'Twitch' not in str(info.value)


def test_rename_avatar_is_blocked_by_read_only_but_not_gated_by_allow_delete():
    fc = RenameClient()
    d = _driver(fc, settings={'read_only': True})
    assert 'rename_avatar' not in _listed(d)
    with pytest.raises(ValueError, match='read-only mode'):
        _run(d, 'rename_avatar', avatar_id='A', name='New')
    assert fc.calls == []
    assert 'rename_avatar' in _listed(_driver(RenameClient()))


# ---------------------------------------------------------------------------
# A status check that fails after a paid request keeps the job id
# ---------------------------------------------------------------------------

POLL_DOWN = MaskyError('Could not reach Masky (ConnectionError). Check the network and the base URL.')


def test_speak_wait_keeps_the_job_id_when_the_status_check_fails():
    fc = FakeClient(get_speak=[POLL_DOWN])
    out = _run(_driver(fc), 'speak', text='hi', avatar_id='A', output='audio', wait_for_completion=True)
    assert fc.names().count('speak') == 1, 'the paid request is sent once and not again'
    assert out['generation_id'] == 'speak:G1' and out['status'] == 'running'
    assert 'Could not reach Masky' in out['poll_error']
    assert any('Could not check on job speak:G1 after Masky accepted it' in w for w in out['warnings'])


@pytest.mark.parametrize('reply', ['not an object', ['a list'], {'status': 5}])
def test_speak_wait_keeps_the_job_id_when_the_status_reply_is_malformed(reply):
    fc = FakeClient(get_speak=[reply])
    out = _run(_driver(fc), 'speak', text='hi', avatar_id='A', output='audio', wait_for_completion=True)
    assert fc.names().count('speak') == 1
    assert out['generation_id'] == 'speak:G1' and out['status'] == 'running'
    assert 'status reply this node could not read' in out['poll_error']


def test_video_wait_keeps_the_job_id_when_the_status_reply_is_malformed():
    fc = FakeClient(get_video=[{'status': 5}])
    out = _run(_driver(fc), 'generate_video', prompt='a cat', wait_for_completion=True)
    assert fc.names().count('generate_video') == 1
    assert out['generation_id'] == 'video:V1' and 'could not read' in out['poll_error']


def test_speak_wait_still_propagates_cancellation():
    fc = FakeClient(get_speak=[MaskyCancelled('Cancelled while waiting for Masky to finish rendering.')])
    with pytest.raises(MaskyCancelled):
        _run(_driver(fc), 'speak', text='hi', avatar_id='A', output='audio', wait_for_completion=True)


def test_speak_cancellation_while_waiting_names_the_accepted_job():
    fc = FakeClient(get_speak=[MaskyCancelled('Cancelled while waiting for Masky to finish rendering.')])
    with pytest.raises(MaskyCancelled) as e:
        _run(_driver(fc), 'speak', text='hi', avatar_id='A', output='audio', wait_for_completion=True)
    assert 'Cancelled while waiting' in str(e.value) and 'speak:G1' in str(e.value)


def test_video_cancellation_while_waiting_names_the_accepted_job():
    fc = FakeClient(get_video=[MaskyCancelled('Cancelled while waiting for Masky to finish rendering.')])
    with pytest.raises(MaskyCancelled) as e:
        _run(_driver(fc), 'generate_video', prompt='a cat', wait_for_completion=True)
    assert 'Cancelled while waiting' in str(e.value) and 'video:V1' in str(e.value)


def test_turn_cancellation_while_waiting_names_the_accepted_turn():
    fc = FakeClient(get_conversation=[MaskyCancelled('Cancelled while waiting for Masky to finish rendering.')])
    d = _driver(fc)
    slug = _run(d, 'create_conversation', avatar_id='A')['conversation_slug']
    with pytest.raises(MaskyCancelled) as e:
        d.turn_job(conversation_id='C1', slug=slug, text='hi', mode='speak', output='audio', wait=True)
    assert 'Cancelled while waiting' in str(e.value) and 'turn T1' in str(e.value)


def test_video_wait_keeps_the_job_id_when_the_status_check_fails():
    fc = FakeClient(get_video=[POLL_DOWN])
    out = _run(_driver(fc), 'generate_video', prompt='a cat', wait_for_completion=True)
    assert fc.names().count('generate_video') == 1
    assert out['generation_id'] == 'video:V1' and out['status'] in ('queued', 'running')
    assert out['poll_error'] and any('job video:V1' in w for w in out['warnings'])


def test_turn_wait_marks_the_turn_unconfirmed_when_the_status_check_fails():
    fc = FakeClient(get_conversation=[POLL_DOWN])
    d = _driver(fc)
    slug = _run(d, 'create_conversation', avatar_id='A')['conversation_slug']
    out = d.turn_job(conversation_id='C1', slug=slug, text='hi', mode='speak', output='audio', wait=True)
    assert fc.names().count('send_turn') == 1
    assert out['turn_id'] == 'T1' and out['unconfirmed'] is True and out['poll_error']
    assert 'Could not check on turn T1' in out['warnings'][0]
