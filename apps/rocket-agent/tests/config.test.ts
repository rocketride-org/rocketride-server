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

import { loadConfig } from '../src/config';

const BASE = { RR_MCP_UPSTREAM: 'http://localhost:8080/mcp' };

describe('loadConfig', () => {
	test('applies approved defaults', () => {
		const cfg = loadConfig({ ...BASE });
		expect(cfg.mode).toBe('oss');
		expect(cfg.port).toBe(8790);
		expect(cfg.idleTtlMs).toBe(2 * 60 * 60 * 1000);          // 2h — approved
		expect(cfg.workspaceCapBytes).toBe(512 * 1024 * 1024);    // 512MB — approved
		expect(cfg.maxSessionsPerTenant).toBe(10);                // approved
		expect(cfg.retentionDays).toBe(30);
	});

	test('RR_MCP_UPSTREAM is required', () => {
		expect(() => loadConfig({})).toThrow(/RR_MCP_UPSTREAM/);
	});

	test('saas mode requires encryption key, vault url, redis, audit url, agent service token', () => {
		expect(() => loadConfig({ ...BASE, RR_AGENT_MODE: 'saas' })).toThrow(/RR_ENCRYPTION_KEY/);
		expect(() =>
			loadConfig({ ...BASE, RR_AGENT_MODE: 'saas', RR_ENCRYPTION_KEY: 'k' }),
		).toThrow(/RR_VAULT_URL/);
		expect(() =>
			loadConfig({ ...BASE, RR_AGENT_MODE: 'saas', RR_ENCRYPTION_KEY: 'k', RR_VAULT_URL: 'http://alb:5565' }),
		).toThrow(/RR_REDIS_URL/);
		expect(() =>
			loadConfig({
				...BASE, RR_AGENT_MODE: 'saas', RR_ENCRYPTION_KEY: 'k', RR_VAULT_URL: 'http://alb:5565', RR_REDIS_URL: 'redis://r:6379',
			}),
		).toThrow(/RR_AUDIT_URL/);
		expect(() =>
			loadConfig({
				...BASE, RR_AGENT_MODE: 'saas', RR_ENCRYPTION_KEY: 'k', RR_VAULT_URL: 'http://alb:5565',
				RR_REDIS_URL: 'redis://r:6379', RR_AUDIT_URL: 'http://alb:5565/agent/audit',
			}),
		).toThrow(/RR_AGENT_SERVICE_TOKEN/);
		const cfg = loadConfig({
			...BASE, RR_AGENT_MODE: 'saas', RR_ENCRYPTION_KEY: 'k', RR_VAULT_URL: 'http://alb:5565',
			RR_REDIS_URL: 'redis://r:6379', RR_AUDIT_URL: 'http://alb:5565/agent/audit', RR_AGENT_SERVICE_TOKEN: 'tok',
		});
		expect(cfg.auditUrl).toBe('http://alb:5565/agent/audit');
		expect(cfg.agentServiceToken).toBe('tok');
	});

	test('overrides win over defaults', () => {
		const cfg = loadConfig({ ...BASE, RR_SESSION_IDLE_TTL_MS: '60000', RR_MAX_SESSIONS_PER_TENANT: '3' });
		expect(cfg.idleTtlMs).toBe(60000);
		expect(cfg.maxSessionsPerTenant).toBe(3);
	});
});
