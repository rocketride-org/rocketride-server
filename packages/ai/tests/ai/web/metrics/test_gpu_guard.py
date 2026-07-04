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
- The finder uses the find_spec protocol (Python 3.12+ compatible) rather
  than the legacy find_module/load_module pair removed in 3.12.
"""

import sys

import pytest

from ai.common.models.gpu_guard import _GPUImportBlocker, install_gpu_guard, _BLOCKED_MODULES


# ============================================================================
# _GPUImportBlocker TESTS
# ============================================================================


class TestGPUImportBlocker:
    """Tests for the _GPUImportBlocker import hook class."""

    def test_does_not_implement_legacy_protocol(self):
        """
        Regression test for the reported bug: find_module/load_module were
        removed from the import machinery in Python 3.12, so a finder that
        only implements them silently stops blocking anything. Guard
        against reintroducing that dead protocol instead of find_spec.
        """
        blocker = _GPUImportBlocker(_BLOCKED_MODULES)

        assert not hasattr(blocker, 'find_module')
        assert not hasattr(blocker, 'load_module')
        assert hasattr(blocker, 'find_spec')

    def test_find_spec_blocks_torch(self):
        """find_spec should raise ImportError for blocked top-level modules."""
        blocker = _GPUImportBlocker(_BLOCKED_MODULES)

        for name in ('torch', 'tensorflow', 'onnxruntime', 'cupy'):
            with pytest.raises(ImportError, match=f'Direct import of "{name}" is blocked'):
                blocker.find_spec(name)

    def test_find_spec_blocks_submodules(self):
        """find_spec should block submodules of blocked packages too."""
        blocker = _GPUImportBlocker(_BLOCKED_MODULES)

        with pytest.raises(ImportError, match='Direct import of "torch.nn" is blocked'):
            blocker.find_spec('torch.nn')
        with pytest.raises(ImportError, match='Direct import of "torch.nn.functional" is blocked'):
            blocker.find_spec('torch.nn.functional')
        with pytest.raises(ImportError, match='Direct import of "tensorflow.keras" is blocked'):
            blocker.find_spec('tensorflow.keras')
        with pytest.raises(ImportError, match='Direct import of "onnxruntime.transformers" is blocked'):
            blocker.find_spec('onnxruntime.transformers')

    def test_find_spec_allows_other(self):
        """find_spec should return None (defer to other finders) for non-blocked modules."""
        blocker = _GPUImportBlocker(_BLOCKED_MODULES)

        assert blocker.find_spec('os') is None
        assert blocker.find_spec('json') is None
        assert blocker.find_spec('numpy') is None
        assert blocker.find_spec('ai.web.metrics') is None

    def test_real_import_statement_is_blocked(self):
        """
        End-to-end regression test using the actual import machinery
        (not a direct find_spec() call) — this is what actually failed
        silently on Python 3.12+ before the fix, since the bug was that
        the real import system stopped calling into the finder at all.
        """
        blocker = _GPUImportBlocker(frozenset({'this_is_a_fake_blocked_pkg'}))
        sys.meta_path.insert(0, blocker)
        try:
            with pytest.raises(ImportError, match='Direct import of "this_is_a_fake_blocked_pkg" is blocked'):
                __import__('this_is_a_fake_blocked_pkg')

            with pytest.raises(
                ImportError, match='Direct import of "this_is_a_fake_blocked_pkg.sub" is blocked'
            ):
                __import__('this_is_a_fake_blocked_pkg.sub')

            # A genuinely missing, non-blocked module must still raise the
            # normal error, proving the finder doesn't swallow unrelated imports.
            with pytest.raises(ModuleNotFoundError):
                __import__('this_module_genuinely_does_not_exist_xyz')
        finally:
            sys.meta_path.remove(blocker)


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
