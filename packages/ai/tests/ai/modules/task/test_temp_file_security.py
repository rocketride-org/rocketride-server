"""
Tests for secure temporary file handling in task engine.

Validates that _write_task_file creates files with:
- Restrictive permissions (0o600, owner-only read/write)
- Unpredictable filenames (not based solely on task ID)
- Exclusive creation (O_EXCL via mkstemp, preventing symlink attacks)
"""

import asyncio
import json
import os
import stat
import unittest
from unittest.mock import MagicMock, PropertyMock, patch


class TestWriteTaskFileSecurity(unittest.TestCase):
    """Security-focused tests for _write_task_file."""

    def _make_task_engine(self):
        """
        Create a minimal mock of Task that has enough structure
        to call _write_task_file directly.
        """
        # Import the actual method so we test real code, not a mock
        from ai.modules.task.task_engine import Task

        mock = MagicMock(spec=Task)
        mock.id = 'test-task-1234'
        mock._build_task = MagicMock(return_value={
            'config': {'pipeline': {'name': 'test'}},
            'taskId': 'tok-abc',
            'type': 'pipeline',
        })
        # Bind the real method to our mock
        mock._write_task_file = Task._write_task_file.__get__(mock, Task)
        return mock

    @unittest.skipIf(os.name == 'nt', 'POSIX file permissions not available on Windows')
    def test_file_permissions_owner_only(self):
        """Temporary file must be created with 0o600 (owner read/write only)."""
        engine = self._make_task_engine()
        taskpath = asyncio.run(engine._write_task_file())
        try:
            file_stat = os.stat(taskpath)
            mode = stat.S_IMODE(file_stat.st_mode)
            self.assertEqual(
                mode, 0o600,
                f'Expected file permissions 0o600, got {oct(mode)}. '
                f'Temp files with pipeline config (may contain API keys) '
                f'must not be world-readable.'
            )
        finally:
            os.unlink(taskpath)

    def test_filename_not_predictable(self):
        """Filename must not be simply <task-id>.json (predictable path)."""
        engine = self._make_task_engine()
        taskpath = asyncio.run(engine._write_task_file())
        try:
            basename = os.path.basename(taskpath)
            predictable_name = f'{engine.id}.json'
            self.assertNotEqual(
                basename, predictable_name,
                f'Filename must not be the predictable "{predictable_name}". '
                f'Predictable temp paths enable symlink attacks.'
            )
        finally:
            os.unlink(taskpath)

    def test_file_has_json_suffix(self):
        """Temporary file should retain .json suffix for downstream consumers."""
        engine = self._make_task_engine()
        taskpath = asyncio.run(engine._write_task_file())
        try:
            self.assertTrue(
                taskpath.endswith('.json'),
                f'Expected .json suffix, got: {taskpath}'
            )
        finally:
            os.unlink(taskpath)

    def test_file_contains_valid_json(self):
        """Written file must contain valid JSON matching _build_task output."""
        engine = self._make_task_engine()
        taskpath = asyncio.run(engine._write_task_file())
        try:
            with open(taskpath, 'r', encoding='utf-8') as f:
                content = f.read()
            data = json.loads(content)
            self.assertEqual(data['type'], 'pipeline')
            self.assertEqual(data['config']['pipeline']['name'], 'test')
        finally:
            os.unlink(taskpath)

    def test_symlink_attack_prevented(self):
        """
        If an attacker places a symlink at a predictable path, mkstemp
        must not follow it. Since mkstemp uses a random name, the attacker
        cannot predict the path. This test verifies the file is a regular
        file and not a symlink.
        """
        engine = self._make_task_engine()
        taskpath = asyncio.run(engine._write_task_file())
        try:
            self.assertFalse(
                os.path.islink(taskpath),
                'Temporary file must not be a symlink.'
            )
            self.assertTrue(
                os.path.isfile(taskpath),
                'Temporary file must be a regular file.'
            )
        finally:
            os.unlink(taskpath)

    @unittest.skipIf(os.name == 'nt', 'os.getuid() not available on Windows')
    def test_file_owned_by_current_user(self):
        """Temporary file must be owned by the current process user."""
        engine = self._make_task_engine()
        taskpath = asyncio.run(engine._write_task_file())
        try:
            file_stat = os.stat(taskpath)
            self.assertEqual(
                file_stat.st_uid, os.getuid(),
                'Temporary file must be owned by the current user.'
            )
        finally:
            os.unlink(taskpath)

    def test_cleanup_removes_file(self):
        """Verify that os.remove on the returned path works (no path issues)."""
        engine = self._make_task_engine()
        taskpath = asyncio.run(engine._write_task_file())
        self.assertTrue(os.path.exists(taskpath))
        os.remove(taskpath)
        self.assertFalse(os.path.exists(taskpath))


if __name__ == '__main__':
    unittest.main()
