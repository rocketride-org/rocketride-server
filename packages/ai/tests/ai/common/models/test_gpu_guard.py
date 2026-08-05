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
Unit tests for the GPU import guard (gpu_guard.py).

Tests verify that:
- When --modelserver is set, importing GPU libraries raises ImportError.
- When --modelserver is NOT set, no hook is installed.
- Submodules of blocked libraries are also blocked.
- The hook is idempotent (safe to call multiple times).
"""

import importlib
import importlib.util
import sys
from unittest.mock import patch

import pytest

from ai.common.models.gpu_guard import _GPUImportBlocker, install_gpu_guard, _BLOCKED_MODULES


# ============================================================================
# _GPUImportBlocker TESTS
# ============================================================================


class TestGPUImportBlocker:
    """Tests for the _GPUImportBlocker import hook class."""

    def test_find_spec_blocks_torch(self):
        """find_spec should return a blocking spec for blocked top-level modules."""
        blocker = _GPUImportBlocker(_BLOCKED_MODULES)

        # Should return a ModuleSpec whose loader is the blocker itself
        for name in ('torch', 'tensorflow', 'onnxruntime', 'cupy'):
            spec = blocker.find_spec(name)
            assert spec is not None
            assert spec.name == name
            assert spec.loader is blocker

    def test_find_spec_blocks_submodules(self):
        """find_spec should block submodules of blocked packages."""
        blocker = _GPUImportBlocker(_BLOCKED_MODULES)

        # Submodules should also be caught (top-level extracted from dotted name)
        for name in ('torch.nn', 'torch.nn.functional', 'tensorflow.keras', 'onnxruntime.transformers'):
            spec = blocker.find_spec(name)
            assert spec is not None
            assert spec.name == name
            assert spec.loader is blocker

    def test_find_spec_allows_other(self):
        """find_spec should return None for non-blocked modules."""
        blocker = _GPUImportBlocker(_BLOCKED_MODULES)

        # Non-blocked modules should pass through to the next finder
        assert blocker.find_spec('os') is None
        assert blocker.find_spec('json') is None
        assert blocker.find_spec('numpy') is None
        assert blocker.find_spec('ai.common.models') is None

    def test_exec_module_raises_import_error(self):
        """exec_module should raise ImportError with descriptive message."""
        blocker = _GPUImportBlocker(_BLOCKED_MODULES)

        for name in ('torch', 'torch.nn'):
            module = importlib.util.module_from_spec(blocker.find_spec(name))
            with pytest.raises(ImportError, match=f'Direct import of "{name}" is blocked'):
                blocker.exec_module(module)

    def test_blocked_import_raises_end_to_end(self):
        """A real import of a blocked module through the machinery must raise.

        This drives find_spec -> create_module -> exec_module via the real
        import system, so it fails if the finder ever stops blocking (e.g. a
        regression back to the removed find_module/load_module protocol).
        """
        blocker = _GPUImportBlocker(_BLOCKED_MODULES)
        sys.meta_path.insert(0, blocker)
        try:
            # Ensure a fresh import so the guard (not a cached module) is hit.
            sys.modules.pop('cupy', None)
            with pytest.raises(ImportError, match='blocked in model server mode'):
                importlib.import_module('cupy')
        finally:
            sys.meta_path.remove(blocker)
            sys.modules.pop('cupy', None)


# ============================================================================
# install_gpu_guard TESTS
# ============================================================================


class TestInstallGPUGuard:
    """Tests for the install_gpu_guard() function."""

    def setup_method(self):
        """Reset the installed flag before each test."""
        # Reset the module-level _installed flag so each test starts fresh
        import ai.common.models.gpu_guard as guard_module

        guard_module._installed = False

        # Remove any existing blockers from sys.meta_path
        sys.meta_path[:] = [f for f in sys.meta_path if not isinstance(f, _GPUImportBlocker)]

    def teardown_method(self):
        """Clean up any installed blockers after each test."""
        # Remove any blockers we installed
        sys.meta_path[:] = [f for f in sys.meta_path if not isinstance(f, _GPUImportBlocker)]

        # Reset the installed flag
        import ai.common.models.gpu_guard as guard_module

        guard_module._installed = False

    def test_installs_when_model_server_set(self):
        """install_gpu_guard should install hook when --modelserver is set."""
        # Patch get_model_server_address to simulate --modelserver=5590
        with patch('ai.common.models.gpu_guard.get_model_server_address', return_value='localhost:5590'):
            install_gpu_guard()

        # Verify a blocker was installed in sys.meta_path
        blockers = [f for f in sys.meta_path if isinstance(f, _GPUImportBlocker)]
        assert len(blockers) == 1

    def test_no_install_without_model_server(self):
        """install_gpu_guard should not install hook when --modelserver is NOT set."""
        # Patch get_model_server_address to simulate no --modelserver
        with patch('ai.common.models.gpu_guard.get_model_server_address', return_value=None):
            install_gpu_guard()

        # Verify no blocker was installed
        blockers = [f for f in sys.meta_path if isinstance(f, _GPUImportBlocker)]
        assert len(blockers) == 0

    def test_idempotent(self):
        """Calling install_gpu_guard multiple times should only install once."""
        with patch('ai.common.models.gpu_guard.get_model_server_address', return_value='localhost:5590'):
            install_gpu_guard()
            install_gpu_guard()
            install_gpu_guard()

        # Should only be one blocker despite multiple calls
        blockers = [f for f in sys.meta_path if isinstance(f, _GPUImportBlocker)]
        assert len(blockers) == 1
