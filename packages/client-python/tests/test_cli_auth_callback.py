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

"""The post-login callback page (#2850): branded, themed, closes on success with no redirect; failures explain themselves (TS renderCallbackPage twin)."""

import json
import re
import threading
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

from rocketride.cli.commands.auth import (
    CALLBACK_PALETTES,
    _authorize_via_loopback,
    _render_callback_page,
    web_app_url_for,
)
from rocketride.cli.utils.output import Output

THEMES = Path(__file__).resolve().parents[2] / 'shell' / 'public' / 'themes'


def _script_of(page):
    match = re.search(r'<script>([\s\S]*)</script>', page)
    return match.group(1) if match else ''


def test_success_is_branded_themed_and_never_redirects():
    page = _render_callback_page(True, web_url='https://api.rocketride.ai/')

    assert "<h1>You're signed in</h1>" in page
    assert '<span>RocketRide</span>' in page
    assert 'fill="#F93822"' in page
    assert '@media (prefers-color-scheme:dark)' in page
    assert _script_of(page) == 'window.close();'
    assert not re.search(r'location\.(replace|assign|href)', page)
    assert '<a class="btn" href="https://api.rocketride.ai/">Open RocketRide</a>' in page


@pytest.mark.parametrize('web_url', ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'http:example', None])
def test_no_button_without_a_usable_web_url(web_url):
    page = _render_callback_page(True, web_url=web_url)

    assert 'class="btn"' not in page
    assert 'javascript:' not in page
    assert _script_of(page) == 'window.close();'


def test_failure_is_escaped_branded_with_no_script():
    page = _render_callback_page(False, error='access_denied <b>by user</b>')

    assert '<h1>Sign-in failed</h1>' in page
    assert 'access_denied &lt;b&gt;by user&lt;/b&gt;' in page
    assert '<span>RocketRide</span>' in page
    assert '<script>' not in page


@pytest.mark.parametrize(('mode', 'theme_id'), [('dark', 'rocketride'), ('light', 'rocketride-light')])
def test_palettes_match_the_web_app_themes(mode, theme_id):
    tokens = json.loads((THEMES / f'{theme_id}.json').read_text(encoding='utf-8'))

    assert CALLBACK_PALETTES[mode] == {
        'bg': tokens['--rr-bg-default'],
        'paper': tokens['--rr-bg-paper'],
        'text': tokens['--rr-text-primary'],
        'muted': tokens['--rr-text-secondary'],
        'border': tokens['--rr-border'],
        'buttonBg': tokens['--rr-bg-button'],
        'buttonFg': tokens['--rr-fg-button'],
        'success': tokens['--rr-color-success'],
        'error': tokens['--rr-color-error'],
    }


@pytest.mark.parametrize(
    ('server_base', 'expected'),
    [
        ('https://api.rocketride.ai', 'https://rocketride.ai/'),
        ('https://API.rocketride.ai/', 'https://rocketride.ai/'),
        ('https://api.rocketride.ai:443', 'https://rocketride.ai/'),
        ('https://api.rocketride.ai:8443', 'https://api.rocketride.ai:8443/'),
        ('http://localhost:5565', 'http://localhost:5565/'),
        ('https://rr.example.com/', 'https://rr.example.com/'),
    ],
)
def test_web_app_url_for(server_base, expected):
    assert web_app_url_for(server_base) == expected


def test_waitlisted_page_shows_the_queue_notice_without_closing():
    page = _render_callback_page(True, web_url='https://rocketride.ai/', waitlisted=True)

    assert "<h1>You're on the list</h1>" in page
    assert "You're signed in" not in page
    assert '<a class="btn" href="https://rocketride.ai/">Open RocketRide</a>' in page
    assert '<script>' not in page


def _follow(query):
    """Start a loopback sign-in whose "browser" follows the redirect with ``query``; returns (grant/error, page box)."""
    box = {}

    def browser(authorize_url):
        redirect_uri = urllib.parse.parse_qs(urllib.parse.urlparse(authorize_url).query)['redirect_uri'][0]

        def fetch():
            with urllib.request.urlopen(f'{redirect_uri}?{query}', timeout=10) as res:  # noqa: S310 (loopback)
                box['page'] = res.read().decode('utf-8')

        box['thread'] = threading.Thread(target=fetch, daemon=True)
        box['thread'].start()

    return box, lambda: _authorize_via_loopback(
        'https://idp.test', 'client', 'challenge', Output(None), open_browser=browser
    )


def test_loopback_holds_the_browser_until_the_outcome_is_known():
    box, run = _follow('code=abc')
    grant, finish = run()
    box['thread'].join(0.3)

    assert grant['code'] == 'abc'
    assert 'page' not in box

    finish(_render_callback_page(False, error='Token exchange rejected by test server'))
    box['thread'].join(5)

    assert '<h1>Sign-in failed</h1>' in box['page']
    assert 'Token exchange rejected by test server' in box['page']
    assert "You're signed in" not in box['page']
    assert 'window.close()' not in box['page']


def test_loopback_answers_a_provider_error_at_once():
    box, run = _follow('error=access_denied&error_description=nope')

    with pytest.raises(RuntimeError, match='Sign-in was rejected: nope'):
        run()
    box['thread'].join(5)
    assert '<h1>Sign-in failed</h1>' in box['page']
