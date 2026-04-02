# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide
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

"""Install the ``en_core_web_sm`` spaCy model matching the installed spaCy version.

spaCy model wheels are not on PyPI — they live on GitHub Releases and the wheel
version **must match** the installed spaCy major.minor (e.g. spaCy 3.8.x requires
``en_core_web_sm-3.8.0``).  Hardcoding the URL in a requirements file couples the
model to a specific spaCy release; this module derives the URL at runtime instead.
"""

import subprocess
import sys


def ensure_spacy_en_model() -> None:
    """Install ``en_core_web_sm`` for the installed spaCy version if not already present.

    Skips silently when the model is already importable.  If spaCy is not yet
    installed this function returns without error — a missing spaCy import will
    produce a clearer error message when ``KPipeline`` is actually constructed.

    The install is performed via a subprocess ``pip install <wheel-url>`` so it
    works inside any virtual environment that pip can reach, including those
    managed by ``depends()``.  stdout and stderr are suppressed; the caller sees
    a ``subprocess.CalledProcessError`` if pip fails.

    Raises:
        subprocess.CalledProcessError: If pip exits with a non-zero status while
            installing the wheel.
    """
    try:
        import en_core_web_sm  # noqa: F401 — presence check only

        return
    except ImportError:
        pass

    try:
        import spacy
    except ImportError:
        return  # spaCy absent; KPipeline import will raise a clearer error

    major, minor = spacy.__version__.split('.')[:2]
    model_ver = f'{major}.{minor}.0'
    url = f'https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-{model_ver}/en_core_web_sm-{model_ver}-py3-none-any.whl'
    subprocess.run(
        [sys.executable, '-m', 'pip', 'install', url],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
