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

import * as path from 'node:path';

export interface AgentConfig {
	port: number;
	mode: 'oss' | 'saas';
	opencodeBin: string;
	rocketrideUri: string;
	mcpUpstream: string;
	/**
	 * Optional fixed Bearer token stamped toward the upstream MCP engine, overriding the
	 * per-caller panel credential. Set (via RR_MCP_UPSTREAM_TOKEN) when the upstream is a
	 * shared/real engine authenticated by a single API key rather than the caller's own token
	 * (e.g. dev pointing at the live engine's /mcp with the ROCKETRIDE_APIKEY). Unset = keep the
	 * default behavior of forwarding the caller's Bearer.
	 */
	mcpUpstreamToken?: string;
	redisUrl?: string;
	dataDir: string;
	docsDir: string;
	assetsDir: string;
	lockedConfigPath: string;
	idleTtlMs: number;
	workspaceCapBytes: number;
	maxSessionsPerTenant: number;
	retentionDays: number;
	vaultUrl?: string;
	encryptionKey?: string;
	/**
	 * Task 5.2a: cluster-internal ALB route the audit `SaasSink` batches `{records}` to (same
	 * pattern as `vaultUrl` — required in saas mode, absent in OSS where `NdjsonSink` is used
	 * instead).
	 */
	auditUrl?: string;
	/**
	 * Static bearer service-token guarding `auditUrl` — the same internal-service-auth pattern
	 * `google_oauth.py`'s `POST /internal/google/oauth/tokens` uses via `RR_LAMBDA_SERVICE_TOKEN`
	 * (a shared secret compared with `hmac.compare_digest`, NOT a per-user credential — the
	 * `/agent/keys/blob` vault route forwards the caller's own token instead, but that pattern
	 * doesn't fit here: one SaasSink flush batches records from many sessions/users at once).
	 */
	agentServiceToken?: string;
	/**
	 * Eval-only hook (Phase 5, Task 5.1b): per-provider base URL override, keyed by the
	 * `provider.<id>` block name in the locked opencode config (e.g. `{ anthropic: 'http://127.0.0.1:PORT/v1' }`).
	 * `loadConfig()` never sets this — it stays undefined for every real (OSS/SaaS) deployment.
	 * The eval runner assigns it directly on its own `AgentConfig` so `buildConfigContent()`
	 * (src/opencode.ts) can point the session's opencode child at the replay/proxy-record model
	 * server instead of the real provider, without touching SessionManager or the locked-config
	 * file's deny-wall validation.
	 */
	providerBaseUrlOverride?: Record<string, string>;
}

const DEFAULTS: Record<string, string> = {
	RR_AGENT_PORT: '8790',
	RR_SESSION_IDLE_TTL_MS: String(2 * 60 * 60 * 1000),
	RR_WORKSPACE_CAP_BYTES: String(512 * 1024 * 1024),
	RR_MAX_SESSIONS_PER_TENANT: '10',
	RR_SESSION_RETENTION_DAYS: '30',
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
	const get = (k: string): string => env[k] ?? DEFAULTS[k];
	const mode: 'oss' | 'saas' = env.RR_AGENT_MODE === 'saas' ? 'saas' : 'oss';
	const mcpUpstream = env.RR_MCP_UPSTREAM;
	if (!mcpUpstream) {
		throw new Error('RR_MCP_UPSTREAM is required (engine MCP endpoint, e.g. http://localhost:8080/mcp)');
	}
	if (mode === 'saas') {
		if (!env.RR_ENCRYPTION_KEY) throw new Error('RR_AGENT_MODE=saas requires RR_ENCRYPTION_KEY');
		if (!env.RR_VAULT_URL) throw new Error('RR_AGENT_MODE=saas requires RR_VAULT_URL');
		if (!env.RR_REDIS_URL) throw new Error('RR_AGENT_MODE=saas requires RR_REDIS_URL');
		if (!env.RR_AUDIT_URL) throw new Error('RR_AGENT_MODE=saas requires RR_AUDIT_URL');
		if (!env.RR_AGENT_SERVICE_TOKEN) throw new Error('RR_AGENT_MODE=saas requires RR_AGENT_SERVICE_TOKEN');
	}
	const appRoot = path.resolve(__dirname, '..');
	return {
		port: Number(get('RR_AGENT_PORT')),
		mode,
		opencodeBin: env.OPENCODE_BIN ?? 'opencode',
		rocketrideUri: env.ROCKETRIDE_URI ?? 'http://localhost:5565',
		mcpUpstream,
		mcpUpstreamToken: env.RR_MCP_UPSTREAM_TOKEN,
		redisUrl: env.RR_REDIS_URL,
		dataDir: env.RR_AGENT_DATA_DIR ?? path.resolve('.rocket-agent'),
		docsDir: env.RR_AGENT_DOCS_DIR ?? path.join(appRoot, 'assets', 'docs'),
		// appRoot resolves to dist/ at runtime (from dist/src/config.js), but build-assets.mjs
		// writes assets into the SOURCE tree (apps/rocket-agent/assets), not dist/ — so the default
		// dist/assets does not exist and seeding silently no-ops. RR_AGENT_ASSETS_DIR overrides it
		// (dev up.sh points it at the built assets); mirrors RR_AGENT_DOCS_DIR.
		assetsDir: env.RR_AGENT_ASSETS_DIR ?? path.join(appRoot, 'assets'),
		lockedConfigPath: env.RR_LOCKED_CONFIG ?? path.join(appRoot, 'config', 'opencode-locked.json'),
		idleTtlMs: Number(get('RR_SESSION_IDLE_TTL_MS')),
		workspaceCapBytes: Number(get('RR_WORKSPACE_CAP_BYTES')),
		maxSessionsPerTenant: Number(get('RR_MAX_SESSIONS_PER_TENANT')),
		retentionDays: Number(get('RR_SESSION_RETENTION_DAYS')),
		vaultUrl: env.RR_VAULT_URL,
		encryptionKey: env.RR_ENCRYPTION_KEY,
		auditUrl: env.RR_AUDIT_URL,
		agentServiceToken: env.RR_AGENT_SERVICE_TOKEN,
	};
}
