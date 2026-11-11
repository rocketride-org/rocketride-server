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

from typing import Set, Tuple

from rocketlib import debug

# User-agent tokens, grouped by kind. Matching is a case-insensitive substring
# test: real UAs embed the token (Bing sends 'bingbot/2.0', lowercase).
# Robots-only tokens (Google-Extended) never appear in a UA; listing them
# here is harmless for detection and states policy in robots.txt.
CRAWLERS: Tuple[str, ...] = (
    # Search
    'Googlebot',
    'Bingbot',
    'DuckDuckBot',
    # AI
    'GPTBot',
    'OAI-SearchBot',
    'ChatGPT-User',
    'ClaudeBot',
    'Claude-User',
    'PerplexityBot',
    'Perplexity-User',
    'CCBot',
    'Google-Extended',
    # Unfurlers
    'facebookexternalhit',
    'Twitterbot',
    'LinkedInBot',
    'Slackbot',
    'Discordbot',
    'WhatsApp',
    'Applebot',
)

CRAWLER = 'crawler'
HUMAN = 'human'

_TOKENS = tuple(token.lower() for token in CRAWLERS)
_NON_BROWSER_HINTS = ('bot', 'crawl', 'spider', 'fetch', 'preview')
_seen_unknown: Set[str] = set()
_MAX_SEEN = 256


def classify(user_agent: str) -> str:
    """Classify a requester by its user agent: rostered crawler or human.

    Unknown UAs that do not look like a browser are logged once each (bounded)
    for roster upkeep. Spoofing either way is harmless: every document
    involved is public.

    Args:
        user_agent: The ``User-Agent`` header; empty or None reads as human.

    Returns:
        ``CRAWLER`` when the UA carries a rostered token, else ``HUMAN`` (an
        unknown UA takes the human path).
    """
    ua = (user_agent or '').lower()
    if any(token in ua for token in _TOKENS):
        return CRAWLER
    if not _looks_like_browser(ua):
        _note_unrostered(ua)
    return HUMAN


def _looks_like_browser(ua: str) -> bool:
    """Whether a lowercased user agent reads like a browser: ``mozilla/`` and none of the bot hints."""
    return 'mozilla/' in ua and not any(hint in ua for hint in _NON_BROWSER_HINTS)


def _note_unrostered(ua: str) -> None:
    """Log an unrostered non-browser user agent once, up to ``_MAX_SEEN`` of them, for roster upkeep."""
    key = ua[:200]
    if key in _seen_unknown or len(_seen_unknown) >= _MAX_SEEN:
        return
    _seen_unknown.add(key)
    debug(f'[public_pages] unrostered non-browser user agent (served the human document): {key!r}')


def robots_groups(rule: str) -> str:
    """One robots.txt group per rostered token, then ``*``, each carrying ``rule``.

    RFC 9309: a crawler obeys only its most specific matching group and
    ignores the rest (``*`` included), so a rule meant for everyone is
    repeated in every group.

    Args:
        rule: The group's rule lines, e.g. ``'Allow: /'``.

    Returns:
        The groups, each ``User-agent: <token>``, the rule and a blank line.
    """
    tokens = list(dict.fromkeys(CRAWLERS))
    return ''.join(f'User-agent: {token}\n{rule}\n\n' for token in tokens + ['*'])
