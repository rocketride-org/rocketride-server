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
Tests for the upload command's --max-concurrent flag.

Parser-only: nothing connects. The flag has to match the TypeScript CLI, where
--threads is the pipeline thread count and --max-concurrent is the upload fan-out.
"""

import pytest

from rocketride.cli.main import RocketRideCLI


def parse_upload(*argv):
    """Parse an upload command line with the given extra flags."""
    return RocketRideCLI().setup_parser().parse_args(['upload', '--token', 'tok', *argv, 'a.txt'])


def test_defaults_match_typescript_cli():
    args = parse_upload()

    assert args.threads == 4
    assert args.max_concurrent == 5


def test_flags_are_independent():
    args = parse_upload('--threads', '8', '--max-concurrent', '2')

    assert args.threads == 8
    assert args.max_concurrent == 2


@pytest.mark.parametrize('value', ['0', '-1', '2.5', 'five'])
def test_rejects_invalid_max_concurrent(value, capsys):
    """A bad limit is refused at parse time, before any pipeline is started."""
    with pytest.raises(SystemExit):
        parse_upload('--max-concurrent', value)

    assert 'must be a positive integer' in capsys.readouterr().err
