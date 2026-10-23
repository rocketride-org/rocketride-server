# =============================================================================
# RocketRide Engine
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

"""Wording checks for the rocketride_sql node's description, README and docstrings.

The node's text describes its database as the one chosen under Database
(organization, team or personal), which the task engine authorizes and delivers
at task start. These checks read the node's files from disk; no engine,
database or driver is needed.
"""

from __future__ import annotations

from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_SQL_NODE_DIR = _REPO / 'nodes' / 'src' / 'nodes' / 'rocketride_sql'

# How the docs used to describe the database: the signed-in user's, and later
# always the organization's. The task engine resolves the database the node's
# Database setting names (organization, team or personal), so these phrases
# describe the wrong model.
_STALE_TENANT_PHRASES = (
    'signed-in rocketride identity',
    'signed-in rocketride tenant',
    'authenticated client_id',
    "your organization's database",
    "your organization's managed rocketride database",
    'per organization for its managed database nodes',
    "for the pipeline's organization",
)


def _prose(path: Path) -> str:
    """A file's text with comment markers, backquotes and line breaks folded away, lower-cased.

    A services.json description is an array of strings shown joined, so the
    seams between its strings are folded away too.
    """
    text = path.read_text(encoding='utf-8')
    text = text.replace('``', '').replace('`', '').replace('", "', '')
    lines = [line.strip().lstrip('#').lstrip('/').strip() for line in text.splitlines()]
    return ' '.join(' '.join(lines).split()).lower()


class TestSqlTenancyWording:
    """rocketride_sql describes its database as the one its Database setting names."""

    def test_no_text_describes_the_signed_in_user_as_the_tenant(self):
        stale = [
            f'{path.name}: {phrase!r}'
            for path in sorted(_SQL_NODE_DIR.iterdir())
            if path.suffix in ('.py', '.json', '.md')
            for phrase in _STALE_TENANT_PHRASES
            if phrase in _prose(path)
        ]
        assert stale == []

    def test_description_and_readme_point_at_the_database_choice(self):
        assert 'the connection to the database you choose' in _prose(_SQL_NODE_DIR / 'services.json')
        assert 'the managed database chosen under database' in _prose(_SQL_NODE_DIR / 'README.md')
