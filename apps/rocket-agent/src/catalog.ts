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

// =============================================================================
// PROVIDER MODEL CATALOG — opencode's built-in models.dev list, offline
// =============================================================================
//
// The bring-your-own-key/model picker needs a model list per provider. For
// `native` providers (openai, anthropic, google, …) opencode already ships the
// catalog: its `GET /provider` endpoint returns `{ all, default, connected }`
// where `all` is the full bundled models.dev database — independent of which
// providers have keys (`connected`) or are enabled (`enabled_providers`), and
// available with `OPENCODE_DISABLE_MODELS_FETCH=1` (it reads the bundled
// snapshot, never the network).
//
// So this module spawns ONE throwaway, keyless opencode `serve`, reads
// `/provider`, keeps only the models the agent can actually drive (tool-calling,
// not deprecated) for each provider in our registry, and caches the result for
// the process lifetime (the bundled catalog never changes at runtime). The
// spawn is torn down immediately. `openai-compatible` providers opencode can't
// enumerate carry their own curated `models` in the registry and are NOT fetched
// here — see providers.ts.
// =============================================================================

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentConfig } from './config';
import { authHeader, spawnOpencodeServer } from './opencode';
import { PROVIDERS } from './providers';
import { log } from './log';

/** One selectable model, as surfaced to the inference-settings picker. */
export interface CatalogModel {
	/** Provider-native model id — the `<providerId>/<id>` model string the agent uses. */
	id: string;
	/** Human label; falls back to the id. */
	title: string;
}

/** Shape of one entry in opencode `GET /provider`'s `all` array (only the fields we read). */
export interface OcProviderEntry {
	id: string;
	models?: Record<string, { id?: string; name?: string; tool_call?: boolean; status?: string }>;
}

/** opencode provider ids we surface as `native` — the only ones we keep from `/provider`. */
const NATIVE_IDS = new Set(PROVIDERS.filter((p) => p.mode === 'native').map((p) => p.id));

/**
 * Model ids that can't drive a chat/agent turn — image, audio, embedding, moderation,
 * rerank, and realtime endpoints. opencode's `/provider` catalog lists these alongside chat
 * models but they'd only ever error mid-turn if picked, so we drop them. Matched on the id.
 */
const NON_CHAT_RE = /(^|[-/_])(whisper|tts|embed|embedding|moderation|image|dall-?e|realtime|audio|transcribe|sora|clip|rerank|guard)([-/_]|$)/i;

/**
 * Pure mapping of opencode's `/provider` `all` list to our per-provider model catalog: keeps
 * only the providers we surface as `native`, and within each drops `deprecated` models and
 * non-chat endpoints (see {@link NON_CHAT_RE}). NOTE: opencode's `/provider` payload does NOT
 * populate a per-model `tool_call` flag (it comes back `undefined`), so we deliberately do NOT
 * filter on it — doing so would drop every model. Providers that end up with zero usable
 * models are omitted. Exported (and spawn-free) so it's unit-testable.
 */
export function mapNativeCatalog(all: OcProviderEntry[], nativeIds: ReadonlySet<string> = NATIVE_IDS): Record<string, CatalogModel[]> {
	const out: Record<string, CatalogModel[]> = {};
	for (const entry of all) {
		if (!nativeIds.has(entry.id)) continue;
		const models: CatalogModel[] = [];
		for (const m of Object.values(entry.models ?? {})) {
			if (m.status === 'deprecated') continue;
			const id = m.id;
			if (!id || NON_CHAT_RE.test(id)) continue;
			models.push({ id, title: m.name || id });
		}
		if (models.length) out[entry.id] = models;
	}
	return out;
}

/** Process-lifetime cache of native providers' models (opencode id -> models). Bundled catalog never changes at runtime. */
let cached: Record<string, CatalogModel[]> | undefined;
/** In-flight fetch, so concurrent callers share one spawn rather than racing several. */
let inflight: Promise<Record<string, CatalogModel[]>> | undefined;

/**
 * Native providers' models from opencode's built-in catalog, keyed by opencode provider id.
 * Cached for the process lifetime; a failed fetch returns `{}` and is NOT cached, so a later
 * call retries. `openai-compatible` providers are absent here (their models live in the registry).
 */
export async function getNativeModelCatalog(cfg: AgentConfig): Promise<Record<string, CatalogModel[]>> {
	if (cached) return cached;
	if (!inflight) {
		inflight = fetchCatalog(cfg)
			.then((result) => {
				cached = result;
				return result;
			})
			.catch((err) => {
				log.error('[catalog] failed to fetch opencode provider catalog:', err instanceof Error ? err.message : String(err));
				return {} as Record<string, CatalogModel[]>;
			})
			.finally(() => {
				inflight = undefined;
			});
	}
	return inflight;
}

async function fetchCatalog(cfg: AgentConfig): Promise<Record<string, CatalogModel[]>> {
	const tmpRoot = mkdtempSync(path.join(tmpdir(), 'ra-catalog-'));
	const workspaceDir = path.join(tmpRoot, 'ws');
	const sessionHome = path.join(tmpRoot, 'home');
	let handle: Awaited<ReturnType<typeof spawnOpencodeServer>> | undefined;
	try {
		handle = await spawnOpencodeServer(cfg, {
			sessionId: '__catalog__',
			workspaceDir,
			sessionHome,
			// No MCP round-trips are needed to answer /provider; a dead placeholder is fine.
			mcpProxyUrl: 'http://127.0.0.1:1/mcp',
			inference: { keys: {} },
			// CRITICAL: the catalog spawn must NOT carry the locked config's `enabled_providers`
			// restriction — with it set, `/provider`'s `all` list comes back EMPTY. This minimal
			// config leaves `enabled_providers` unset so opencode returns its full bundled catalog.
			// Safe: this instance runs no agent turn (it reads /provider and is killed), and the
			// phone-home surfaces are already disabled via env (OPENCODE_DISABLE_* in buildChildEnv).
			configContentOverride: JSON.stringify({ autoupdate: false, share: 'disabled', snapshot: false }),
		});
		const res = await fetch(`${handle.baseUrl}/provider`, { headers: { authorization: authHeader(handle.password) } });
		if (!res.ok) throw new Error(`opencode /provider returned ${res.status}`);
		const body = (await res.json()) as { all?: OcProviderEntry[] };
		return mapNativeCatalog(body.all ?? []);
	} finally {
		if (handle && !handle.proc.killed) handle.proc.kill('SIGTERM');
		try {
			rmSync(tmpRoot, { recursive: true, force: true });
		} catch {
			/* best-effort temp cleanup */
		}
	}
}
