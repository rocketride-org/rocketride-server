import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitTurn, initGit } from '../src/workspace';

/**
 * Regression: workspace git commands must never escape the workspace. A workspace directory
 * without its own .git (e.g. before initGit, or after a failed seed) sits inside whatever
 * directory holds the temp root — on a developer machine that can be a real checkout. Without a
 * discovery ceiling, `commitTurn` ran `git add -A` + `git commit` against that enclosing repo.
 */
describe('workspace git discovery ceiling', () => {
	let outer: string;
	beforeEach(() => {
		outer = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-ceiling-'));
		execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: outer });
		execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '--allow-empty', '-m', 'outer baseline'], { cwd: outer });
	});
	afterEach(() => fs.rmSync(outer, { recursive: true, force: true }));

	test('commitTurn in a workspace without .git rejects and leaves the enclosing repo untouched', async () => {
		const ws = path.join(outer, 'sessions', 's1', 'workspace');
		fs.mkdirSync(ws, { recursive: true });
		fs.writeFileSync(path.join(ws, 'a.pipe'), '{}');
		await expect(commitTurn(ws, 'must not land outside')).rejects.toThrow();
		const outerLog = execFileSync('git', ['log', '--format=%s'], { cwd: outer, encoding: 'utf8' }).trim();
		expect(outerLog).toBe('outer baseline');
		// Nothing staged into the enclosing repo either (the untracked sessions/ dir itself is fine).
		expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: outer, encoding: 'utf8' })).toBe('');
	});

	test('initGit + commitTurn still work for a workspace nested inside another repo', async () => {
		const ws = path.join(outer, 'sessions', 's2', 'workspace');
		fs.mkdirSync(ws, { recursive: true });
		await initGit(ws);
		fs.writeFileSync(path.join(ws, 'a.pipe'), '{}');
		const sha = await commitTurn(ws, 'turn');
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
		const outerLog = execFileSync('git', ['log', '--format=%s'], { cwd: outer, encoding: 'utf8' }).trim();
		expect(outerLog).toBe('outer baseline');
	});
});
