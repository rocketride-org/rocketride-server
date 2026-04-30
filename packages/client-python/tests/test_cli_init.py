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

"""Tests for the rocketride init CLI command."""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from rocketride.cli.commands.init import (
    InitCommand,
    _detect_agents,
    _merge_marked_content,
    _MARKER_BEGIN,
    _MARKER_END,
)


_DOC_FILE_NAMES = (
    'ROCKETRIDE_README.md',
    'ROCKETRIDE_QUICKSTART.md',
    'ROCKETRIDE_PIPELINE_RULES.md',
    'ROCKETRIDE_COMPONENT_REFERENCE.md',
    'ROCKETRIDE_COMMON_MISTAKES.md',
    'ROCKETRIDE_python_API.md',
    'ROCKETRIDE_typescript_API.md',
)


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)


def _make_args(path, **overrides):
    defaults = dict(
        path=str(path),
        agent=None,
        no_agents=False,
        force=False,
        no_overwrite=False,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _isolate_env() -> dict:
    """Build an env dict with no agent-detection signals.

    Strips CURSOR_TRACE_ID, CLAUDECODE, etc. so detection is purely
    project-marker-driven during tests.
    """
    return {k: v for k, v in os.environ.items() if k not in {'CURSOR_TRACE_ID', 'CLAUDECODE', 'CLAUDE_CODE', 'TERM_PROGRAM', 'HOME', 'USERPROFILE'}}


class InitCommandTests(unittest.TestCase):
    """End-to-end tests for InitCommand against a temp workspace."""

    def setUp(self) -> None:
        """Create a temp workspace and isolate the environment from the host."""
        self._tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmp.name)
        # Force HOME/USERPROFILE to a tmp location so home-dir detection
        # never picks up the developer's actual ~/.claude or ~/.cursor.
        self._fake_home = tempfile.TemporaryDirectory()
        self._env_patcher = patch.dict(
            os.environ,
            {**_isolate_env(), 'HOME': self._fake_home.name, 'USERPROFILE': self._fake_home.name},
            clear=True,
        )
        self._env_patcher.start()

    def tearDown(self) -> None:
        """Restore the environment and remove temp directories."""
        self._env_patcher.stop()
        self._fake_home.cleanup()
        self._tmp.cleanup()

    # ------------------------------------------------------------------
    # Docs + gitignore
    # ------------------------------------------------------------------

    def test_creates_docs_directory_with_all_seven_files(self) -> None:
        """All seven canonical doc files land under .rocketride/docs/."""
        cmd = InitCommand(cli=None, args=_make_args(self.workspace, no_agents=True))
        rc = _run(cmd.execute(None))
        self.assertEqual(rc, 0)

        docs_dir = self.workspace / '.rocketride' / 'docs'
        self.assertTrue(docs_dir.is_dir())
        for name in _DOC_FILE_NAMES:
            with self.subTest(doc=name):
                self.assertTrue((docs_dir / name).is_file(), f'missing: {name}')

    def test_appends_gitignore_entry(self) -> None:
        """Init appends `.rocketride/` to a missing or partial .gitignore."""
        cmd = InitCommand(cli=None, args=_make_args(self.workspace, no_agents=True))
        _run(cmd.execute(None))

        gitignore = (self.workspace / '.gitignore').read_text(encoding='utf-8')
        self.assertIn('.rocketride/', gitignore.splitlines())

    def test_gitignore_entry_is_not_duplicated(self) -> None:
        """Init does not add a second `.rocketride/` line if one already exists."""
        gitignore_path = self.workspace / '.gitignore'
        gitignore_path.write_text('node_modules/\n.rocketride/\n', encoding='utf-8')

        cmd = InitCommand(cli=None, args=_make_args(self.workspace, no_agents=True))
        _run(cmd.execute(None))

        lines = gitignore_path.read_text(encoding='utf-8').splitlines()
        self.assertEqual(lines.count('.rocketride/'), 1)

    # ------------------------------------------------------------------
    # Agent selection
    # ------------------------------------------------------------------

    def test_no_agents_flag_skips_stub_writes(self) -> None:
        """`--no-agents` writes docs but no agent stub files."""
        cmd = InitCommand(cli=None, args=_make_args(self.workspace, no_agents=True))
        _run(cmd.execute(None))

        # No stubs written anywhere.
        self.assertFalse((self.workspace / 'CLAUDE.md').exists())
        self.assertFalse((self.workspace / 'AGENTS.md').exists())
        self.assertFalse((self.workspace / '.cursor').exists())

    def test_no_detection_falls_back_to_universal_agent_files(self) -> None:
        """When no IDE/agent is detected, install CLAUDE.md and AGENTS.md fallbacks."""
        cmd = InitCommand(cli=None, args=_make_args(self.workspace))
        _run(cmd.execute(None))

        self.assertTrue((self.workspace / 'CLAUDE.md').is_file())
        self.assertTrue((self.workspace / 'AGENTS.md').is_file())

    def test_explicit_agent_flag_installs_only_that_stub(self) -> None:
        """`--agent cursor` installs only Cursor; fallback files are skipped."""
        cmd = InitCommand(cli=None, args=_make_args(self.workspace, agent=['cursor']))
        _run(cmd.execute(None))

        self.assertTrue((self.workspace / '.cursor' / 'rules' / 'rocketride.mdc').is_file())
        # Should NOT install the fallback files when --agent is explicit.
        self.assertFalse((self.workspace / 'CLAUDE.md').exists())
        self.assertFalse((self.workspace / 'AGENTS.md').exists())

    def test_agent_all_installs_every_stub(self) -> None:
        """`--agent all` installs stubs for every supported agent."""
        cmd = InitCommand(cli=None, args=_make_args(self.workspace, agent=['all']))
        _run(cmd.execute(None))

        self.assertTrue((self.workspace / '.cursor' / 'rules' / 'rocketride.mdc').is_file())
        self.assertTrue((self.workspace / '.claude' / 'rules' / 'rocketride.md').is_file())
        self.assertTrue((self.workspace / '.windsurf' / 'rules' / 'rocketride.md').is_file())
        self.assertTrue((self.workspace / '.github' / 'copilot-instructions.md').is_file())
        self.assertTrue((self.workspace / 'CLAUDE.md').is_file())
        self.assertTrue((self.workspace / 'AGENTS.md').is_file())

    # ------------------------------------------------------------------
    # Idempotency
    # ------------------------------------------------------------------

    def test_second_run_is_a_noop_when_nothing_changed(self) -> None:
        """Re-running init produces byte-identical files (idempotent)."""
        cmd = InitCommand(cli=None, args=_make_args(self.workspace, agent=['all']))
        _run(cmd.execute(None))

        snapshot = {p: p.read_bytes() for p in self.workspace.rglob('*') if p.is_file()}

        cmd2 = InitCommand(cli=None, args=_make_args(self.workspace, agent=['all']))
        rc = _run(cmd2.execute(None))
        self.assertEqual(rc, 0)

        for path, content in snapshot.items():
            with self.subTest(path=str(path)):
                self.assertEqual(path.read_bytes(), content, f'changed: {path}')

    def test_force_overwrites_modified_doc_files(self) -> None:
        """`--force` replaces locally edited doc files with the canonical version."""
        cmd = InitCommand(cli=None, args=_make_args(self.workspace, no_agents=True))
        _run(cmd.execute(None))

        readme = self.workspace / '.rocketride' / 'docs' / 'ROCKETRIDE_README.md'
        readme.write_text('LOCAL EDIT\n', encoding='utf-8')

        cmd2 = InitCommand(cli=None, args=_make_args(self.workspace, no_agents=True, force=True))
        rc = _run(cmd2.execute(None))
        self.assertEqual(rc, 0)
        self.assertNotEqual(readme.read_text(encoding='utf-8'), 'LOCAL EDIT\n')

    def test_no_overwrite_preserves_modified_doc_files(self) -> None:
        """`--no-overwrite` leaves locally edited doc files untouched."""
        cmd = InitCommand(cli=None, args=_make_args(self.workspace, no_agents=True))
        _run(cmd.execute(None))

        readme = self.workspace / '.rocketride' / 'docs' / 'ROCKETRIDE_README.md'
        readme.write_text('LOCAL EDIT\n', encoding='utf-8')

        cmd2 = InitCommand(cli=None, args=_make_args(self.workspace, no_agents=True, no_overwrite=True))
        rc = _run(cmd2.execute(None))
        self.assertEqual(rc, 0)
        self.assertEqual(readme.read_text(encoding='utf-8'), 'LOCAL EDIT\n')

    def test_force_and_no_overwrite_together_are_rejected(self) -> None:
        """Passing both `--force` and `--no-overwrite` exits with a non-zero status."""
        cmd = InitCommand(cli=None, args=_make_args(self.workspace, no_agents=True, force=True, no_overwrite=True))
        rc = _run(cmd.execute(None))
        self.assertEqual(rc, 1)

    # ------------------------------------------------------------------
    # Stub merge protocol
    # ------------------------------------------------------------------

    def test_existing_claude_md_user_content_is_preserved_around_markers(self) -> None:
        """Pre-existing CLAUDE.md content survives the merge unchanged."""
        existing = 'My existing instructions.\nKeep this.\n'
        (self.workspace / 'CLAUDE.md').write_text(existing, encoding='utf-8')

        cmd = InitCommand(cli=None, args=_make_args(self.workspace, agent=['claude-md']))
        _run(cmd.execute(None))

        result = (self.workspace / 'CLAUDE.md').read_text(encoding='utf-8')
        self.assertIn('My existing instructions.', result)
        self.assertIn('Keep this.', result)
        self.assertIn(_MARKER_BEGIN, result)
        self.assertIn(_MARKER_END, result)

    def test_rerun_only_replaces_marked_section(self) -> None:
        """Re-running init only rewrites the marker block; user edits outside it remain."""
        path = self.workspace / 'CLAUDE.md'
        path.write_text('User content above.\n', encoding='utf-8')

        cmd = InitCommand(cli=None, args=_make_args(self.workspace, agent=['claude-md']))
        _run(cmd.execute(None))

        # Hand-edit user content after the markers to simulate ongoing local edits.
        body = path.read_text(encoding='utf-8')
        path.write_text(body + '\n\nMore user content below.\n', encoding='utf-8')

        cmd2 = InitCommand(cli=None, args=_make_args(self.workspace, agent=['claude-md']))
        _run(cmd2.execute(None))

        result = path.read_text(encoding='utf-8')
        self.assertIn('User content above.', result)
        self.assertIn('More user content below.', result)


