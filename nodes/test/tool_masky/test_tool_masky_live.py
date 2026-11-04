# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Key-gated live tests for the tool_masky node (free, read-only calls only).

Skipped unless ``ROCKETRIDE_MASKY_KEY`` is set. The real ``MaskyClient`` is
wrapped so that ``_send`` raises for anything other than GET, and for any path
outside {/voices, /avatars, /videos/pricing}: no paid or write call can happen.
The key and request URLs are never printed or asserted on.
"""

from __future__ import annotations

import os

import pytest

from ._stubs import scoped_stubs

pytestmark = pytest.mark.skipif(not os.environ.get('ROCKETRIDE_MASKY_KEY'), reason='ROCKETRIDE_MASKY_KEY is not set')

import requests  # noqa: E402,F401  (real; imported before the stubs so it is never replaced)

# 'requests' and 'depends' are deliberately NOT stubbed: the client uses the real library.
with scoped_stubs(stub_network=False):
    from tool_masky.masky_client import MaskyClient  # noqa: E402
    from tool_masky.masky_driver import MaskyDriver  # noqa: E402
    from tool_masky import masky_core as core  # noqa: E402

ALLOWED_PATHS = ('/voices', '/avatars', '/videos/pricing')


class FreeOnlyClient(MaskyClient):
    """Real client whose transport refuses everything but GET on the free read endpoints."""

    def __init__(self, api_key: str) -> None:
        super().__init__(api_key)
        self.sent = []  # (method, path) of every request that reached the network layer

    def _send(self, method, path, body, auth):  # noqa: ANN001, ANN201
        if method != 'GET':
            raise AssertionError(f'live test attempted a non-GET request: {method}')
        if path not in ALLOWED_PATHS:
            raise AssertionError(f'live test attempted a path outside the allowlist: {path}')
        self.sent.append((method, path))
        return super()._send(method, path, body, auth)

    def get_video_pricing(self, *, timeout=5):  # noqa: ANN001, ANN201
        # This method bypasses _send (plain requests.get, no auth); record it and pin the path.
        self.sent.append(('GET', '/videos/pricing'))
        return super().get_video_pricing(timeout=timeout)


@pytest.fixture
def client():
    c = FreeOnlyClient(os.environ['ROCKETRIDE_MASKY_KEY'])
    yield c
    c.close()


def _run(d, tool, **args):
    return d._tool_invoke(tool_name=f'masky.{tool}', input_obj=args)


def test_guard_blocks_writes_and_unlisted_paths(client):
    with pytest.raises(AssertionError):
        client._send('POST', '/voices', {}, True)
    with pytest.raises(AssertionError):
        client._send('GET', '/speak', None, True)
    assert client.sent == []


def test_list_voices_live(client):
    d = MaskyDriver(server_name='masky', client=client)
    out = _run(d, 'list_voices')
    voices = out['voices']
    assert len(voices) > 0
    for v in voices[:20]:
        assert v['voice_id'] and v['name'] and v['kind']
    assert {p for _, p in client.sent} == {'/voices'}


def test_list_avatars_live(client):
    d = MaskyDriver(server_name='masky', client=client)
    out = _run(d, 'list_avatars')
    assert out['count'] == len(out['avatars'])
    for a in out['avatars']:
        assert a['avatar_id']
    assert {p for _, p in client.sent} == {'/avatars'}


def test_load_pricing_live_returns_parsed_rates(client):
    d = MaskyDriver(server_name='masky', client=client)
    rates = d.load_pricing()
    assert rates is not None
    assert ('720p', True) in rates['video_per_sec']
    assert all(isinstance(r, float) and r > 0 for r in rates['video_per_sec'].values())
    assert d.load_pricing() is rates
    assert client.sent == [('GET', '/videos/pricing')]


def test_estimate_cost_makes_no_http_requests(client):
    d = MaskyDriver(server_name='masky', client=client)
    live_rates = d.load_pricing()
    client.sent.clear()
    speak = _run(d, 'estimate_cost', kind='speak', text='Hello from the live test.', output='audio')
    video = _run(d, 'estimate_cost', kind='video', resolution='720p', draft=True, duration_sec=5)
    assert speak['estimated_credits'] > 0
    # Whatever Masky charges today, the estimate uses the higher of its live rate and the
    # dated table, for 5 s plus the billing margin. (Not the basis label: that depends on prices.)
    table = core.PRICES['video_per_sec'][('720p', True)]
    live = (live_rates or {}).get('video_per_sec', {}).get(('720p', True)) or table
    seconds = 5 + core.VIDEO_BILLING_MARGIN_SEC
    assert video['estimated_credits'] == core.round_up_credits(seconds * max(live, table))
    assert client.sent == []
