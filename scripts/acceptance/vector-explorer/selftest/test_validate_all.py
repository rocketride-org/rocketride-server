# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Self-tests for validate_all.sh's step runner (validate_lib.sh), in a throwaway git repository.

The builder rewrites the TypeScript client's constants file during builds; the
runner puts it back after each step. It must put back what the file held
before the step, a developer's own uncommitted edit included, never the
committed version.

Run: python3 -m unittest discover -s scripts/acceptance/vector-explorer/selftest -v
"""

import os
import shutil
import subprocess
import tempfile
import unittest

from pathlib import Path

LIB = Path(__file__).resolve().parent.parent / 'validate_lib.sh'
CONSTANTS = 'packages/client-typescript/src/client/constants.ts'


@unittest.skipUnless(shutil.which('bash') and shutil.which('git'), 'NOT RUN: needs bash and git')
class StepRunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.file = self.repo / CONSTANTS
        self.file.parent.mkdir(parents=True)
        self.file.write_text('committed\n', encoding='utf-8')
        # A throwaway repository: its one commit needs an identity on machines without one.
        env = dict(os.environ, GIT_AUTHOR_NAME='selftest', GIT_COMMITTER_NAME='selftest')
        env.update(GIT_AUTHOR_EMAIL='selftest@example.invalid', GIT_COMMITTER_EMAIL='selftest@example.invalid')
        subprocess.run(['git', 'init', '-q'], cwd=self.repo, check=True)
        subprocess.run(['git', 'add', '.'], cwd=self.repo, check=True)
        commit = ['git', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base', '--no-verify']
        subprocess.run(commit, cwd=self.repo, check=True, env=env)
        (self.repo / 'logs').mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def step(self, command: str) -> str:
        """Run one step through the runner; return SUMMARY."""
        script = (
            f'set -u; LOGS=logs; SUMMARY=logs/SUMMARY.txt; CONSTANTS={CONSTANTS}; STEPS=0; FAILED=0; : > "$SUMMARY"; '
            f'. "{LIB}"; step rewrite sh -c {command!r}; echo "steps=$STEPS failed=$FAILED" >> "$SUMMARY"'
        )
        subprocess.run(['bash', '-c', script], cwd=self.repo, check=True, capture_output=True)
        return (self.repo / 'logs' / 'SUMMARY.txt').read_text(encoding='utf-8')

    def test_a_developers_own_edit_survives_a_step_that_rewrites_the_file(self):
        self.file.write_text('a developer edit\n', encoding='utf-8')
        summary = self.step(f'echo rewritten-by-the-builder > {CONSTANTS}')
        self.assertEqual(self.file.read_text(encoding='utf-8'), 'a developer edit\n')
        self.assertIn('restored', summary)

    def test_a_clean_file_rewritten_by_a_step_is_put_back(self):
        summary = self.step(f'echo rewritten-by-the-builder > {CONSTANTS}')
        self.assertEqual(self.file.read_text(encoding='utf-8'), 'committed\n')
        self.assertIn('restored', summary)

    def test_a_step_that_leaves_the_file_alone_restores_nothing(self):
        self.file.write_text('a developer edit\n', encoding='utf-8')
        summary = self.step('exit 3')
        self.assertEqual(self.file.read_text(encoding='utf-8'), 'a developer edit\n')
        self.assertNotIn('restored', summary)
        self.assertIn('exit=3', summary)
        self.assertIn('steps=1 failed=1', summary)


if __name__ == '__main__':
    unittest.main()