class DetectAgentsTests(unittest.TestCase):
    """Unit tests for the `_detect_agents` heuristic."""

    def setUp(self) -> None:
        """Create an empty project root and isolate HOME/USERPROFILE."""
        self._tmp = tempfile.TemporaryDirectory()
        self._fake_home = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._env_patcher = patch.dict(
            os.environ,
            {'HOME': self._fake_home.name, 'USERPROFILE': self._fake_home.name},
            clear=True,
        )
        self._env_patcher.start()

    def tearDown(self) -> None:
        """Restore the environment and remove temp directories."""
        self._env_patcher.stop()
        self._fake_home.cleanup()
        self._tmp.cleanup()

    def test_empty_project_detects_nothing(self) -> None:
        """A bare directory with no markers yields no detected agents."""
        self.assertEqual(_detect_agents(self.root), ())

    def test_cursor_dir_detects_cursor(self) -> None:
        """A `.cursor/` directory in the project is detected as Cursor."""
        (self.root / '.cursor').mkdir()
        self.assertIn('cursor', _detect_agents(self.root))

    def test_existing_claude_md_detects_claude_md(self) -> None:
        """An existing CLAUDE.md file is detected as the claude-md agent."""
        (self.root / 'CLAUDE.md').write_text('x', encoding='utf-8')
        self.assertIn('claude-md', _detect_agents(self.root))

    def test_claudecode_env_var_detects_claude_code(self) -> None:
        """The CLAUDECODE env var causes Claude Code to be detected."""
        with patch.dict(os.environ, {'CLAUDECODE': '1'}, clear=False):
            self.assertIn('claude-code', _detect_agents(self.root))


