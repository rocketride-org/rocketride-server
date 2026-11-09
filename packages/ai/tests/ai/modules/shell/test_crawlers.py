# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""The crawler roster: one constant drives UA classification and the robots.txt named groups."""

from __future__ import annotations

import pytest

import ai.modules.shell.crawlers as crawlers
from ai.modules.shell.crawlers import CRAWLER, CRAWLERS, HUMAN, classify, robots_groups

REAL_UAS = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0)',
    'CCBot/2.0 (https://commoncrawl.org/faq/)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'WhatsApp/2.23.20.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1)',
]

BROWSERS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
]


@pytest.mark.parametrize('ua', REAL_UAS)
def test_rostered_crawlers_classify_as_crawler(ua):
    assert classify(ua) == CRAWLER


@pytest.mark.parametrize('ua', BROWSERS + ['', 'curl/8.4.0', 'SomeNewBot/1.0'])
def test_everything_else_is_human(ua):
    assert classify(ua) == HUMAN


def test_unknown_non_browser_uas_are_logged_once_and_bounded(monkeypatch):
    logged = []
    monkeypatch.setattr(crawlers, '_seen_unknown', set())
    monkeypatch.setattr('rocketlib.debug', lambda msg: logged.append(msg))
    classify('SomeNewBot/1.0')
    classify('SomeNewBot/1.0')
    classify(BROWSERS[0])
    assert len(logged) == 1 and 'somenewbot' in logged[0]
    monkeypatch.setattr(crawlers, '_MAX_SEEN', 1)
    classify('OtherBot/2.0')
    assert len(logged) == 1


def test_roster_tokens_are_unique_and_categorised():
    tokens = [t.lower() for t, _ in CRAWLERS]
    assert len(tokens) == len(set(tokens))
    assert {c for _, c in CRAWLERS} <= {'search', 'ai', 'unfurl'}


def test_robots_groups_render_every_roster_token_then_star_with_the_rule():
    body = robots_groups('Allow: /')
    for token, _ in CRAWLERS:
        assert f'User-agent: {token}\nAllow: /\n\n' in body
    assert body.endswith('User-agent: *\nAllow: /\n\n')
    # RFC 9309: the rule is repeated in every group, never only in '*'.
    assert body.count('Allow: /') == len(CRAWLERS) + 1
