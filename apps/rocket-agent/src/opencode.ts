/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { AgentConfig } from './config';
import { log } from './log';
import type { ProviderKeys } from './types';

export interface SpawnOpts {
	sessionId: string;
	workspaceDir: string;
	sessionHome: string;
	mcpProxyUrl: string;
	providerKeys: ProviderKeys;
}

export interface OpencodeHandle {
	proc: ChildProcess;
	port: number;
	password: string;
	baseUrl: string;
}

// Deny-first, allow-last. Every clause here is load-bearing and was verified against the real
// opencode binary + a live write:
//  - opencode resolves edit rules by findLast (LAST match wins), and its visibleTools() STRIPS the
//    edit/write/apply_patch tools entirely when the final edit rule is a bare `{"*":"deny"}`. So
//    the deny must be FIRST and use `**` (not `*`), and an allow must be LAST.
//  - `**` (not `*`) for the deny, so slash-containing paths get a clean deny instead of an
//    interactive "ask" that would hang in this headless proxy.
//  - BOTH `*.pipe` and `**/*.pipe` allows: opencode's matcher (unlike stock minimatch) treats
//    `**/*.pipe` as requiring a directory, so it does NOT match a root-level `test.pipe` — without
//    the `*.pipe` clause, pipes created at the workspace root are silently denied (the observed bug).
//    `*.pipe` covers root files, `**/*.pipe` covers nested ones; everything else falls to `**` deny.
const REQUIRED_EDIT_WALL: Record<string, string> = { '**': 'deny', '*.pipe': 'allow', '**/*.pipe': 'allow' };

function isLockedEditWall(edit: unknown): boolean {
	if (!edit || typeof edit !== 'object') return false;
	const keys = Object.keys(edit as Record<string, unknown>);
	const expectedKeys = Object.keys(REQUIRED_EDIT_WALL);
	// Order-sensitive: compare keys positionally, since last-match-wins makes ordering load-bearing.
	return (
		keys.length === expectedKeys.length &&
		expectedKeys.every((k, i) => keys[i] === k && (edit as Record<string, unknown>)[k] === REQUIRED_EDIT_WALL[k])
	);
}

/**
 * Read + validate the locked config. Fails closed if the file was loosened.
 *
 * `providerBaseUrlOverride` (Phase 5, Task 5.1b — VERIFY V1) is an ADDITIVE eval-only hook:
 * after every deny-wall/fail-closed check below has already passed against the untouched
 * file on disk, it merges `provider.<id>.options.baseURL` into the parsed config for each
 * entry supplied — confirmed against the pinned opencode release's own docs (Providers >
 * Config > Base URL): `{"provider":{"anthropic":{"options":{"baseURL": "..."}}}}` is the
 * documented, supported shape, and the client's default anthropic baseURL is
 * `https://api.anthropic.com/v1` (client appends `/messages`), which is why the eval runner
 * passes a `.../v1`-suffixed override. This never loosens a permission, never touches
 * autoupdate/share/snapshot, and never runs when the override is omitted (every real OSS/SaaS
 * deployment) — it only redirects where inference requests are SENT, not what the sandboxed
 * agent is ALLOWED to do.
 */
export function buildConfigContent(lockedConfigPath: string, providerBaseUrlOverride?: Record<string, string>): string {
	const parsed = JSON.parse(fs.readFileSync(lockedConfigPath, 'utf8'));
	if (parsed?.permission?.bash !== 'deny') throw new Error('locked config must deny bash');
	if (parsed?.permission?.external_directory !== 'deny') throw new Error('locked config must deny external_directory');
	if (parsed?.permission?.webfetch !== 'deny') throw new Error('locked config must deny webfetch');
	if (parsed?.permission?.websearch !== 'deny') throw new Error('locked config must deny websearch');
	// `question` is opencode's interactive multiple-choice prompt. With "allow" the tool call proceeds
	// and BLOCKS waiting for an answer — but this headless proxy has no UI surface to answer it, so the
	// turn hangs forever. "deny" makes opencode auto-reject the call, and the agent proceeds on its own
	// (the rr-builder prompt tells it to assume a sensible default rather than ask).
	if (parsed?.permission?.question !== 'deny') throw new Error('locked config must deny question (no UI to answer an interactive prompt — it hangs the turn)');
	if (!isLockedEditWall(parsed?.permission?.edit)) {
		throw new Error('locked config must restrict permission.edit to {"**":"deny","*.pipe":"allow","**/*.pipe":"allow"} (deny-first order is required)');
	}
	if (parsed?.autoupdate !== false) throw new Error('locked config must disable autoupdate');
	if (parsed?.share !== 'disabled') throw new Error('locked config must disable share');
	if (parsed?.snapshot !== false) throw new Error('locked config must disable snapshot');
	if (providerBaseUrlOverride) {
		for (const [providerId, baseURL] of Object.entries(providerBaseUrlOverride)) {
			if (!baseURL) continue;
			parsed.provider ??= {};
			parsed.provider[providerId] ??= {};
			parsed.provider[providerId].options = { ...parsed.provider[providerId].options, baseURL };
		}
	}
	return JSON.stringify(parsed, null, 2);
}

