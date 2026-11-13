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

"""The crawler roster: one constant drives the robots.txt named groups."""

from __future__ import annotations

from ai.modules.shell.crawlers import CRAWLERS, robots_groups


def test_roster_tokens_are_unique():
    tokens = [t.lower() for t in CRAWLERS]
    assert len(tokens) == len(set(tokens))


def test_robots_groups_render_every_roster_token_then_star_with_the_rule():
    body = robots_groups('Allow: /')
    for token in CRAWLERS:
        assert f'User-agent: {token}\nAllow: /\n\n' in body
    assert body.endswith('User-agent: *\nAllow: /\n\n')
    # RFC 9309: the rule is repeated in every group, never only in '*'.
    assert body.count('Allow: /') == len(CRAWLERS) + 1
