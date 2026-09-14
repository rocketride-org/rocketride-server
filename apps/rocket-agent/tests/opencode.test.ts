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

import { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/config';
import { authHeader, buildChildEnv, buildConfigContent } from '../src/opencode';

const BASE = { RR_MCP_UPSTREAM: 'http://localhost:8080/mcp' };
const cfg = loadConfig({ ...BASE });

const spawnOpts = {
	sessionId: 's1',
	workspaceDir: '/tmp/s1/workspace',
	sessionHome: '/tmp/s1/home',
	mcpProxyUrl: 'http://127.0.0.1:8790/internal/mcp/s1/secret',
	providerKeys: { anthropic: 'sk-ant-test' },
};

describe('buildConfigContent', () => {
	test('round-trips the locked config and keeps the deny wall', () => {
		const content = JSON.parse(buildConfigContent(cfg.lockedConfigPath));
		expect(content.autoupdate).toBe(false);
		expect(content.share).toBe('disabled');
		expect(content.permission.bash).toBe('deny');
		expect(content.permission.webfetch).toBe('deny');
		expect(content.permission.external_directory).toBe('deny');
		expect(content.permission.edit).toEqual({ '**/*.pipe': 'allow', '*': 'deny' });
		expect(content.mcp.rocketride.url).toBe('{env:RR_MCP_PROXY_URL}');
	});

	function tamperedConfigPath(mutate: (loose: any) => void): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-'));
		const bad = path.join(dir, 'bad.json');
		const loose = JSON.parse(fs.readFileSync(cfg.lockedConfigPath, 'utf8'));
		mutate(loose);
		fs.writeFileSync(bad, JSON.stringify(loose));
		return bad;
	}

	test.each<[string, (loose: any) => void, RegExp]>([
		['bash', (c) => { c.permission.bash = 'allow'; }, /deny bash/],
		['external_directory', (c) => { c.permission.external_directory = 'allow'; }, /deny external_directory/],
		['webfetch', (c) => { c.permission.webfetch = 'allow'; }, /deny webfetch/],
		['websearch', (c) => { c.permission.websearch = 'allow'; }, /deny websearch/],
		['edit wall (loosened wildcard)', (c) => { c.permission.edit = { '*': 'allow' }; }, /permission\.edit/],
		['edit wall (missing pipe rule)', (c) => { c.permission.edit = { '*': 'deny' }; }, /permission\.edit/],
		['autoupdate', (c) => { c.autoupdate = true; }, /disable autoupdate/],
		['share', (c) => { c.share = 'enabled'; }, /disable share/],
		['snapshot', (c) => { c.snapshot = true; }, /disable snapshot/],
	])('fails closed when %s is loosened', (_name, mutate, expected) => {
		const bad = tamperedConfigPath(mutate);
		expect(() => buildConfigContent(bad)).toThrow(expected);
	});
});

describe('buildChildEnv', () => {
	const env = buildChildEnv(cfg, spawnOpts, 'pw123');

	test('isolates the process into the session home', () => {
		expect(env.HOME).toBe('/tmp/s1/home');
		expect(env.XDG_DATA_HOME).toBe(path.join('/tmp/s1/home', 'data'));
	});

	test('disables every phone-home surface', () => {
		for (const k of [
			'OPENCODE_DISABLE_AUTOUPDATE',
			'OPENCODE_DISABLE_MODELS_FETCH',
			'OPENCODE_DISABLE_DEFAULT_PLUGINS',
			'OPENCODE_DISABLE_LSP_DOWNLOAD',
			'OPENCODE_DISABLE_CLAUDE_CODE',
		]) expect(env[k]).toBe('1');
	});

	test('injects config, basic-auth password, MCP proxy URL, and only the provided keys', () => {
		expect(env.OPENCODE_CONFIG_CONTENT).toContain('"bash": "deny"');
		expect(env.OPENCODE_SERVER_PASSWORD).toBe('pw123');
		expect(env.RR_MCP_PROXY_URL).toBe(spawnOpts.mcpProxyUrl);
		expect(env.AGENT_ANTHROPIC_KEY).toBe('sk-ant-test');
		expect(env.AGENT_OPENAI_KEY).toBeUndefined();
	});

	test('does not leak the parent environment', () => {
		// A tautological check against `env` (built from an OSS-mode cfg that never
		// carried these fields) can't fail on a real leak. Build a cfg that DOES
		// carry SaaS secrets and prove buildChildEnv still excludes them.
		const poisonedCfg = loadConfig({
			...BASE,
			RR_AGENT_MODE: 'saas',
			RR_ENCRYPTION_KEY: 'super-secret-encryption-key',
			RR_VAULT_URL: 'http://vault.internal:5565',
			RR_REDIS_URL: 'redis://secret-redis-host:6379',
			RR_AUDIT_URL: 'http://vault.internal:5565/agent/audit',
			RR_AGENT_SERVICE_TOKEN: 'super-secret-service-token',
		});
		const poisonedEnv = buildChildEnv(poisonedCfg, spawnOpts, 'pw123');
		expect(poisonedEnv.RR_ENCRYPTION_KEY).toBeUndefined();
		expect(poisonedEnv.RR_REDIS_URL).toBeUndefined();
		expect(poisonedEnv.RR_VAULT_URL).toBeUndefined();
		expect(Object.values(poisonedEnv)).not.toContain('super-secret-encryption-key');
		expect(Object.values(poisonedEnv)).not.toContain('redis://secret-redis-host:6379');
	});
});

