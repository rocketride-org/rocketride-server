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

"""Unit tests for the RocketRide CLI argument parser."""

import pytest

import rocketride
from rocketride.cli.main import setup_parser


@pytest.mark.parametrize('flag', ['-V', '--version'])
def test_version_flag_outputs_package_version(flag, capsys):
    """Root CLI parser supports -V / --version."""
    parser = setup_parser()
    with pytest.raises(SystemExit) as exc:
        parser.parse_args([flag])
    assert exc.value.code == 0
    captured = capsys.readouterr()
    expected = rocketride.__version__ or 'unknown'
    assert expected in captured.out


@pytest.mark.parametrize(
    ('subcmd', 'extra'),
    [
        ('dir', ['my-folder']),
        ('type', ['file.txt']),
        ('write', ['file.txt', '--content', 'hello']),
        ('rm', ['file.txt']),
        ('mkdir', ['new-dir']),
        ('stat', ['file.txt']),
    ],
)
def test_store_accepts_connection_args_before_and_after_subcommand(subcmd, extra):
    """Store accepts --uri and --apikey both before and after the subcommand."""
    parser = setup_parser()

    before = parser.parse_args(
        ['store', '--uri', 'http://before:5565', '--apikey', 'key-before', subcmd, *extra, '--json']
    )
    assert before.command == 'store'
    assert before.store_subcommand == subcmd
    assert before.uri == 'http://before:5565'
    assert before.apikey == 'key-before'
    assert before.json == '-'

    after = parser.parse_args(
        ['store', subcmd, *extra, '--uri', 'http://after:5565', '--apikey', 'key-after', '--json', 'out.json']
    )
    assert after.command == 'store'
    assert after.store_subcommand == subcmd
    assert after.uri == 'http://after:5565'
    assert after.apikey == 'key-after'
    assert after.json == 'out.json'


def test_profile_accepts_connection_args_before_and_after_subcommand():
    """Profile accepts --uri, --apikey, and --json both before and after the subcommand."""
    parser = setup_parser()

    before = parser.parse_args(['profile', '--uri', 'http://before:5565', '--apikey', 'key-before', 'list'])
    assert before.command == 'profile'
    assert before.profile_subcommand == 'list'
    assert before.uri == 'http://before:5565'
    assert before.apikey == 'key-before'

    after = parser.parse_args(['profile', 'list', '--uri', 'http://after:5565', '--apikey', 'key-after'])
    assert after.command == 'profile'
    assert after.profile_subcommand == 'list'
    assert after.uri == 'http://after:5565'
    assert after.apikey == 'key-after'
