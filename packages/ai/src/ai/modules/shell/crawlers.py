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
The named-crawler roster behind the app origin's robots.txt named groups.

The docs site (a separate origin) keeps its hand-authored policy in
docs/docusaurus/static/robots.txt; its named groups follow the same intent.
"""

from typing import Tuple

# User-agent tokens, grouped by kind. Robots-only tokens (Google-Extended)
# never appear in a UA; listing them states policy in robots.txt.
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
    return ''.join(f'User-agent: {token}\n{rule}\n\n' for token in list(CRAWLERS) + ['*'])
