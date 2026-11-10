// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// APP CHECKS: the app's own type-check and build, run by the runner
// =============================================================================

/**
 * Task 3.2, from 51bd59d2c7's eval/appCheck.ts. check_app_passes does not take
 * the agent's word, or check_app's: the runner lays the app folder from the
 * final workspace out on disk and runs the app's own build, `tsc --noEmit`
 * then `rsbuild build`, the two steps check_app runs in the browser (types,
 * then a rebuild), on the same sources.
 *
 * The app's dependencies are this checkout's: react, the React types,
 * rsbuild and the Module Federation plugin from rocket-ui's node_modules (an
 * app built the same way), `rocketride` from packages/client-typescript, and
 * `shell` as a types-only package whose types are the shell's newest frozen
 * contract (packages/shell/contract/versions/vN.d.ts), which is the
 * `shell.d.ts` that shell.tgz ships.
 *
 * The other halves come from the browser trial, added to each app's result:
 * the app's load in its Design preview (withLoads), the agent's own
 * check_app rows (withSteps), and a use of the app with its pipeline's run
 * on the engine (checks/appRun.ts withRuns).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../catalog';
import type { AppLoad } from '../driver';
import { withoutKeys } from '../evidence';
import type { TurnCheck } from '../types';
import type { AppRun } from './appRun';

/** Where the app's dependencies are linked from. */
const DEP_ROOTS = [path.join(REPO_ROOT, 'apps/rocket-ui/node_modules'), path.join(REPO_ROOT, 'node_modules')];

/** The packages an app's build reads. */
const DEPS = ['react', 'react-dom', '@types/react', '@types/react-dom', '@types/node', '@rsbuild/core', '@rsbuild/plugin-react', '@module-federation/rsbuild-plugin', 'typescript', 'react-refresh'];

/** The longest one step may take. */
const STEP_LIMIT_MS = 240_000;

/** What one app check saw. */
export interface AppCheckResult {
	ok: boolean;
	detail: string;
	types: { ok: boolean; output: string };
	build: { ok: boolean | null; output: string };
	/** The app loaded in its Design preview after the turn (Driver.appLoad), when the runner had the preview open. A failed load fails the check. */
	load?: AppLoad;
	/** The agent's newest check_app rows on the app, from the saved turn (withSteps). A step that did not run, or no rows, fails the check. */
	steps?: TurnCheck[];
	/** The app used in its preview and its pipeline's run on the engine (withRuns), for a check with `use`. A failed run fails the check. */
	run?: AppRun;
}

/** The steps the product's check_app reports (apps/shared toolkits/appCheck.ts), and the row it leaves for an app it never checked. */
const AGENT_STEPS = new Set(['manifest', 'types', 'build', 'runtime', 'console', 'check_app']);

/**
 * Adds the agent's own check_app on each app: the saved turn's newest rows
 * for it, which name the app by its manifest id, or by its folder's name
 * when check_app had none. Every step must have run, so a check_app that
 * skipped types or build (the Design preview closed), or none at all, fails
 * the app's check. With no saved turn the steps are noted, not counted.
 *
 * @param checks - The app checks, by app folder; changed in place.
 * @param rows - The saved turn's check rows, or null with no saved turn.
 * @param files - The final workspace, for each app's manifest id.
 */
export function withSteps(checks: Record<string, AppCheckResult>, rows: TurnCheck[] | null, files: Record<string, string>): void {
	for (const [app, r] of Object.entries(checks)) {
		if (rows === null) {
			r.detail = `${r.detail}; check_app steps not read (no saved turn)`;
			continue;
		}
		const names = new Set([app.slice('apps/'.length), manifestId(files, app)].filter((n): n is string => !!n));
		const mine = rows.filter((c) => names.has(c.target) && AGENT_STEPS.has(c.step));
		r.steps = mine;
		const notRun = mine.filter((c) => c.status === 'not_run').map((c) => c.step);
		const why = !mine.length ? 'the agent ran no check_app on it' : notRun.length ? `the agent's check_app did not run ${notRun.join(', ')}` : '';
		if (why) r.detail = r.ok ? `steps: ${why}` : `${r.detail}; steps: ${why}`;
		else r.detail = `${r.detail}; check_app ran ${mine.map((c) => c.step).join(', ')}`;
		r.ok = r.ok && !why;
	}
}

/** An app's appManifest.id from its package.json, or null. */
function manifestId(files: Record<string, string>, app: string): string | null {
	try {
		const id = (JSON.parse(files[`${app}/package.json`] ?? '') as { appManifest?: { id?: unknown } }).appManifest?.id;
		return typeof id === 'string' && id ? id : null;
	} catch {
		return null;
	}
}

/**
 * Adds each app's Design preview load to its check: a load that failed fails
 * the check, one that could not be read is noted and does not count.
 *
 * @param checks - The app checks, by app folder; changed in place.
 * @param loads - The loads, by app folder.
 */
export function withLoads(checks: Record<string, AppCheckResult>, loads: Record<string, AppLoad>): void {
	for (const [app, r] of Object.entries(checks)) {
		const load = loads[app];
		if (!load) continue;
		r.load = load;
		if (load.ok === false) r.detail = r.ok ? `load: ${load.detail}` : `${r.detail}; load: ${load.detail}`;
		else if (load.ok === null) r.detail = `${r.detail}; load not checked (${load.detail})`;
		else r.detail = `${r.detail}; ${load.detail}`;
		r.ok = r.ok && load.ok !== false;
	}
}

