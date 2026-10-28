# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Offline tests for the tool_masky pipeline (lane) behaviour.

No engine, no network. ``rocketlib`` / ``ai.common`` are stubbed only long
enough to import the node (same pattern as test_tool_masky.py); the descriptor
helpers and the driver are fakes that record what the node hands them.
"""

from __future__ import annotations

import json
import sys
import types

import pytest

from ._stubs import BEGIN, END, FORWARDS, WARNINGS, WRITE, PreventDefault, make_requests, scoped_stubs

with scoped_stubs() as _env_stubs:
    from tool_masky import IInstance as IInstanceMod  # noqa: E402
    from tool_masky import masky_core as core  # noqa: E402
    from tool_masky.masky_client import MaskyClient  # noqa: E402
    from tool_masky.masky_core import MaskyCancelled, MaskyError  # noqa: E402
    from tool_masky.masky_driver import MaskyDriver  # noqa: E402

# The node's lazy descriptor import runs at call time, so the fixture re-installs this stub per test.
_DESC = _env_stubs.descriptor


# ---------------------------------------------------------------------------
# Synthetic media
# ---------------------------------------------------------------------------


def make_mp3(frames=50):
    frame = bytes([0xFF, 0xF3, 0x44, 0xC4]) + bytes(96 - 4)
    return b'ID3\x04\x00\x00\x00\x00\x00\x00' + frame * frames


def _box(kind, body):
    return (8 + len(body)).to_bytes(4, 'big') + kind + body


def make_mp4(duration=3042, width=960, height=960):
    mvhd = bytes([0, 0, 0, 0]) + bytes(8) + (1000).to_bytes(4, 'big') + duration.to_bytes(4, 'big') + bytes(80)
    tkhd = bytes([0, 0, 0, 0]) + bytes(72) + (width << 16).to_bytes(4, 'big') + (height << 16).to_bytes(4, 'big')
    moov = _box(b'mvhd', mvhd) + _box(b'trak', _box(b'tkhd', tkhd))
    return _box(b'ftyp', b'isom\x00\x00\x02\x00') + _box(b'moov', moov)


def make_png(w=64, h=32):
    return b'\x89PNG\r\n\x1a\n' + b'\x00\x00\x00\rIHDR' + w.to_bytes(4, 'big') + h.to_bytes(4, 'big') + bytes(10)


def make_jpeg(w=120, h=80):
    app0 = b'\xff\xe0' + (16).to_bytes(2, 'big') + bytes(14)
    sof = b'\xff\xc0' + (17).to_bytes(2, 'big') + b'\x08' + h.to_bytes(2, 'big') + w.to_bytes(2, 'big') + bytes(10)
    return b'\xff\xd8' + app0 + sof + b'\xff\xd9'


def make_webp(w=300, h=200):
    body = (
        b'WEBP'
        + b'VP8X'
        + (10).to_bytes(4, 'little')
        + bytes(4)
        + (w - 1).to_bytes(3, 'little')
        + (h - 1).to_bytes(3, 'little')
    )
    return b'RIFF' + len(body).to_bytes(4, 'little') + body


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeInstance:
    def __init__(self):
        self.calls = []

    def _rec(self, kind):
        return lambda *a: self.calls.append((kind, *a))

    def __getattr__(self, name):
        if name in ('writeAudio', 'writeVideo', 'writeImage', 'writeText'):
            return self._rec(name)
        raise AttributeError(name)

    def of(self, kind):
        return [c[1:] for c in self.calls if c[0] == kind]


class FakeDriver:
    def __init__(self, receipt=None, data=b''):
        self.receipt = receipt
        self.data = data
        self.speak = []
        self.image = []
        self.downloads = []

    def speak_job(self, **kw):
        self.speak.append(kw)
        return self.receipt

    def image_job(self, **kw):
        self.image.append(kw)
        return self.receipt

    def download(self, url):
        self.downloads.append(url)
        return self.data


def receipt(mime='video/mp4', status='done', job='speak:G1', url='https://x/v.mp4?Expires=1', **over):
    r = {
        'generation_id': job,
        'kind': 'speak',
        'status': status,
        'warnings': [],
        'media': {'mime': mime, 'url': url} if url else {},
    }
    r.update(over)
    return r


def build(settings, driver):
    inst = IInstanceMod.IInstance()
    inst.IGlobal = types.SimpleNamespace(settings=settings, driver=driver)
    inst.instance = FakeInstance()
    return inst


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    WARNINGS.clear()
    FORWARDS.clear()
    monkeypatch.setitem(sys.modules, 'ai.common.avi.descriptor', _DESC)


def run(inst, text):
    with pytest.raises(PreventDefault):
        inst.writeText(text)


# ---------------------------------------------------------------------------
# Fixtures self-check and media parsing
# ---------------------------------------------------------------------------


def test_mp3_duration():
    assert core.mp3_duration(make_mp3()) == 1.2


def test_mp4_info():
    assert core.mp4_info(make_mp4()) == {'duration': 3.042, 'width': 960, 'height': 960}


def test_image_size_formats():
    assert core.image_size(make_png()) == {'width': 64, 'height': 32}
    assert core.image_size(make_jpeg()) == {'width': 120, 'height': 80}
    assert core.image_size(make_webp()) == {'width': 300, 'height': 200}


def test_unknown_bytes_do_not_raise():
    assert core.image_size(b'garbage') == {}
    assert core.image_size(b'') == {}
    assert core.mp3_duration(b'nope') is None
    assert core.mp3_duration(b'') is None
    assert core.mp4_info(b'nope') == {}
    assert core.media_details('video/mp4', b'x') == {'size_bytes': 1}
    assert core.media_details('audio/mpeg', b'x') == {'size_bytes': 1}
    assert core.media_details('image/png', b'x') == {'size_bytes': 1}
    assert core.media_details('application/octet-stream', b'xy') == {'size_bytes': 2}


def test_media_details_per_mime():
    assert core.media_details('audio/mpeg', make_mp3()) == {'size_bytes': len(make_mp3()), 'duration_sec': 1.2}
    mp4 = make_mp4()
    assert core.media_details('video/mp4', mp4) == {
        'size_bytes': len(mp4),
        'duration_sec': 3.042,
        'width': 960,
        'height': 960,
    }
    for mime, data, dims in (
        ('image/png', make_png(), (64, 32)),
        ('image/jpeg', make_jpeg(), (120, 80)),
        ('image/webp', make_webp(), (300, 200)),
    ):
        assert core.media_details(mime, data) == {'size_bytes': len(data), 'width': dims[0], 'height': dims[1]}


# ---------------------------------------------------------------------------
# Lanes
# ---------------------------------------------------------------------------


def test_talking_head_video():
    mp4 = make_mp4()
    driver = FakeDriver(receipt(), mp4)
    inst = build({'action': 'talking_head', 'output': 'video', 'default_look': 'L1'}, driver)
    run(inst, 'hello world')

    assert driver.speak == [
        {'text': 'hello world', 'output': 'video', 'look': 'L1', 'text_mode': 'literal', 'wait': True}
    ]
    assert driver.downloads == ['https://x/v.mp4?Expires=1']
    calls = inst.instance.of('writeVideo')
    assert [c[0] for c in calls] == [BEGIN, WRITE, END]
    assert json.loads(calls[0][2])['size'] == len(calls[1][2]) == len(mp4)
    kind, _, desc, mime, data, kw = FORWARDS[0]
    assert (kind, desc, mime, data) == ('Video', None, 'video/mp4', mp4)
    assert kw == {'duration': 3.042, 'width': 960, 'height': 960, 'name': 'speak-G1.mp4'}
    texts = inst.instance.of('writeText')
    assert len(texts) == 1
    out = json.loads(texts[0][0])
    assert out['media'] == {
        'mime': 'video/mp4',
        'url': 'https://x/v.mp4?Expires=1',
        'size_bytes': len(mp4),
        'duration_sec': 3.042,
        'width': 960,
        'height': 960,
    }


def test_talking_head_audio():
    mp3 = make_mp3()
    driver = FakeDriver(receipt('audio/mpeg', url='https://x/a.mp3'), mp3)
    inst = build({'action': 'talking_head', 'output': 'audio'}, driver)
    run(inst, 'hi')

    assert driver.speak[0]['output'] == 'audio'
    calls = inst.instance.of('writeAudio')
    assert json.loads(calls[0][2])['size'] == len(calls[1][2]) == len(mp3)
    assert not inst.instance.of('writeVideo')
    kw = FORWARDS[0][5]
    assert kw['format'] == 'mp3' and kw['duration'] == 1.2 and kw['name'] == 'speak-G1.mp3'
    assert json.loads(inst.instance.of('writeText')[0][0])['media']['duration_sec'] == 1.2


def test_image_action():
    png = make_png()
    driver = FakeDriver(receipt('image/png', job='image:I1', url='https://x/i.png'), png)
    inst = build({'action': 'image', 'source_image_url': 'https://src/p.png'}, driver)
    run(inst, 'a cat')

    assert driver.image == [{'prompt': 'a cat', 'source_url': 'https://src/p.png', 'engine': 'default'}]
    calls = inst.instance.of('writeImage')
    assert json.loads(calls[0][2])['size'] == len(calls[1][2]) == len(png)
    kw = FORWARDS[0][5]
    assert kw['width'] == 64 and kw['height'] == 32 and kw['origin'] == 'generated'
    out = json.loads(inst.instance.of('writeText')[0][0])
    assert out['media']['width'] == 64 and out['media']['size_bytes'] == len(png)


def test_speech_over_limit():
    driver = FakeDriver(receipt(), b'')
    inst = build({'action': 'talking_head'}, driver)
    with pytest.raises(ValueError) as e:
        inst.writeText('x' * 501)
    assert str(e.value) == (
        'Masky accepts 500 characters per speech request and this record has 501. Split it upstream with a chunker or summarization node.'
    )
    assert driver.speak == []
    # exactly 500 is allowed
    driver.data = make_mp4()
    run(inst, 'x' * 500)
    assert len(driver.speak) == 1


def test_image_prompt_over_limit():
    driver = FakeDriver(receipt('image/png'), b'')
    inst = build({'action': 'image'}, driver)
    with pytest.raises(ValueError, match='2001'):
        inst.writeText('x' * 2001)
    assert driver.image == []


@pytest.mark.parametrize('text', ['', '   \n\t', None])
def test_empty_text_is_noop(text):
    driver = FakeDriver(receipt(), b'')
    inst = build({'action': 'talking_head'}, driver)
    run(inst, text)
    assert driver.speak == [] and driver.downloads == [] and inst.instance.calls == []


def test_write_questions_joins_text():
    driver = FakeDriver(receipt(), make_mp4())
    inst = build({'action': 'talking_head'}, driver)
    q = types.SimpleNamespace(questions=[types.SimpleNamespace(text='one'), types.SimpleNamespace(text='two')])
    with pytest.raises(PreventDefault):
        inst.writeQuestions(q)
    assert driver.speak[0]['text'] == 'one two'


def test_write_answers_uses_get_text():
    driver = FakeDriver(receipt(), make_mp4())
    inst = build({'action': 'talking_head'}, driver)
    ans = types.SimpleNamespace(getText=lambda: 'the answer')
    with pytest.raises(PreventDefault):
        inst.writeAnswers(ans)
    assert driver.speak[0]['text'] == 'the answer'


def test_failed_receipt():
    driver = FakeDriver(receipt(status='failed', error='boom'), b'')
    inst = build({'action': 'talking_head'}, driver)
    with pytest.raises(MaskyError, match='boom'):
        inst.writeText('hi')
    assert driver.downloads == []


def test_running_receipt():
    driver = FakeDriver(receipt(status='running', job='speak:G9'), b'')
    inst = build({'action': 'talking_head', 'timeout_sec': 120}, driver)
    with pytest.raises(MaskyError) as e:
        inst.writeText('hi')
    assert 'Still rendering after 120 s' in str(e.value) and 'speak:G9' in str(e.value)
    assert driver.downloads == []


def test_done_without_url():
    driver = FakeDriver(receipt(url=None), b'')
    inst = build({'action': 'talking_head'}, driver)
    with pytest.raises(MaskyError, match='no media URL'):
        inst.writeText('hi')
    assert driver.downloads == []


def test_warnings_forwarded():
    driver = FakeDriver(receipt(warnings=['text trimmed', 'low res']), make_mp4())
    inst = build({'action': 'talking_head'}, driver)
    run(inst, 'hi')
    assert WARNINGS == ['Masky (speak:G1): text trimmed', 'Masky (speak:G1): low res']


def test_unknown_action():
    driver = FakeDriver(receipt(), b'')
    inst = build({'action': 'dance'}, driver)
    with pytest.raises(MaskyError, match='Unknown pipeline action'):
        inst.writeText('hi')
    assert driver.speak == [] and driver.image == []


# ---------------------------------------------------------------------------
# scene_video lane
# ---------------------------------------------------------------------------


class VideoDriver(FakeDriver):
    def __init__(self, receipt=None, data=b''):
        super().__init__(receipt, data)
        self.video = []

    def video_job(self, **kw):
        self.video.append(kw)
        return self.receipt


def test_scene_video_maps_settings_draft():
    mp4 = make_mp4()
    driver = VideoDriver(receipt(job='video:V1', kind='video'), mp4)
    inst = build(
        {
            'action': 'scene_video',
            'quality': '720p-draft',
            'duration_sec': 8,
            'fps': 24,
            'aspect_ratio': '9:16',
            'seed': 7,
            'silent': True,
            'expand_prompt': False,
            'share': 'public',
            'allow_public_sharing': True,
            'source_image_url': 'https://src/p.png',
            'speech_line': 'hello there',
        },
        driver,
    )
    run(inst, 'a fox runs')

    assert driver.video == [
        {
            'prompt': 'a fox runs',
            'resolution': '720p',
            'draft': True,
            'duration_sec': 8,
            'fps': 24,
            'aspect_ratio': '9:16',
            'seed': 7,
            'silent': True,
            'expand_prompt': False,
            'share': 'public',
            'image_url': 'https://src/p.png',
            'speech_text': 'hello there',
            'wait': True,
        }
    ]
    assert driver.downloads == ['https://x/v.mp4?Expires=1']
    calls = inst.instance.of('writeVideo')
    assert [c[0] for c in calls] == [BEGIN, WRITE, END]
    assert json.loads(calls[0][2])['size'] == len(calls[1][2]) == len(mp4)
    assert len(inst.instance.of('writeText')) == 1


def test_scene_video_1080p_is_not_draft():
    driver = VideoDriver(receipt(job='video:V1'), make_mp4())
    inst = build({'action': 'scene_video', 'quality': '1080p'}, driver)
    run(inst, 'a fox')
    assert driver.video[0]['resolution'] == '1080p' and driver.video[0]['draft'] is False
    assert driver.video[0]['wait'] is True
    assert driver.video[0]['image_url'] == '' and driver.video[0]['speech_text'] == ''


def test_scene_video_prompt_over_limit():
    driver = VideoDriver(receipt(), b'')
    inst = build({'action': 'scene_video'}, driver)
    with pytest.raises(ValueError) as e:
        inst.writeText('x' * 2001)
    assert str(e.value) == (
        'Masky accepts 2000 characters per scene-video prompt and this record has 2001. Shorten it upstream with a summarization node.'
    )
    assert driver.video == []
    driver.data = make_mp4()
    run(inst, 'x' * 2000)
    assert len(driver.video) == 1


# ---------------------------------------------------------------------------
# live lane
# ---------------------------------------------------------------------------


class LiveDriver:
    def __init__(self, statuses=None, credits=0.01):
        self.conv_calls = []
        self.turns = []
        self.statuses = list(statuses or [])
        self.credits = credits

    def live_conversation(self, slug=''):
        self.conv_calls.append(slug)
        return {
            'conversation_slug': 'c-1',
            'conversation_id': 'C1',
            'share_url': 'https://masky.ai/c-1',
            'live_url': 'https://masky.ai/live/c-1',
        }

    def turn_job(self, **kw):
        self.turns.append(kw)
        n = len(self.turns)
        status = self.statuses.pop(0) if self.statuses else 'done'
        return {'turn_id': f'T{n}', 'status': status, 'estimated_credits': self.credits}


def _sentences(total):
    out, i = [], 0
    while sum(len(x) + 1 for x in out) < total:
        out.append(f'This is short sentence number {i}.')
        i += 1
    return ' '.join(out)[:total].rsplit(' ', 1)[0] + '.'


def test_live_splits_into_turns_and_writes_one_receipt():
    text = _sentences(1200)
    assert len(text) > 1100
    driver = LiveDriver()
    # three speak/video turns come to about 2.7 credits; the cap covers the whole record, so raise it
    inst = build(
        {
            'action': 'live',
            'conversation': '',
            'turn_mode': 'speak',
            'turn_output': 'video',
            'wait_for_turn': True,
            'max_credits_per_call': 5,
        },
        driver,
    )
    run(inst, text)

    assert len(driver.turns) > 1
    sent = [t['text'] for t in driver.turns]
    assert all(len(t) <= 500 for t in sent)
    assert ' '.join(sent) == ' '.join(text.split())
    # no turn is cut mid-word: every word of every turn is a word of the input
    words = set(text.split())
    assert all(w in words for t in sent for w in t.split())
    for t in driver.turns:
        assert t['conversation_id'] == 'C1' and t['slug'] == 'c-1'
        assert t['mode'] == 'speak' and t['output'] == 'video' and t['wait'] is True

    texts = inst.instance.of('writeText')
    assert len(texts) == 1
    out = json.loads(texts[0][0])
    n = len(driver.turns)
    assert out['turn_ids'] == [f'T{i + 1}' for i in range(n)]
    assert out['status'] == 'done'
    assert out['turn_statuses'] == ['done'] * n
    assert out['estimated_credits'] == round(0.01 * n, 3)
    assert out['conversation_slug'] == 'c-1'
    assert out['share_url'] == 'https://masky.ai/c-1' and out['live_url'] == 'https://masky.ai/live/c-1'
    for kind in ('writeVideo', 'writeAudio', 'writeImage'):
        assert not inst.instance.of(kind)
    assert driver.conv_calls == ['']


def test_live_no_wait_status_sent():
    driver = LiveDriver(statuses=['running'] * 5)
    inst = build({'action': 'live', 'wait_for_turn': False}, driver)
    run(inst, 'hello there')
    assert driver.turns[0]['wait'] is False
    out = json.loads(inst.instance.of('writeText')[0][0])
    assert out['status'] == 'sent' and out['turn_statuses'] == ['running']


def test_live_failed_turn_raises():
    driver = LiveDriver(statuses=['failed'])
    inst = build({'action': 'live'}, driver)
    with pytest.raises(MaskyError, match='failed'):
        inst.writeText('hello there')
    assert inst.instance.of('writeText') == []


def test_live_failed_turn_raises_even_without_wait():
    driver = LiveDriver(statuses=['failed'])
    inst = build({'action': 'live', 'wait_for_turn': False}, driver)
    with pytest.raises(MaskyError, match='failed'):
        inst.writeText('hello there')


def test_live_running_turn_raises_when_waiting():
    driver = LiveDriver(statuses=['running'])
    inst = build({'action': 'live', 'wait_for_turn': True, 'timeout_sec': 120}, driver)
    with pytest.raises(MaskyError, match='Still rendering after 120 s'):
        inst.writeText('hello there')
    assert inst.instance.of('writeText') == []


def test_live_conversation_requested_per_record_with_configured_slug():
    driver = LiveDriver()
    inst = build({'action': 'live', 'conversation': 'c-26-10-abcd'}, driver)
    run(inst, 'one')
    run(inst, 'two')
    assert driver.conv_calls == ['c-26-10-abcd', 'c-26-10-abcd']
    assert {t['conversation_id'] for t in driver.turns} == {'C1'}
    assert len(inst.instance.of('writeText')) == 2


def test_live_blank_text_is_noop():
    driver = LiveDriver()
    inst = build({'action': 'live'}, driver)
    run(inst, '   ')
    assert driver.conv_calls == [] and driver.turns == [] and inst.instance.calls == []


def test_live_failed_turn_lists_the_turns_already_sent():
    text = _sentences(1200)
    assert len(core.split_turns(text)) >= 3
    driver = LiveDriver(statuses=['done', 'failed'])
    inst = build({'action': 'live', 'wait_for_turn': True}, driver)
    with pytest.raises(MaskyError) as e:
        inst.writeText(text)
    assert 'failed' in str(e.value) and 'T2' in str(e.value)
    assert 'Turns sent from this record so far: T1, T2.' in str(e.value)
    assert len(driver.turns) == 2  # nothing is sent after the failure
    assert inst.instance.of('writeText') == []


def test_live_running_turn_lists_the_turns_already_sent():
    text = _sentences(1200)
    driver = LiveDriver(statuses=['done', 'done', 'running'])
    inst = build({'action': 'live', 'wait_for_turn': True, 'timeout_sec': 60}, driver)
    with pytest.raises(MaskyError) as e:
        inst.writeText(text)
    assert 'Still rendering after 60 s' in str(e.value) and 'T3' in str(e.value)
    assert 'Turns sent from this record so far: T1, T2, T3.' in str(e.value)


def test_live_failed_first_turn_lists_itself():
    driver = LiveDriver(statuses=['failed'])
    inst = build({'action': 'live'}, driver)
    with pytest.raises(MaskyError, match='so far: T1'):
        inst.writeText('hello there')


# ---------------------------------------------------------------------------
# Cost cap: every action refuses before any driver or client request
# ---------------------------------------------------------------------------


class RecordingClient:
    """Stands in for MaskyClient under a real MaskyDriver; any request it receives is recorded.

    The free pricing read is answered with an error (the driver then uses its table) and is
    not counted, so ``calls == []`` means no tool, render or lookup traffic reached Masky.
    """

    def __init__(self):
        self.calls = []

    def get_video_pricing(self, *, timeout=5):
        raise MaskyError('Masky pricing is unreachable (ConnectionError).')

    def close(self):
        pass

    def __getattr__(self, name):
        if name.startswith('_'):
            raise AttributeError(name)

        def call(*args, **kwargs):
            self.calls.append(name)
            raise AssertionError(f'unexpected client request: {name}')

        return call


def _real(settings):
    client = RecordingClient()
    return build(settings, MaskyDriver(server_name='masky', client=client, settings=settings)), client


@pytest.mark.parametrize(
    ('settings', 'text', 'estimate'),
    [
        # 120 chars is 8 billed seconds of talking head: 0.213 credits
        (
            {'action': 'talking_head', 'output': 'video', 'default_avatar': 'A', 'max_credits_per_call': 0.2},
            'x' * 120,
            0.213,
        ),
        # personality mode assumes the avatar rewrites to 500 chars: 0.8755 credits however short the text
        (
            {
                'action': 'talking_head',
                'output': 'video',
                'text_mode': 'personality',
                'default_avatar': 'A',
                'max_credits_per_call': 0.8,
            },
            'hi',
            0.8755,
        ),
        # 5 s 720p draft scene video: 0.077 credits against a cap just under it
        (
            {
                'action': 'scene_video',
                'quality': '720p-draft',
                'duration_sec': 5,
                'default_avatar': 'A',
                'max_credits_per_call': 0.07,
            },
            'a fox',
            0.077,
        ),
        (
            {'action': 'scene_video', 'quality': '1080p', 'duration_sec': 5, 'max_credits_per_call': 0.25},
            'a fox',
            0.255,
        ),
        ({'action': 'image', 'engine': 'default', 'max_credits_per_call': 0.004}, 'a cat', 0.005),
        ({'action': 'image', 'engine': 'ideogram', 'max_credits_per_call': 0.01}, 'a cat', 0.015),
        (
            {
                'action': 'image',
                'edit_engine': 'qwen',
                'source_image_url': 'https://src/p.png',
                'max_credits_per_call': 0.02,
            },
            'a cat',
            0.03,
        ),
        ({'action': 'image', 'source_image_url': 'https://src/p.png', 'max_credits_per_call': 0.009}, 'a cat', 0.01),
    ],
    ids=[
        'talking-head',
        'talking-head-personality',
        'scene-video',
        'scene-video-1080p',
        'image',
        'image-ideogram',
        'edit-qwen',
        'edit-default',
    ],
)
def test_pipeline_action_over_the_cap_makes_no_client_request(settings, text, estimate):
    inst, client = _real(settings)
    with pytest.raises(MaskyError) as e:
        inst.writeText(text)
    assert 'cap' in str(e.value) and str(estimate) in str(e.value)
    assert client.calls == []
    assert inst.instance.calls == []


def test_live_total_over_the_cap_is_refused_although_each_turn_is_under_it():
    text = _sentences(1200)
    chunks = core.split_turns(text)
    per_turn = [core.estimate_turn(c, mode='chat', output='audio')['credits'] for c in chunks]
    cap = 0.1
    assert len(chunks) >= 3 and all(c <= cap for c in per_turn) and sum(per_turn) > cap

    driver = LiveDriver()
    inst = build({'action': 'live', 'max_credits_per_call': cap}, driver)
    with pytest.raises(MaskyError, match='cap') as e:
        inst.writeText(text)
    assert f'{len(chunks)} live turn(s)' in str(e.value)
    assert driver.conv_calls == [] and driver.turns == []
    assert inst.instance.calls == []


def test_live_total_equal_to_the_cap_is_allowed():
    text = _sentences(1200)
    total = round(sum(core.estimate_turn(c, mode='chat', output='audio')['credits'] for c in core.split_turns(text)), 3)
    driver = LiveDriver()
    inst = build({'action': 'live', 'max_credits_per_call': total}, driver)
    run(inst, text)
    assert len(driver.turns) == len(core.split_turns(text))
    refused = build({'action': 'live', 'max_credits_per_call': total - 0.001}, LiveDriver())
    with pytest.raises(MaskyError, match='cap'):
        refused.writeText(text)


def test_live_cap_uses_the_configured_mode_and_output():
    # a plain speak turn is far cheaper than a chat reply, so the same cap lets it through
    driver = LiveDriver()
    inst = build({'action': 'live', 'turn_mode': 'speak', 'turn_output': 'audio', 'max_credits_per_call': 0.01}, driver)
    run(inst, 'hello there')
    assert len(driver.turns) == 1
    chat = build(
        {'action': 'live', 'turn_mode': 'chat', 'turn_output': 'audio', 'max_credits_per_call': 0.01}, LiveDriver()
    )
    with pytest.raises(MaskyError, match='cap'):
        chat.writeText('hello there')


def test_live_over_the_cap_with_a_real_driver_sends_no_request():
    inst, client = _real(
        {
            'action': 'live',
            'conversation': 'c-existing',
            'turn_mode': 'chat',
            'turn_output': 'video',
            'max_credits_per_call': 0.5,
        }
    )
    with pytest.raises(MaskyError, match='cap'):
        inst.writeText('hello there')
    assert client.calls == []  # not even the conversation lookup


def test_live_cap_zero_turns_the_guard_off():
    driver = LiveDriver()
    inst = build({'action': 'live', 'turn_mode': 'chat', 'turn_output': 'video', 'max_credits_per_call': 0}, driver)
    run(inst, _sentences(1200))
    assert len(driver.turns) > 1


# ---------------------------------------------------------------------------
# Pipeline settings are passed to the driver explicitly
# ---------------------------------------------------------------------------


def test_talking_head_passes_text_mode():
    driver = FakeDriver(receipt('audio/mpeg', url='https://x/a.mp3'), make_mp3())
    inst = build({'action': 'talking_head', 'output': 'audio', 'text_mode': 'personality'}, driver)
    run(inst, 'hi')
    assert driver.speak[0]['text_mode'] == 'personality' and driver.speak[0]['output'] == 'audio'


def test_image_engine_depends_on_whether_there_is_a_source_image():
    png = make_png()
    generate = FakeDriver(receipt('image/png', job='image:I1', url='https://x/i.png'), png)
    run(build({'action': 'image', 'engine': 'ideogram', 'edit_engine': 'qwen'}, generate), 'a cat')
    assert generate.image == [{'prompt': 'a cat', 'source_url': '', 'engine': 'ideogram'}]

    edit = FakeDriver(receipt('image/png', job='image:I1', url='https://x/i.png'), png)
    run(
        build(
            {'action': 'image', 'engine': 'ideogram', 'edit_engine': 'qwen', 'source_image_url': 'https://src/p.png'},
            edit,
        ),
        'a cat',
    )
    assert edit.image == [{'prompt': 'a cat', 'source_url': 'https://src/p.png', 'engine': 'qwen'}]

    plain = FakeDriver(receipt('image/png', job='image:I1', url='https://x/i.png'), png)
    run(build({'action': 'image'}, plain), 'a cat')
    assert plain.image[0]['engine'] == 'default'


def test_scene_video_passes_every_pipeline_setting_explicitly():
    driver = VideoDriver(receipt(job='video:V1', kind='video'), make_mp4())
    run(build({'action': 'scene_video'}, driver), 'a fox')
    kw = driver.video[0]
    # the settings are absent here, so nothing is invented: the driver applies TOOL_DEFAULTS to None/empty values
    assert set(kw) == {
        'prompt',
        'resolution',
        'draft',
        'duration_sec',
        'fps',
        'aspect_ratio',
        'seed',
        'silent',
        'expand_prompt',
        'share',
        'image_url',
        'speech_text',
        'wait',
    }
    assert kw['resolution'] == '720p' and kw['draft'] is True


# ---------------------------------------------------------------------------
# Input checks that run before any driver call
# ---------------------------------------------------------------------------

BAD_SOURCES = ['ftp://host/p.png', 'file:///tmp/p.png', '/local/p.png', 'data:image/png;base64,AAAA', 'p.png']


@pytest.mark.parametrize('source', BAD_SOURCES)
def test_scene_video_non_http_source_image_is_refused_before_the_driver(source):
    driver = VideoDriver(receipt(), b'')
    inst = build({'action': 'scene_video', 'source_image_url': source}, driver)
    with pytest.raises(ValueError, match='http'):
        inst.writeText('a fox')
    assert driver.video == [] and driver.downloads == []


@pytest.mark.parametrize('source', BAD_SOURCES)
def test_image_non_http_source_image_is_refused_before_the_driver(source):
    driver = FakeDriver(receipt('image/png'), b'')
    inst = build({'action': 'image', 'source_image_url': source}, driver)
    with pytest.raises(ValueError, match='http'):
        inst.writeText('a cat')
    assert driver.image == [] and driver.downloads == []


@pytest.mark.parametrize('source', ['http://src/p.png', 'HTTPS://src/p.png'])
def test_http_source_images_are_accepted(source):
    driver = VideoDriver(receipt(job='video:V1'), make_mp4())
    run(build({'action': 'scene_video', 'source_image_url': source}, driver), 'a fox')
    assert driver.video[0]['image_url'] == source


def test_scene_video_speech_line_over_300_is_refused_before_the_driver():
    driver = VideoDriver(receipt(job='video:V1'), make_mp4())
    inst = build({'action': 'scene_video', 'speech_line': 'x' * 301}, driver)
    with pytest.raises(ValueError, match='301') as e:
        inst.writeText('a fox')
    assert '300' in str(e.value)
    assert driver.video == []
    ok = build({'action': 'scene_video', 'speech_line': 'x' * 300}, driver)
    run(ok, 'a fox')
    assert len(driver.video) == 1


# ---------------------------------------------------------------------------
# split_turns
# ---------------------------------------------------------------------------


def test_split_turns_blank():
    assert core.split_turns('') == []
    assert core.split_turns('   \n\t ') == []
    assert core.split_turns(None) == []


def test_split_turns_short_text_unchanged():
    assert core.split_turns('Hello there. How are you?') == ['Hello there. How are you?']
    assert core.split_turns('  spaced \n out  ') == ['spaced out']


def test_split_turns_limits_and_edges():
    text = _sentences(3000)
    turns = core.split_turns(text)
    assert len(turns) > 1
    assert all(0 < len(t) <= 500 for t in turns)
    assert all(t == t.strip() for t in turns)
    assert ' '.join(turns) == ' '.join(text.split())


def test_split_turns_single_long_word_is_cut():
    turns = core.split_turns('a' * 1000)
    assert [len(t) for t in turns] == [500, 500]


def test_split_turns_long_sentence_splits_between_words():
    words = [f'word{i}' for i in range(300)]
    text = ' '.join(words) + '.'
    assert len(text) > 500 and '. ' not in text
    turns = core.split_turns(text)
    assert len(turns) > 1 and all(len(t) <= 500 for t in turns)
    rebuilt = ' '.join(turns)
    assert rebuilt == text
    allowed = set(words) | {words[-1] + '.'}
    assert all(w in allowed for t in turns for w in t.split())


def test_split_turns_custom_limit():
    turns = core.split_turns('One two three. Four five six. Seven eight nine.', limit=20)
    assert turns == ['One two three.', 'Four five six.', 'Seven eight nine.']
    assert all(len(t) <= 20 for t in turns)
    assert core.split_turns('abcdefghij', limit=4) == ['abcd', 'efgh', 'ij']


# ---------------------------------------------------------------------------
# MaskyClient.download
# ---------------------------------------------------------------------------


class FakeResp:
    def __init__(self, status=200, chunks=(b'ab', b'cd')):
        self.status_code = status
        self.headers = {}
        self._chunks = chunks
        self.closed = False

    def iter_content(self, chunk_size=None):
        return iter(self._chunks)

    def close(self):
        self.closed = True


@pytest.fixture
def http(monkeypatch):
    req = make_requests()
    state = {'calls': [], 'resp': FakeResp()}

    def get(url, **kw):
        state['calls'].append((url, kw))
        return state['resp']

    req.get = get
    monkeypatch.setitem(sys.modules, 'requests', req)
    return state


def test_download_ok_without_auth(http):
    data = MaskyClient('SECRETKEY').download('https://signed/x')
    assert data == b'abcd'
    url, kw = http['calls'][0]
    assert url == 'https://signed/x' and kw.get('stream') is True
    blob = json.dumps({k: str(v) for k, v in kw.items()}).lower()
    assert 'authorization' not in blob and 'secretkey' not in blob
    assert 'auth' not in kw and not kw.get('headers')


def test_download_over_cap(http):
    http['resp'] = FakeResp(chunks=(b'abc', b'def'))
    with pytest.raises(MaskyError, match='larger than'):
        MaskyClient('k').download('https://signed/x', max_bytes=5)
    assert http['resp'].closed


def test_download_http_403(http):
    http['resp'] = FakeResp(status=403)
    with pytest.raises(MaskyError, match='expired'):
        MaskyClient('k').download('https://signed/x')


class UnconfirmedTurnDriver(LiveDriver):
    """Second turn comes back without an id, so the driver could not poll it."""

    def turn_job(self, **kw):
        self.turns.append(kw)
        n = len(self.turns)
        if n == 2:
            return {
                'turn_id': None,
                'status': 'running',
                'estimated_credits': self.credits,
                'unconfirmed': True,
                'warnings': [
                    'Not waited for: Masky did not return a turn id to poll. Check the conversation with get_turns.'
                ],
            }
        return {'turn_id': f'T{n}', 'status': 'done', 'estimated_credits': self.credits}


def test_live_unconfirmed_turn_is_marked_sent_and_record_continues():
    text = _sentences(1200)
    driver = UnconfirmedTurnDriver()
    inst = build(
        {'action': 'live', 'conversation': '', 'turn_mode': 'speak', 'turn_output': 'audio', 'wait_for_turn': True},
        driver,
    )
    run(inst, text)  # must not raise "Still rendering"

    chunks = len(driver.turns)
    assert chunks >= 3, 'every chunk of the record is still sent after the unconfirmed turn'
    receipt = json.loads(inst.instance.of('writeText')[0][0])
    assert receipt['status'] == 'sent'
    assert receipt['turn_statuses'][1] == 'sent'
    assert all(s == 'done' for i, s in enumerate(receipt['turn_statuses']) if i != 1)
    assert len(receipt['warnings']) == 1
    assert receipt['warnings'][0].startswith(f'Turn 2 of {chunks} was sent but could not be confirmed')
    assert 'did not return a turn id' in receipt['warnings'][0]
    assert 'Render Timeout' not in receipt['warnings'][0]


def test_live_receipt_has_no_warnings_when_every_turn_is_confirmed():
    driver = LiveDriver()
    inst = build(
        {'action': 'live', 'conversation': '', 'turn_mode': 'speak', 'turn_output': 'audio', 'wait_for_turn': True},
        driver,
    )
    run(inst, 'Hello there. How are you?')
    receipt = json.loads(inst.instance.of('writeText')[0][0])
    assert receipt['status'] == 'done' and 'warnings' not in receipt


def _box(kind, body=b''):
    return (8 + len(body)).to_bytes(4, 'big') + kind + body


@pytest.mark.parametrize(
    'data',
    [
        _box(b'ftyp', b'isom') + _box(b'moov', _box(b'mvhd')),  # empty mvhd at the very end
        _box(b'ftyp', b'isom') + _box(b'moov', _box(b'trak', _box(b'tkhd'))),  # empty tkhd at the very end
        _box(b'moov', _box(b'mvhd', b'\x00')),  # mvhd cut off after the version byte
    ],
)
def test_truncated_mp4_boxes_do_not_raise(data):
    # media_details runs after a paid render and download: a malformed file must degrade, not fail the record
    assert core.mp4_info(data) == {}
    assert core.media_details('video/mp4', data) == {'size_bytes': len(data)}


# ---------------------------------------------------------------------------
# Permission switches and the pipeline action
# ---------------------------------------------------------------------------


def test_read_only_does_not_affect_talking_head():
    driver = FakeDriver(receipt(), make_mp4())
    inst = build({'action': 'talking_head', 'output': 'video', 'read_only': True}, driver)
    run(inst, 'hello world')
    assert len(driver.speak) == 1 and driver.speak[0]['text'] == 'hello world'


def test_scene_video_public_refused_before_driver_call_when_switch_off():
    for extra in ({}, {'allow_public_sharing': False}):
        driver = VideoDriver(receipt(job='video:V1'), make_mp4())
        inst = build({'action': 'scene_video', 'share': 'public', **extra}, driver)
        with pytest.raises(ValueError, match='allowPublicSharing'):
            inst.writeText('a fox')
        assert driver.video == []


def test_scene_video_public_works_when_switch_on():
    driver = VideoDriver(receipt(job='video:V1'), make_mp4())
    inst = build({'action': 'scene_video', 'share': 'public', 'allow_public_sharing': True}, driver)
    run(inst, 'a fox')
    assert driver.video[0]['share'] == 'public'


def test_scene_video_private_works_without_switch():
    driver = VideoDriver(receipt(job='video:V1'), make_mp4())
    inst = build({'action': 'scene_video', 'share': 'private'}, driver)
    run(inst, 'a fox')
    assert driver.video[0]['share'] == 'private'


def test_pipeline_poll_failure_names_the_job_and_does_not_download():
    r = receipt(status='running', job='speak:G7')
    r['poll_error'] = 'Could not reach Masky (ConnectionError).'
    driver = FakeDriver(r, b'')
    inst = build({'action': 'talking_head'}, driver)
    with pytest.raises(MaskyError) as e:
        inst.writeText('hi')
    assert 'Could not check on job speak:G7 after Masky accepted it' in str(e.value)
    assert 'Still rendering' not in str(e.value) and driver.downloads == []


class FailingSecondTurnDriver(LiveDriver):
    def __init__(self, error):
        super().__init__()
        self.error = error

    def turn_job(self, **kw):
        if len(self.turns) == 1:
            self.turns.append(kw)
            raise self.error
        return super().turn_job(**kw)


def test_live_failure_mid_record_lists_the_turns_already_sent():
    driver = FailingSecondTurnDriver(MaskyError('Masky returned HTTP 500 for POST /conversations/C1/turn.'))
    inst = build(
        {'action': 'live', 'conversation': '', 'turn_mode': 'speak', 'turn_output': 'audio', 'wait_for_turn': True},
        driver,
    )
    with pytest.raises(MaskyError) as e:
        run(inst, _sentences(1200))
    assert 'Turns sent from this record before the failure: T1.' in str(e.value)


def test_live_failure_mid_record_keeps_the_status_and_credit_detail():
    error = MaskyError('Masky says you are out of credits.', status=402)
    error.credit_detail = ' (needs 9, available 2)'
    driver = FailingSecondTurnDriver(error)
    inst = build(
        {'action': 'live', 'conversation': '', 'turn_mode': 'speak', 'turn_output': 'audio', 'wait_for_turn': True},
        driver,
    )
    with pytest.raises(MaskyError) as e:
        run(inst, _sentences(1200))
    assert e.value.status == 402 and e.value.credit_detail == ' (needs 9, available 2)'
    assert 'Turns sent from this record before the failure: T1.' in str(e.value)


def test_live_cancellation_mid_record_stays_cancellation():
    driver = FailingSecondTurnDriver(MaskyCancelled('Cancelled while waiting for Masky to finish rendering.'))
    inst = build(
        {'action': 'live', 'conversation': '', 'turn_mode': 'speak', 'turn_output': 'audio', 'wait_for_turn': True},
        driver,
    )
    with pytest.raises(MaskyCancelled) as e:
        run(inst, _sentences(1200))
    assert 'T1' in str(e.value)
