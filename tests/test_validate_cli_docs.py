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

import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[1] / 'scripts' / 'validate-cli-docs.py'
SPEC = importlib.util.spec_from_file_location('validate_cli_docs', SCRIPT)
VALIDATOR = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(VALIDATOR)

TS = {
    'list': {'--json'},
    'deploy list': {'--json', '--team'},
    'deploy remove': {'--team'},
    'app dev': {'--open'},
    'app deploy': {'--json', '--publish'},
}
PY = {
    'list': {'--json'},
    'deploy list': {'--json', '--team'},
    'deploy remove': {'--team'},
    'app deploy': {'--json'},
    'diff': {'--git'},
}

GOOD_TABLE = """\
| Command or flag | TypeScript (`npm`) | Python (`pip`) |
|---|---|---|
| `app dev`, `app deploy --publish` | Yes | No |
| `diff` | No | Yes |
"""


def table_problems(rows):
    header = '| Command or flag | TypeScript (`npm`) | Python (`pip`) |\n|---|---|---|\n'
    return VALIDATOR.check_package_table(header + rows, TS, PY, 'doc')


def test_one_package_only_finds_commands_and_flags():
    assert VALIDATOR.one_package_only(TS, PY) == {
        'app dev': (True, False),
        'diff': (False, True),
        'app deploy --publish': (True, False),
    }


def test_exists_checks_the_command_and_its_flag():
    assert VALIDATOR.exists('app deploy --publish', TS)
    assert not VALIDATOR.exists('app deploy --publish', PY)
    assert VALIDATOR.exists('app deploy', PY)
    assert not VALIDATOR.exists('app ship', TS)


@pytest.mark.parametrize(
    ('path', 'code', 'found'),
    [
        ('deploy list', 'rocketride deploy list --team @me', True),
        ('list', 'rocketride deploy list', False),
        ('list', 'rocketride list --json', True),
        ('deploy remove', 'rocketride deploy enable|disable|remove <id>', True),
        ('deploy remove', 'rocketride deploy removed', False),
    ],
)
def test_mentioned(path, code, found):
    assert VALIDATOR.mentioned(path, code) is found


def test_check_mentions_reads_code_but_not_prose_or_shell_comments():
    doc = 'Run deploy list.\n\n```bash\nrocketride list\n# rocketride diff\n```\n\n`rocketride app dev`\n'
    problems = VALIDATOR.check_mentions(doc, TS, PY, 'doc')
    assert problems == [
        'doc: `rocketride app deploy` is not documented',
        'doc: `rocketride deploy list` is not documented',
        'doc: `rocketride deploy remove` is not documented',
        'doc: `rocketride diff` is not documented',
    ]


def test_package_table_accepts_the_real_differences():
    assert VALIDATOR.check_package_table(GOOD_TABLE, TS, PY, 'doc') == []


@pytest.mark.parametrize(
    ('rows', 'problem'),
    [
        ('| `app dev` | Yes | No |\n', 'missing `diff`'),
        ('| `app dev`, `app deploy --publish` | Yes | No |\n| `diff` | Yes | No |\n', 'wrong about `diff`'),
        (
            '| `app dev`, `app deploy --publish`, `deploy list --team` | Yes | No |\n| `diff` | No | Yes |\n',
            'lists `deploy list --team`, which both CLIs have',
        ),
        (
            '| `app dev`, `app deploy --publish` | Yes | No |\n| `diff` | No | Yes |\n| `deploy list --team` | Yes | Yes |\n',
            'lists `deploy list --team`, which both CLIs have',
        ),
        (
            '| `app dev`, `app deploy --publish`, `app ship` | Yes | No |\n| `diff` | No | Yes |\n',
            'lists `app ship`, which neither CLI has',
        ),
        ('| `app dev`, `app deploy --publish` | Yes |\n| `diff` | No | Yes |\n', 'doc:3: package table row must be'),
        (
            '| `app dev`, `app deploy --publish` | yes | no |\n| `diff` | No | Yes |\n',
            'doc:3: package table row must be',
        ),
    ],
)
def test_package_table_reports_each_mismatch(rows, problem):
    assert any(problem in line for line in table_problems(rows))


def test_package_table_must_exist():
    assert VALIDATOR.check_package_table('no table here', TS, PY, 'doc') == [
        "doc: no 'Command or flag | TypeScript | Python' table"
    ]


@pytest.mark.parametrize(
    ('code', 'problems'),
    [
        ('```bash\nrocketride deploy list --team @me --json\n```\n', []),
        ('```bash\nrocketride deploy list --teams @me\n```\n', ['doc: `rocketride deploy list` has no `--teams` flag']),
        ('`rocketride app deploy clock [--publish @me]`', []),
        ('```bash\nrocketride deploy list   # not --this one\n```\n', []),
        (
            '```bash\nrocketride deploy list|remove --json\n```\n',
            ['doc: `rocketride deploy remove` has no `--json` flag'],
        ),
        ('`rocketride list --json` and `rocketride diff --gti HEAD`', ['doc: `rocketride diff` has no `--gti` flag']),
    ],
)
def test_check_flags(code, problems):
    assert VALIDATOR.check_flags(code, TS, PY, 'doc') == problems


def test_commands_table_lists_every_top_level_command_and_nothing_else():
    mdx = '## Commands\n\n| Command | What |\n|---|---|\n| `list` | x |\n| `deploy` | x |\n| `app` | x |\n| `ship` | x |\n\n## Next\n'
    assert VALIDATOR.check_commands_table(mdx, TS, PY, 'site') == [
        'site: `diff` is missing from the Commands table',
        'site: Commands table lists `ship`, which neither CLI has',
    ]
