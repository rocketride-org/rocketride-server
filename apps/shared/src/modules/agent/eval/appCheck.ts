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
// APP CHECK — check_app_passes: the app's own type-check and build, run by the runner
// =============================================================================

/**
 * check_app_passes does not take the agent's word, or check_app's: the runner
 * copies the app folder out of the final workspace and runs the app's own
 * build script, `tsc --noEmit && rsbuild build`, there. That is the same two
 * steps check_app runs in the browser (types, then a rebuild), on the same
 * sources.
 *
 * The app's dependencies are this checkout's: react, the React types,
 * rsbuild and the Module Federation plugin from rocket-ui's node_modules (an
 * app built the same way), `rocketride` from packages/client-typescript, and
 * `shell` as a types-only package whose types are the shell's newest frozen
 * contract (packages/shell/contract/versions/vN.d.ts), which is the
 * `shell.d.ts` that shell.tgz ships.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REPO_ROOT } from './catalog';

/** Node's process. The package's global.d.ts declares a browser `process` that has only `env`. */
const proc = process as unknown as NodeJS.Process;

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
		execFile(cmd, args, { cwd, timeout: STEP_LIMIT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...proc.env, NODE_ENV: 'production', CI: 'true' } }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : 1) : 0;
			resolve({ code, output: `${stdout}${stderr}`.trim() });
		});
	});
}

/** The last lines of a step's output, for the report. */
function tail(text: string, lines = 12): string {
	return text.split('\n').slice(-lines).join('\n');
}

/**
 * Lays an app folder out on disk with its dependencies linked.
 *
 * @param files - The workspace files.
 * @param app - The folder, `apps/<folder>`.
 * @returns The folder on disk.
 */
export function materializeApp(files: Record<string, string>, app: string): string {
	const prefix = `${app}/`;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-eval-app-'));
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
	return dir;
}

/**
 * Type-checks and builds one app from the final workspace.
 *
 * @param files - The workspace files after the run.
 * @param app - The folder, `apps/<folder>`.
 * @returns What each step saw; a missing app fails.
 */
export async function checkApp(files: Record<string, string>, app: string): Promise<AppCheckResult> {
	if (!Object.keys(files).some((p) => p.startsWith(`${app}/`))) return { ok: false, detail: `${app} is not in the workspace`, types: { ok: false, output: '' }, build: { ok: null, output: '' } };
	if (!(`${app}/package.json` in files) || !(`${app}/tsconfig.json` in files)) return { ok: false, detail: `${app} has no package.json or tsconfig.json`, types: { ok: false, output: '' }, build: { ok: null, output: '' } };
	const dir = materializeApp(files, app);
	try {
		const tsc = path.join(dir, 'node_modules/typescript/bin/tsc');
		const types = await run(proc.execPath, [tsc, '--noEmit', '-p', path.join(dir, 'tsconfig.json')], dir);
		if (types.code !== 0) return { ok: false, detail: `types: ${tail(types.output, 4).replace(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), app)}`, types: { ok: false, output: tail(types.output) }, build: { ok: null, output: 'not run: the types failed' } };
		const rsbuild = path.join(dir, 'node_modules/@rsbuild/core/bin/rsbuild.js');
		const build = await run(proc.execPath, [rsbuild, 'build'], dir);
		const ok = build.code === 0;
		return { ok, detail: ok ? 'types and build pass' : `build: ${tail(build.output, 4)}`, types: { ok: true, output: tail(types.output) }, build: { ok, output: tail(build.output) } };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
