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
depends.py hook: in model server mode no install plan may pull torch in.

The GPU import guard (``ai.common.models.gpu_guard``) is a ``sys.meta_path``
hook: it stops imports, not installs. A node's own requirements can bring
torch in as another package's dependency, which only the resolved plan shows.
Under ``--modelserver`` this hook refuses such a plan before anything is
fetched, and pre-excludes the torch wheels while the plan is still unresolved.
Without a model server it does nothing: the task loads torch itself, hosted
or not. Standard library plus ``hosting`` only (see depends.py "Hook files").
"""

from hosting import delegates_to_model_server

_FORBIDDEN = ('torch', 'torchvision', 'torchaudio')


def excludes(packages):
    """See depends.py's "Hook files" section for the stage contract."""
    if not delegates_to_model_server():
        return None

    present = sorted({p for p in packages if p.lower().replace('_', '-') in _FORBIDDEN})
    if present:
        raise RuntimeError(
            f'{", ".join(present)} would be installed, and torch is never installed in model server mode: '
            f'GPU inference runs on the model server.'
        )
    return list(_FORBIDDEN)