test('authHeader is opencode:<password> basic auth', () => {
	expect(authHeader('pw')).toBe('Basic ' + Buffer.from('opencode:pw').toString('base64'));
});

// Phase 5, Task 5.1b (VERIFY V1): the eval-only providerBaseUrlOverride hook.
describe('buildConfigContent providerBaseUrlOverride (Phase 5, Task 5.1b)', () => {
	test('merges provider.<id>.options.baseURL additively, alongside the existing apiKey placeholder', () => {
		const content = JSON.parse(buildConfigContent(cfg.lockedConfigPath, { anthropic: 'http://127.0.0.1:4096/v1' }));
		expect(content.provider.anthropic.options.baseURL).toBe('http://127.0.0.1:4096/v1');
		expect(content.provider.anthropic.options.apiKey).toBe('{env:AGENT_ANTHROPIC_KEY}');
		// openai is untouched — only the supplied provider ids are merged.
		expect(content.provider.openai.options.baseURL).toBeUndefined();
	});

	test('omitted override leaves the provider block byte-identical to the unextended call', () => {
		expect(buildConfigContent(cfg.lockedConfigPath, undefined)).toBe(buildConfigContent(cfg.lockedConfigPath));
	});

	test('never weakens the deny-wall — fails closed exactly the same with an override present', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-override-'));
		const bad = path.join(dir, 'bad.json');
		const loose = JSON.parse(fs.readFileSync(cfg.lockedConfigPath, 'utf8'));
		loose.permission.bash = 'allow';
		fs.writeFileSync(bad, JSON.stringify(loose));
		expect(() => buildConfigContent(bad, { anthropic: 'http://127.0.0.1:4096/v1' })).toThrow(/deny bash/);
	});
});

// Final-review fix (Important 3): a spawn that never becomes healthy must never leave an
// orphaned child running. Uses a trivial "binary" that exits immediately instead of a real
// opencode — hermetic (no OPENCODE_BIN needed) and exercises the same failure path (waitHealthy
// throws) as a real startup crash or timeout, without waiting out the real 30s timeout.
describe('spawnOpencodeServer failure cleanup', () => {
	test('a health-check failure kills the child and the caller never gets a handle to leak', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-spawnfail-'));
		const fakeBin = path.join(dir, 'fake-opencode.sh');
		fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

		const killSpy = jest.spyOn(ChildProcess.prototype, 'kill');
		try {
			const { spawnOpencodeServer } = await import('../src/opencode');
			await expect(
				spawnOpencodeServer(loadConfig({ ...BASE, OPENCODE_BIN: fakeBin }), {
					sessionId: 'spawnfail',
					workspaceDir: path.join(dir, 'workspace'),
					sessionHome: path.join(dir, 'home'),
					mcpProxyUrl: 'http://127.0.0.1:9/internal/mcp/spawnfail/x',
					providerKeys: { anthropic: 'sk-ant-dummy' },
				}),
			).rejects.toThrow(/exited during startup/);
			expect(killSpy).toHaveBeenCalledWith('SIGTERM');
		} finally {
			killSpy.mockRestore();
		}
	}, 15_000);
});

const IT = process.env.OPENCODE_BIN ? describe : describe.skip;

IT('spawnOpencodeServer (integration, needs OPENCODE_BIN)', () => {
	test('boots healthy, requires basic auth, and serves the locked permission config', async () => {
		const { spawnOpencodeServer } = await import('../src/opencode');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-it-'));
		const handle = await spawnOpencodeServer(loadConfig({ RR_MCP_UPSTREAM: 'http://localhost:9/mcp', OPENCODE_BIN: process.env.OPENCODE_BIN }), {
			sessionId: 'it1',
			workspaceDir: path.join(dir, 'workspace'),
			sessionHome: path.join(dir, 'home'),
			mcpProxyUrl: 'http://127.0.0.1:9/internal/mcp/it1/x',
			providerKeys: { anthropic: 'sk-ant-dummy' },
		});
		try {
			const unauth = await fetch(`${handle.baseUrl}/global/health`);
			expect(unauth.status).toBe(401);
			// VERIFY V1/V3: config endpoint path + that OPENCODE_CONFIG_CONTENT won.
			const cfgRes = await fetch(`${handle.baseUrl}/config`, { headers: { authorization: authHeader(handle.password) } });
			expect(cfgRes.ok).toBe(true);
			const served = (await cfgRes.json()) as { permission: { bash: string; edit: Record<string, string> } };
			expect(served.permission.bash).toBe('deny');
			expect(served.permission.edit['**/*.pipe']).toBe('allow');
		} finally {
			handle.proc.kill('SIGTERM');
		}
	}, 60_000);
});