export function buildChildEnv(cfg: AgentConfig, opts: SpawnOpts, password: string): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '',
		HOME: opts.sessionHome,
		XDG_DATA_HOME: path.join(opts.sessionHome, 'data'),
		XDG_CONFIG_HOME: path.join(opts.sessionHome, 'config'),
		XDG_CACHE_HOME: path.join(opts.sessionHome, 'cache'),
		OPENCODE_CONFIG_CONTENT: buildConfigContent(cfg.lockedConfigPath, cfg.providerBaseUrlOverride),
		OPENCODE_SERVER_PASSWORD: password,
		OPENCODE_DISABLE_AUTOUPDATE: '1',
		OPENCODE_DISABLE_MODELS_FETCH: '1',
		OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
		OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
		OPENCODE_DISABLE_CLAUDE_CODE: '1',
		RR_MCP_PROXY_URL: opts.mcpProxyUrl,
	};
	if (opts.providerKeys.anthropic) env.AGENT_ANTHROPIC_KEY = opts.providerKeys.anthropic;
	if (opts.providerKeys.openai) env.AGENT_OPENAI_KEY = opts.providerKeys.openai;
	return env;
}

export function authHeader(password: string): string {
	// VERIFY V1: default basic-auth username is `opencode` on the pinned release.
	return 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, '127.0.0.1', () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
		srv.on('error', reject);
	});
}

async function waitHealthy(baseUrl: string, password: string, proc: ChildProcess, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let exited = false;
	proc.once('exit', () => { exited = true; });
	while (Date.now() < deadline) {
		if (exited) throw new Error('opencode exited during startup');
		try {
			// VERIFY V1: health path on the pinned release (plan baseline: GET /global/health).
			const res = await fetch(`${baseUrl}/global/health`, { headers: { authorization: authHeader(password) } });
			if (res.ok) return;
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`opencode not healthy after ${timeoutMs}ms`);
}

export async function spawnOpencodeServer(cfg: AgentConfig, opts: SpawnOpts): Promise<OpencodeHandle> {
	fs.mkdirSync(opts.workspaceDir, { recursive: true });
	fs.mkdirSync(opts.sessionHome, { recursive: true });
	const port = await freePort();
	const password = randomBytes(24).toString('base64url');
	const proc = spawn(
		cfg.opencodeBin,
		['serve', '--port', String(port), '--hostname', '127.0.0.1'],
		{ cwd: opts.workspaceDir, env: buildChildEnv(cfg, opts, password), stdio: ['ignore', 'pipe', 'pipe'] },
	);
	// Session-scoped log prefix; NEVER log env (contains inference keys). log.info/log.error
	// also redact any known secret shape that ends up in the child's own stdout/stderr.
	proc.stdout?.on('data', (d: Buffer) => log.info(`[oc ${opts.sessionId}]`, d.toString().trimEnd()));
	proc.stderr?.on('data', (d: Buffer) => log.error(`[oc ${opts.sessionId}]`, d.toString().trimEnd()));
	const baseUrl = `http://127.0.0.1:${port}`;
	try {
		await waitHealthy(baseUrl, password, proc);
	} catch (err) {
		// Final-review fix (Important 3): waitHealthy() timing out — or the process dying
		// mid-startup — must never leave an orphaned child running. It already exited in the
		// latter case, but SIGTERM is harmless against a dead pid; the guard just skips the
		// no-op syscall when we already know it's gone.
		if (!proc.killed) proc.kill('SIGTERM');
		throw err;
	}
	return { proc, port, password, baseUrl };
}