/** The newest frozen shell contract. */
export function shellContract(): string {
	const dir = path.join(REPO_ROOT, 'packages/shell/contract/versions');
	const newest = fs
		.readdirSync(dir)
		.map((f) => /^v(\d+)\.d\.ts$/.exec(f))
		.filter((m): m is RegExpExecArray => m !== null)
		.sort((a, b) => Number(b[1]) - Number(a[1]))[0];
	if (!newest) throw new Error(`no frozen shell contract in ${dir}`);
	return path.join(dir, newest[0]);
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd, timeout: STEP_LIMIT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...withoutKeys(process.env), NODE_ENV: 'production', CI: 'true' } }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
			resolve({ code, output: `${stdout}${stderr}`.trim() });
		});
	});
}

/** The last lines of a step's output. */
function tail(text: string, lines = 12): string {
	return text.split('\n').slice(-lines).join('\n');
}

/** The app folders (apps/<name>) a workspace has. */
export function appFolders(files: Record<string, string>): string[] {
	return [
		...new Set(
			Object.keys(files)
				.map((p) => /^(apps\/[^/]+)\//.exec(p)?.[1])
				.filter((a): a is string => !!a)
		),
	].sort();
}

/**
 * The app folders a turn changed that still exist: any file under them was
 * added, changed or deleted. A deleted source file counts, since the app that
 * imported it may no longer build; an app folder deleted whole is gone, so
 * there is nothing left to check.
 *
 * @param start - The workspace the task started with.
 * @param final - The workspace at the end.
 */
export function changedApps(start: Record<string, string>, final: Record<string, string>): string[] {
	const changed = [...new Set([...Object.keys(start), ...Object.keys(final)])].filter((p) => start[p] !== final[p]);
	const existing = new Set(appFolders(final));
	return appFolders(Object.fromEntries(changed.map((p) => [p, '']))).filter((a) => existing.has(a));
}

/**
 * Lays an app folder out on disk with its dependencies linked.
 *
 * @param files - The workspace files.
 * @param app - The folder, `apps/<name>`.
 * @param dir - An empty folder to lay it out in.
 */
export function materializeApp(files: Record<string, string>, app: string, dir: string): void {
	const prefix = `${app}/`;
	for (const [p, text] of Object.entries(files)) {
		if (!p.startsWith(prefix)) continue;
		const out = path.join(dir, p.slice(prefix.length));
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, text);
	}
	const modules = path.join(dir, 'node_modules');
	for (const dep of DEPS) {
		const from = DEP_ROOTS.map((root) => path.join(root, dep)).find((p) => fs.existsSync(p));
		if (!from) continue;
		fs.mkdirSync(path.dirname(path.join(modules, dep)), { recursive: true });
		fs.symlinkSync(fs.realpathSync(from), path.join(modules, dep), 'dir');
	}
	fs.symlinkSync(path.join(REPO_ROOT, 'packages/client-typescript'), path.join(modules, 'rocketride'), 'dir');
	const shell = path.join(modules, 'shell');
	fs.mkdirSync(shell, { recursive: true });
	fs.writeFileSync(path.join(shell, 'package.json'), JSON.stringify({ name: 'shell', version: '0.0.0-eval', types: 'shell.d.ts' }));
	fs.copyFileSync(shellContract(), path.join(shell, 'shell.d.ts'));
}

/**
 * Type-checks and builds one app from the final workspace.
 *
 * @param files - The workspace files after the run.
 * @param app - The folder, `apps/<name>`.
 * @param workDir - Where to lay the app out; it is removed afterwards.
 * @returns What each step saw; a missing app fails.
 */
export async function checkApp(files: Record<string, string>, app: string, workDir: string): Promise<AppCheckResult> {
	if (!Object.keys(files).some((p) => p.startsWith(`${app}/`))) return { ok: false, detail: `${app} is not in the workspace`, types: { ok: false, output: '' }, build: { ok: null, output: '' } };
	if (!(`${app}/package.json` in files) || !(`${app}/tsconfig.json` in files)) return { ok: false, detail: `${app} has no package.json or tsconfig.json`, types: { ok: false, output: '' }, build: { ok: null, output: '' } };
	const dir = path.join(workDir, app.replace(/\//g, '_'));
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const local = (text: string) => text.split(dir).join(app);
	try {
		materializeApp(files, app, dir);
		const tsc = path.join(dir, 'node_modules/typescript/bin/tsc');
		const types = await run(process.execPath, [tsc, '--noEmit', '-p', path.join(dir, 'tsconfig.json')], dir);
		if (types.code !== 0) return { ok: false, detail: `types: ${local(tail(types.output, 4))}`, types: { ok: false, output: local(tail(types.output)) }, build: { ok: null, output: 'not run: the types failed' } };
		const rsbuild = path.join(dir, 'node_modules/@rsbuild/core/bin/rsbuild.js');
		const build = await run(process.execPath, [rsbuild, 'build'], dir);
		const ok = build.code === 0;
		return { ok, detail: ok ? 'types and build pass' : `build: ${local(tail(build.output, 4))}`, types: { ok: true, output: local(tail(types.output)) }, build: { ok, output: local(tail(build.output)) } };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The app checks a grade needs: every app folder the turn changed, and every
 * app a check_app_passes check names.
 *
 * @param appsToCheck - The app folders.
 * @param files - The final workspace.
 * @param workDir - Where to lay the apps out.
 */
export async function checkApps(appsToCheck: string[], files: Record<string, string>, workDir: string): Promise<Record<string, AppCheckResult>> {
	const out: Record<string, AppCheckResult> = {};
	for (const app of appsToCheck) out[app] = await checkApp(files, app, workDir);
	if (fs.existsSync(workDir) && fs.readdirSync(workDir).length === 0) fs.rmdirSync(workDir);
	return out;
}