class MergeMarkedContentTests(unittest.TestCase):
    """Unit tests for the `_merge_marked_content` marker-block merge helper."""

    def test_empty_existing_returns_stub_verbatim(self) -> None:
        """Merging into empty content returns the stub unchanged."""
        stub = f'{_MARKER_BEGIN}\nX\n{_MARKER_END}\n'
        self.assertEqual(_merge_marked_content('', stub), stub)

    def test_replaces_marked_block_in_existing(self) -> None:
        """Existing marker block is replaced; surrounding user content is kept."""
        existing = f'before\n{_MARKER_BEGIN}\nOLD\n{_MARKER_END}\nafter\n'
        stub = f'{_MARKER_BEGIN}\nNEW\n{_MARKER_END}\n'
        merged = _merge_marked_content(existing, stub)
        self.assertIn('before', merged)
        self.assertIn('after', merged)
        self.assertIn('NEW', merged)
        self.assertNotIn('OLD', merged)

    def test_appends_when_no_markers_present(self) -> None:
        """If existing content has no markers, the stub is appended."""
        existing = 'plain user content\n'
        stub = f'{_MARKER_BEGIN}\nX\n{_MARKER_END}\n'
        merged = _merge_marked_content(existing, stub)
        self.assertTrue(merged.startswith('plain user content'))
        self.assertIn('X', merged)


if __name__ == '__main__':
    unittest.main()
