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

"""
GPU library import guard for model server mode.

When ``--modelserver`` is set, all GPU inference runs on the model server
via RPC (``ModelClient``).  Subprocess nodes should never load GPU
libraries directly — doing so wastes VRAM, bypasses billing, and risks
CUDA context conflicts.

This module installs a ``sys.meta_path`` import hook that blocks
``torch``, ``tensorflow``, ``onnxruntime``, ``cupy``, and their
submodules.  Any ``import torch`` in a node will raise ``ImportError``
with a clear message directing the developer to use ``ai.common.models``.

Usage (called once from ``ai.node.run()``)::

    from ai.common.models.gpu_guard import install_gpu_guard

    install_gpu_guard()

The hook is only installed when ``get_model_server_address()`` returns
a non-None value — in local mode, GPU libraries load normally.
"""

import sys
from typing import Optional

from .base import get_model_server_address


# ============================================================================
# BLOCKED MODULES
# ============================================================================

# Top-level GPU library module names to block in model server mode.
# Submodules (e.g. torch.nn, tensorflow.keras) are caught automatically
# because Python resolves the parent module first.
_BLOCKED_MODULES = frozenset(
    {
        'torch',
        'tensorflow',
        'onnxruntime',
        'cupy',
    }
)


# ============================================================================
# IMPORT HOOK
# ============================================================================


class _GPUImportBlocker:
    """
    ``sys.meta_path`` finder that blocks GPU library imports.

    When Python's import machinery encounters a module name, it calls
    ``find_module`` on each entry in ``sys.meta_path``.  This class
    intercepts blocked module names and raises ``ImportError`` before
    the real finder can load them.

    Attributes:
        _blocked: Frozenset of top-level module names to block.
    """

    def __init__(self, blocked: frozenset):
        """
        Initialize the blocker with the set of module names to block.

        Args:
            blocked: Frozenset of top-level module names (e.g. ``{'torch'}``).
        """
        self._blocked = blocked

    def find_module(self, fullname: str, path: Optional[str] = None):
        """
        Check if the requested module should be blocked.

        Called by Python's import machinery for every import.  Returns
        ``self`` (the loader) if the module is blocked, signalling that
        this finder will handle it.  Returns ``None`` to let the next
        finder in ``sys.meta_path`` handle it.

        Args:
            fullname: Fully qualified module name (e.g. ``'torch.nn'``).
            path: Module search path (unused).

        Returns:
            ``self`` if blocked, ``None`` otherwise.
        """
        # Extract the top-level package name (e.g. 'torch' from 'torch.nn.functional')
        top_level = fullname.split('.')[0]

        # Check if this top-level package is in our blocked set
        if top_level in self._blocked:
            return self

        # Not blocked — let the normal import machinery handle it
        return None

    def load_module(self, fullname: str):
        """
        Raise ImportError for blocked modules.

        Called by Python after ``find_module`` returns ``self``.  Always
        raises ``ImportError`` with a descriptive message explaining why
        the import is blocked and what to use instead.

        Args:
            fullname: Fully qualified module name being imported.

        Raises:
            ImportError: Always — this is the whole point of the guard.
        """
        raise ImportError(
            f'Direct import of "{fullname}" is blocked in model server mode. '
            f'GPU inference runs on the model server via ai.common.models. '
            f'Do not import GPU libraries directly in nodes.'
        )


# ============================================================================
# INSTALLATION
# ============================================================================

# Track whether the guard has been installed to prevent double-installation
_installed = False


def install_gpu_guard():
    """
    Install the GPU import guard if running in model server mode.

    Checks ``get_model_server_address()`` to determine if ``--modelserver``
    was passed on the command line.  If so, installs the import hook at
    the front of ``sys.meta_path`` so it intercepts imports before the
    default finders.

    Safe to call multiple times — subsequent calls are no-ops.

    Called once from ``ai.node.run()`` during subprocess startup.
    """
    global _installed

    # Only install once
    if _installed:
        return

    # Check if we are in model server mode
    server_addr = get_model_server_address()
    if server_addr is None:
        # Local mode — GPU libraries are needed, don't block anything
        return

    # Install the blocker at the front of sys.meta_path so it runs
    # before the default finders can locate and load the real module
    blocker = _GPUImportBlocker(_BLOCKED_MODULES)
    sys.meta_path.insert(0, blocker)

    _installed = True
