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
``rocketride --version`` on the Python CLI.

The TypeScript CLI has registered commander's ``.version(SDK_VERSION)`` since it
existed; the Python CLI had no equivalent, so the first command anyone runs
after an install ended in a usage error instead of reporting the installed
SDK (#3186).
"""

import pytest

from rocketride.cli.main import _sdk_version, setup_parser


def test_version_flag_prints_the_sdk_and_exits_zero(capsys):
    """``rocketride --version`` answers with the SDK version and exits 0.

    Before #3186 this was an argparse usage error: ``--version`` was an
    unrecognised argument, so the command failed instead of reporting.
    """
    with pytest.raises(SystemExit) as excinfo:
        setup_parser().parse_args(['--version'])

    assert excinfo.value.code == 0

    printed = capsys.readouterr().out.strip()
    name, separator, version = printed.partition(' ')
    assert name == 'rocketride'
    assert separator, f'expected "<name> <version>", got {printed!r}'
    assert version == _sdk_version()
    # Never blank: an editable install without metadata falls back to 'unknown'
    # rather than printing an empty string.
    assert version


def test_version_is_never_blank():
    """Whatever the install state, the flag has something to say."""
    assert _sdk_version()


def test_help_advertises_the_flag(capsys):
    """The new flag is discoverable from ``--help``."""
    with pytest.raises(SystemExit) as excinfo:
        setup_parser().parse_args(['--help'])

    assert excinfo.value.code == 0
    assert '--version' in capsys.readouterr().out


def test_version_needs_no_subcommand():
    """``--version`` is answered during parsing, before any command runs.

    It therefore needs neither a subcommand nor the environment a command
    would load, which is what makes it usable straight after an install.
    """
    with pytest.raises(SystemExit) as excinfo:
        setup_parser().parse_args(['--version'])

    assert excinfo.value.code == 0
