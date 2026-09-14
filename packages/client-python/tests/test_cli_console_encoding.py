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
Console-encoding tests for the RocketRide CLI.

The CLI draws box-drawing characters and echoes user-supplied file names. On a
console that cannot represent them - the default Windows code page, or any
POSIX terminal not set to UTF-8 - writing them raises UnicodeEncodeError and
aborts the command.

These run the CLI in a real subprocess with a narrow stdio encoding, because
that is the only way to reproduce the failure: the encoding is fixed when the
interpreter builds sys.stdout, before any test code could patch it.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest


SRC_DIR = Path(__file__).parent.parent / 'src'

# rocketride_common ships INSIDE the rocketride wheel, but from source it is a
# sibling package — the subprocess path must carry it explicitly (same reason
# as the sys.path insert in conftest.py).
COMMON_SRC_DIR = Path(__file__).parents[2] / 'client-common' / 'python' / 'src'

# A path the CLI will echo back but cannot encode as cp1252
CYRILLIC_PIPELINE = 'резервация.pipe'

# What a failed encode looks like, whichever way Python reports it
ENCODING_FAILURE_MARKERS = ('UnicodeEncodeError', "codec can't encode", 'codec can not encode')


def run_cli(argv, encoding, tmp_path, pipeline=None):
    """Run the CLI in a subprocess whose stdio uses the given encoding.

    The pipeline file goes through the ROCKETRIDE_PIPELINE env default, not
    the --pipeline flag: when sys.executable is the engine's embedded
    interpreter (how CI runs this suite), the wrapper parses argv before
    Python does and consumes --pipeline (and --args) as its own options,
    leaving the value behind as a stray positional. Both spellings feed the
    same argparse dest, so the CLI path under test is identical.
    """
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = encoding

    # Argparse defaults come from the environment; keep the ambient
    # configuration of whoever runs the suite out of the subprocess
    for name in ('ROCKETRIDE_URI', 'ROCKETRIDE_APIKEY', 'ROCKETRIDE_TOKEN', 'ROCKETRIDE_PIPELINE'):
        env.pop(name, None)
    if pipeline is not None:
        env['ROCKETRIDE_PIPELINE'] = pipeline

    # Invoked the way the installed console script is, so the process starts
    # in the same state a user's shell would put it in. The source paths are
    # injected INSIDE the bootstrap, not via PYTHONPATH: in CI sys.executable
    # is the engine's embedded interpreter, which runs in isolated mode and
    # ignores PYTHONPATH entirely — an env-var path never reaches it.
    entry = (
        f'import sys; sys.path[:0] = [{str(SRC_DIR)!r}, {str(COMMON_SRC_DIR)!r}]; '
        'from rocketride.cli.main import main; sys.exit(main())'
    )

    return subprocess.run(
        [sys.executable, '-c', entry, *argv],
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        env=env,
        cwd=str(tmp_path),
        timeout=120,
    )


@pytest.mark.parametrize('encoding', ['cp1252', 'ascii', 'utf-8'])
def test_status_screen_renders_on_any_console_encoding(encoding, tmp_path):
    """
    Regression: drawing the status box must not depend on a Unicode console.

    A missing pipeline file makes 'start' draw its frame and report the error
    without touching the network, which is the shortest path to the box-
    drawing characters that used to abort the command.
    """
    result = run_cli(['start', '--apikey', 'k'], encoding, tmp_path, pipeline='no-such.pipe')

    combined = result.stdout + result.stderr
    for marker in ENCODING_FAILURE_MARKERS:
        assert marker not in combined, f'{encoding} console: {combined}'

    # Naming the file proves the frame was drawn, not that the run died early
    assert result.returncode == 1
    assert 'Pipeline file not found: no-such.pipe' in combined


# Run only where argv can carry the name. Otherwise it fails to encode in this
# process and the CLI under test never starts.
requires_unicode_argv = pytest.mark.skipif(
    not CYRILLIC_PIPELINE.isascii() and not sys.getfilesystemencoding().lower().startswith('utf'),
    reason='filesystem encoding cannot represent a non-ASCII argument',
)


@requires_unicode_argv
@pytest.mark.parametrize('encoding', ['cp1252', 'ascii'])
def test_non_ascii_filename_does_not_abort_the_command(encoding, tmp_path):
    """
    Regression: a file name outside the console encoding must not crash.

    The name reaches the screen through the error path, so an unencodable
    character in it used to end the run with a traceback instead of a message.
    """
    result = run_cli(['start', '--apikey', 'k'], encoding, tmp_path, pipeline=CYRILLIC_PIPELINE)

    combined = result.stdout + result.stderr
    for marker in ENCODING_FAILURE_MARKERS:
        assert marker not in combined, f'{encoding} console: {combined}'

    # Only the prefix: the name itself is deliberately mangled on this console
    assert result.returncode == 1
    assert 'Pipeline file not found:' in combined
