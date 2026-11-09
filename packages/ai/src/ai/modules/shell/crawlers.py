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

"""
The named-crawler roster: one constant for detection and for the robots.txt policy.

The same tuple classifies requesters on public pages (crawler or human) and
renders the app origin's robots.txt named groups, so the policy a bot reads
and the detection that serves it cannot drift.

The docs site (a separate origin) keeps its hand-authored policy in
docs/docusaurus/static/robots.txt; its named groups follow the same intent.
"""

from typing import Tuple

# (user-agent token, category). Matching is a case-insensitive substring
# test: real UAs embed the token (Bing sends 'bingbot/2.0', lowercase).
# Robots-only tokens (Google-Extended) never appear in a UA; listing them
# here is harmless for detection and states policy in robots.txt.
CRAWLERS: Tuple[Tuple[str, str], ...] = (
    # Search
    ('Googlebot', 'search'),
    ('Bingbot', 'search'),
    ('DuckDuckBot', 'search'),
    # AI
    ('GPTBot', 'ai'),
    ('OAI-SearchBot', 'ai'),
    ('ChatGPT-User', 'ai'),
    ('ClaudeBot', 'ai'),
    ('Claude-User', 'ai'),
    ('PerplexityBot', 'ai'),
    ('Perplexity-User', 'ai'),
    ('CCBot', 'ai'),
    ('Google-Extended', 'ai'),
    # Unfurlers
    ('facebookexternalhit', 'unfurl'),
    ('Twitterbot', 'unfurl'),
    ('LinkedInBot', 'unfurl'),
    ('Slackbot', 'unfurl'),
    ('Discordbot', 'unfurl'),
    ('WhatsApp', 'unfurl'),
    ('Applebot', 'unfurl'),
)

CRAWLER = 'crawler'
HUMAN = 'human'

_TOKENS = tuple(token.lower() for token, _ in CRAWLERS)
_NON_BROWSER_HINTS = ('bot', 'crawl', 'spider', 'fetch', 'preview')
_seen_unknown: set = set()
_MAX_SEEN = 256


def classify(user_agent: str) -> str:
    """CRAWLER for a rostered UA, HUMAN otherwise (an unknown UA takes the human path).

    Unknown UAs that do not look like a browser are logged once each (bounded)
    for roster upkeep. Spoofing either way is harmless: every document
    involved is public.
    """
    ua = (user_agent or '').lower()
    if any(token in ua for token in _TOKENS):
        return CRAWLER
    if (not ua or 'mozilla/' not in ua or any(h in ua for h in _NON_BROWSER_HINTS)) and len(_seen_unknown) < _MAX_SEEN:
        key = ua[:200]
        if key not in _seen_unknown:
            _seen_unknown.add(key)
            from rocketlib import debug

            debug(f'[public_pages] unrostered non-browser user agent (served the human document): {key!r}')
    return HUMAN


def robots_groups(rule: str) -> str:
    """One robots.txt group per rostered token, then ``*``, each carrying ``rule``.

    RFC 9309: a crawler obeys only its most specific matching group and
    ignores the rest (``*`` included), so a rule meant for everyone is
    repeated in every group.
    """
    tokens = list(dict.fromkeys(token for token, _ in CRAWLERS))
    return ''.join(f'User-agent: {token}\n{rule}\n\n' for token in tokens + ['*'])
