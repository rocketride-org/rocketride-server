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
Unit tests for `rocketride --version`.

The flag must print the package's own version (rocketride.__version__, which
is read from the installed package metadata), not a hardcoded number, and exit
0 without needing a server or credentials. When the package runs from source
with no installed metadata, __version__ is empty and the flag prints "unknown".
"""

import importlib
import sys

import pytest

import rocketride

# `rocketride.cli.main` must be imported as a module: the `rocketride.cli`
# package re-exports the `main()` function under the same name.
cli_main = importlib.import_module('rocketride.cli.main')


def test_version_flag_prints_package_version(monkeypatch, tmp_path, capsys):
    """`rocketride --version` prints the package version and exits 0."""
    monkeypatch.chdir(tmp_path)  # keep any workspace .env out of the test
    monkeypatch.setattr(sys, 'argv', ['rocketride', '--version'])

    with pytest.raises(SystemExit) as exc:
        cli_main.main()

    assert exc.value.code == 0
    assert capsys.readouterr().out.strip() == f'rocketride {rocketride.__version__ or "unknown"}'


def test_version_flag_follows_package_version(monkeypatch, capsys):
    """The printed value comes from the package's __version__, not a literal."""
    monkeypatch.setattr(rocketride, '__version__', '9.8.7')

    with pytest.raises(SystemExit) as exc:
        cli_main.setup_parser().parse_args(['--version'])

    assert exc.value.code == 0
    assert capsys.readouterr().out.strip().endswith(' 9.8.7')


def test_version_flag_without_package_version(monkeypatch, capsys):
    """A package with no __version__ (the docs validator's stub) still builds the parser."""
    monkeypatch.delattr(rocketride, '__version__')

    with pytest.raises(SystemExit) as exc:
        cli_main.setup_parser().parse_args(['--version'])

    assert exc.value.code == 0
    assert capsys.readouterr().out.strip().endswith(' unknown')
