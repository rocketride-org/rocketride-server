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

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import { RocketRideClient } from 'rocketride';
import { Auditor, NdjsonSink, SaasSink, digestArgs, extractPipePaths } from './audit';
import { EngineIdentityResolver } from './auth';
import { AgentConfig, loadConfig } from './config';
import { SaasVaultKeyResolver } from './keys';
import { log } from './log';
import { authHeader } from './opencode';
import {
	forward, isToolCallRequest, OPENCODE_TO_MCP_HEADERS, PANEL_TO_OPENCODE_HEADERS,
	parseJsonRpcRequest, readRequestBody, redactApiKeys, sanitizeMcpToolSchemas,
} from './proxy';
import { reconcileOnBoot, startReaper } from './reaper';
import { MemorySessionIndex, RedisSessionIndex } from './sessionIndex';
import { SessionManager } from './session';
import { HttpError, Identity, IdentityResolver, KeyResolver, ProviderKeys, SessionIndex, SessionRecord, StoreFs } from './types';
import { commitTurn, listTurns } from './workspace';

export { MemorySessionIndex, RedisSessionIndex };

/** Default `storeFactory`: a real `RocketRideClient` authenticated with the session's own credential. */
export async function openStore(uri: string, credential: string): Promise<StoreFs> {
	const client = new RocketRideClient({ uri, module: 'rocket-agent', env: {} });
	await client.login(credential);
	return {
		fsReadString: (p) => client.fsReadString(p),
		fsWriteString: (p, text) => client.fsWriteString(p, text),
		// getServices() returns compact summaries (no config schema) — the exact live provider list.
		listServices: async () => (await client.getServices()).services,
		close: async () => {
			await client.logout().catch(() => undefined);
			await client.disconnect();
		},
	};
}

/** OSS default: no multi-user identity — everything belongs to `local`. Task 3.3 adds EngineIdentityResolver. */
export class StaticIdentityResolver implements IdentityResolver {
	async resolve(): Promise<Identity> {
		return { ownerId: 'local', tenantId: 'local' };
	}
}

/** OSS default: inference keys from rocket-agent's own env. Task 3.3 adds SaasVaultKeyResolver. */
export class EnvKeyResolver implements KeyResolver {
	constructor(private env: NodeJS.ProcessEnv = process.env) {}
	async resolve(): Promise<ProviderKeys> {
		return { anthropic: this.env.AGENT_ANTHROPIC_KEY, openai: this.env.AGENT_OPENAI_KEY };
	}
}

export interface AppDeps {
	cfg: AgentConfig;
	manager: SessionManager;
	index: SessionIndex;
	identity: IdentityResolver;
	/** Task 5.2a: emits `mcp.tool` / `agent.prompt` / `agent.permission` audit records. Defaults to an `NdjsonSink` under `cfg.dataDir` — every existing caller that doesn't pass one keeps working unchanged. */
	auditor?: Auditor;
}

/** Parses a possibly-empty request body buffer as JSON; undefined on empty/invalid input. Used only to build the audit `argsDigest` — never to change forwarding behavior. */
function parseBufferJson(buf: Buffer | undefined): unknown {
	if (!buf || buf.length === 0) return undefined;
	try {
		return JSON.parse(buf.toString('utf8'));
	} catch {
		return undefined;
	}
}

const PROMPT_ASYNC_RE = /^\/session\/[^/]+\/prompt_async\/?$/;
const PERMISSION_REPLY_RE = /^\/session\/[^/]+\/permissions\/[^/]+\/?$/;

export function publicRecord(r: SessionRecord) {
	return {
		sessionId: r.sessionId,
		title: r.title,
		pipePath: r.pipePath,
		pipesTouched: r.pipesTouched,
		status: r.status,
		lastActivity: r.lastActivity,
		createdAt: r.createdAt,
		// 3.3 sets this when archive()'s final save-back throws; 3.5 surfaces it in listings
		// so the panel can flag "some pipes may not have saved" instead of silently hiding it.
		saveFailed: r.saveFailed ?? false,
	};
}

function bearer(req: Request): string | null {
	const h = req.headers.authorization ?? '';
	return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
}

/**
 * Methods that can grow a session's workspace, gated behind `workspace_full` (Important 4,
 * final-review). DELETE is deliberately excluded on every route that checks this — it can
 * only shrink the workspace, and blocking it would leave the user with no way to clean up
 * enough for the cap check to ever clear.
 */
const WORKSPACE_FULL_BLOCKED_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export function createApp(deps: AppDeps): express.Express {
	const app = express();
	const auditor = deps.auditor ?? new Auditor(new NdjsonSink(deps.cfg.dataDir));

	// D5: permissive CORS in OSS mode only — OSS runs single-tenant on localhost with no
	// cookie-based auth to protect, so cross-origin panel access is safe to allow outright.
	// SaaS mode never sets these headers.
	if (deps.cfg.mode === 'oss') {
		app.use((req: Request, res: Response, next: NextFunction) => {
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
			res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE');
			if (req.method === 'OPTIONS') { res.status(204).end(); return; }
			next();
		});
	}

	// Authenticated JSON API. Body parsing is scoped HERE — proxy routes (Task 3.3)
	// must receive raw streams, so no app-level express.json().
	const api = express.Router();
	api.use(express.json());
	api.use(async (req: Request & { identity?: Identity; credential?: string }, res, next) => {
		const credential = bearer(req);
		if (!credential) { res.status(401).json({ error: 'Bearer token required' }); return; }
		try {
			req.identity = await deps.identity.resolve(credential);
			req.credential = credential;
			next();
		} catch (err) {
			// Visibility: surface WHY auth failed (resolver error) — `log` redacts the credential.
			log.warn('[auth] credential rejected:', (err as Error).message);
			res.status(401).json({ error: 'Invalid credential' });
		}
	});

	api.post('/sessions', async (req: Request & { identity?: Identity; credential?: string }, res, next) => {
		try {
			const { pipePath, title } = (req.body ?? {}) as { pipePath?: string; title?: string };
			const record = await deps.manager.create({
				identity: req.identity!,
				credential: req.credential!,
				pipePath,
				title,
			});
			// Deliberate deviation from plan.md's `{sessionId, url, credential}`: the basic-auth
			// credential never leaves the server — the Task 3.3 proxy stamps it (decided auth model).
			// (publicRecord() already carries sessionId — no need to restate it here.)
			res.status(201).json({
				url: `/agent/sessions/${record.sessionId}/opencode`,
				...publicRecord(record),
			});
		} catch (err) { next(err); }
	});

	// 3.5: owner-scoped listing for the panel's session picker (Phase 4A consumes this).
	api.get('/sessions', async (req: Request & { identity?: Identity }, res, next) => {
		try {
			const records = await deps.index.listByOwner(req.identity!.ownerId);
			res.json(records.map(publicRecord));
		} catch (err) { next(err); }
	});

	// 3.5: rename a session. Owner-scoped like every other per-session route; also updates
	// the live record in place so a currently-running session's title stays in sync.
	api.patch('/sessions/:id', async (req: Request & { identity?: Identity }, res, next) => {
		try {
			const record = await deps.index.get(req.params.id);
			if (!record || record.ownerId !== req.identity!.ownerId) { res.status(404).json({ error: 'no such session' }); return; }
			const { title } = (req.body ?? {}) as { title?: string };
			if (typeof title !== 'string' || !title.trim()) { res.status(400).json({ error: 'title required' }); return; }
			record.title = title.trim().slice(0, 120);
			const live = deps.manager.getLive(req.params.id);
			if (live) live.record.title = record.title;
			await deps.index.put(record);
			res.json(publicRecord(record));
		} catch (err) { next(err); }
	});

	// 3.5: resume an archived (or already-live) session — re-spawns opencode over the same
	// sessionHome so the transcript rehydrates. Owner-scoping + the 429/412 cases live in
	// SessionManager.resume() (Task 3.3), surfaced here via the shared error middleware.
	api.post('/sessions/:id/resume', async (req: Request & { identity?: Identity; credential?: string }, res, next) => {
		try {
			const record = await deps.manager.resume(req.params.id, req.identity!, req.credential!);
			res.json({ ...publicRecord(record), url: `/agent/sessions/${record.sessionId}/opencode` });
		} catch (err) { next(err); }
	});

	api.get('/sessions/:id/health', async (req: Request & { identity?: Identity }, res, next) => {
		try {
			const record = await deps.index.get(req.params.id);
			if (!record || record.ownerId !== req.identity!.ownerId) { res.status(404).json({ error: 'no such session' }); return; }
			const live = deps.manager.getLive(req.params.id);
			let opencodeOk = false;
			if (live) {
				try {
					const r = await fetch(`${live.baseUrl}/global/health`, { headers: { authorization: authHeader(live.password) } });
					opencodeOk = r.ok;
				} catch { /* down */ }
			}
			// Visibility: which MCP upstream this agent is wired to. The full 26-tool engine mounts at
			// `/mcp`; the dev stub is a bare loopback URL. Lets the panel show "real" vs "stub" at a glance
			// (opencode's tool-list endpoints only expose built-ins, not the MCP tools, so this is the
			// authoritative signal). No URL is leaked — just the derived label.
			res.json({ status: record.status, opencode: opencodeOk, engine: deps.cfg.mcpUpstream.includes('/mcp') ? 'real' : 'stub' });
		} catch (err) { next(err); }
	});

	api.delete('/sessions/:id', async (req: Request & { identity?: Identity }, res, next) => {
		try {
			const record = await deps.index.get(req.params.id);
			if (!record || record.ownerId !== req.identity!.ownerId) { res.status(404).json({ error: 'no such session' }); return; }
			// Default: archive, not destroy — save-back + snapshot + free the process, so the
			// transcript stays resumable (POST /sessions/:id/resume) until retention purges it.
			// `?purge=true`: hard-delete — remove the transcript + workspace and drop the record.
			if (req.query.purge === 'true') await deps.manager.purge(req.params.id);
			else await deps.manager.archive(req.params.id);
			res.status(204).end();
		} catch (err) { next(err); }
	});

	// D2: explicit save-back — mirrors the reaper/archive path, callable on demand from the panel.
	api.post('/sessions/:id/save', async (req: Request & { identity?: Identity; credential?: string }, res, next) => {
		try {
			const live = deps.manager.getLive(req.params.id);
			if (!live || live.record.ownerId !== req.identity!.ownerId) { res.status(404).json({ error: 'no such session' }); return; }
			deps.manager.touch(live, req.credential!);
			const pipes = await deps.manager.saveBackNow(live);
			res.json({ pipes });
		} catch (err) { next(err); }
	});

	// D3: thin wrappers over Task 3.2's listTurns/revertTo — operate on the on-disk
	// workspace directly, so they work even when the session isn't currently live.
	api.get('/sessions/:id/turns', async (req: Request & { identity?: Identity }, res, next) => {
		try {
			const record = await deps.index.get(req.params.id);
			if (!record || record.ownerId !== req.identity!.ownerId) { res.status(404).json({ error: 'no such session' }); return; }
			const workspaceDir = path.join(deps.manager.sessionRoot(req.params.id), 'workspace');
			res.json(await listTurns(workspaceDir));
		} catch (err) { next(err); }
	});

	api.post('/sessions/:id/revert', async (req: Request & { identity?: Identity }, res, next) => {
		try {
			const record = await deps.index.get(req.params.id);
			if (!record || record.ownerId !== req.identity!.ownerId) { res.status(404).json({ error: 'no such session' }); return; }
			const { sha } = (req.body ?? {}) as { sha?: string };
			if (!sha) { res.status(400).json({ error: 'sha is required' }); return; }
			res.json({ sha: await deps.manager.revert(req.params.id, sha) });
		} catch (err) { next(err); }
	});

	// Express 4 does not forward async-handler rejections to any error middleware — an
	// unhandled rejection crashes the WHOLE process, taking every tenant's session down
	// with it. Every raw route below (no express.json(), does its own auth) wraps its
	// body in try/catch and always responds (502/500 JSON if headers are still unsent,
	// otherwise a clean res.end()) instead of ever letting a rejection escape.
	function safeSend(res: Response, status: number, body: { error: string }): void {
		if (!res.headersSent) { res.status(status).json(body); return; }
		if (!res.writableEnded) res.end();
	}

	// Browser ↔ per-session opencode (Zitadel pass-through; owner-only; SSE passthrough).
	// Mounted BEFORE the `/agent` JSON router so bodies stay raw — this route does its own auth.
	app.all('/agent/sessions/:id/opencode/*', async (req: Request, res: Response): Promise<void> => {
		const credential = bearer(req);
		if (!credential) { res.status(401).json({ error: 'Bearer token required' }); return; }
		let identity: Identity;
		try { identity = await deps.identity.resolve(credential); }
		catch { res.status(401).json({ error: 'Invalid credential' }); return; }
		const live = deps.manager.getLive(req.params.id);
		if (!live) { res.status(404).json({ error: 'no live session (resume it first)' }); return; }
		if (live.record.ownerId !== identity.ownerId) { res.status(403).json({ error: 'not your session' }); return; }
		// Important 4 (final-review): pauseForCap() only ever set status + emitted an event —
		// nothing actually stopped writes, so a session over the 512MB cap could keep growing
		// the shared PVC unbounded (cross-tenant disk DoS). See WORKSPACE_FULL_BLOCKED_METHODS.
		if (live.record.status === 'workspace_full' && WORKSPACE_FULL_BLOCKED_METHODS.has(req.method)) {
			res.status(413).json({ error: 'workspace at capacity — free up space before continuing' });
			return;
		}
		deps.manager.touch(live, credential);
		live.openStreams++;
		const suffix = req.originalUrl.slice(`/agent/sessions/${req.params.id}/opencode`.length) || '/';

		// Task 5.2a: tap `agent.prompt` (POST .../prompt_async) and `agent.permission` (POST
		// .../permissions/:id) — the only two opencode calls the audit trail cares about. Both
		// bodies are small, single JSON control messages, so buffering them here (instead of the
		// route's normal zero-copy stream) is safe; every other suffix (including SSE) is
		// completely untouched below.
		let auditBody: Buffer | undefined;
		let auditKind: 'agent.prompt' | 'agent.permission' | undefined;
		// Reachable here only past the workspace_full 413 short-circuit above (which already
		// rejects every POST before touch()/openStreams++), so no need to re-check it.
		if (req.method === 'POST') {
			if (PROMPT_ASYNC_RE.test(suffix)) {
				auditBody = await readRequestBody(req);
				auditKind = 'agent.prompt';
			} else if (PERMISSION_REPLY_RE.test(suffix)) {
				auditBody = await readRequestBody(req);
				auditKind = 'agent.permission';
			}
		}
		try {
			// Important 5 (final-review, verified against the pinned binary): opencode
			// resolves the locked config's provider apiKey placeholders before serving
			// /config* — buffer + redact those instead of streaming them straight to the
			// browser. Everything else keeps the zero-copy streaming pass-through.
			if ((req.method === 'GET' || req.method === 'HEAD') && /^\/config(\/|$|\?)/.test(suffix)) {
				const upstream = await fetch(`${live.baseUrl}${suffix}`, { headers: { authorization: authHeader(live.password) } });
				const text = await upstream.text();
				let body: unknown = text;
				try { body = redactApiKeys(JSON.parse(text)); } catch { /* not JSON — nothing to redact, pass through as-is */ }
				res.status(upstream.status).json(body);
				return;
			}
			const status = await forward(req, res, `${live.baseUrl}${suffix}`, { authorization: authHeader(live.password) }, PANEL_TO_OPENCODE_HEADERS, auditBody);
			if (auditKind === 'agent.prompt') {
				auditor.record({
					sessionId: live.record.sessionId, tenantId: live.record.tenantId, userId: live.record.ownerId,
					kind: 'agent.prompt', action: 'prompt_async',
					argsDigest: digestArgs(parseBufferJson(auditBody)),
					status: status === 204 ? 'ok' : 'error',
				});
			} else if (auditKind === 'agent.permission') {
				const replyBody = parseBufferJson(auditBody) as { response?: string } | undefined;
				const denied = replyBody?.response === 'reject';
				auditor.record({
					sessionId: live.record.sessionId, tenantId: live.record.tenantId, userId: live.record.ownerId,
					kind: 'agent.permission', action: 'permission.reply',
					argsDigest: digestArgs(replyBody),
					status: status >= 400 ? 'error' : denied ? 'denied' : 'ok',
				});
			}
		} catch (err) {
			log.error(`[opencode-proxy ${req.params.id}]`, err);
			safeSend(res, 502, { error: 'opencode proxy failed' });
		} finally {
			live.openStreams--;
		}
	});

	// rocket-agent's own panel events (auth.expired / auth.refreshed / snapshot / saved / workspace_full).
	app.get('/agent/sessions/:id/events', async (req: Request, res: Response): Promise<void> => {
		let live: ReturnType<typeof deps.manager.getLive>;
		// `decremented` starts true (nothing incremented yet) so a throw before the
		// openStreams++ below is a no-op; flips false the instant we increment, and
		// decrementOnce() below is idempotent — guarantees exactly-one decrement no
		// matter which of {normal close, error before listener registration, error
		// after} is the actual exit path (a leaked increment here would make the
		// reaper skip this session forever — the inverse of the bug it fixes).
		let decremented = true;
		const decrementOnce = () => { if (!decremented) { decremented = true; live!.openStreams--; } };
		try {
			const credential = bearer(req);
			if (!credential) { res.status(401).json({ error: 'Bearer token required' }); return; }
			let identity: Identity;
			try { identity = await deps.identity.resolve(credential); }
			catch { res.status(401).json({ error: 'Invalid credential' }); return; }
			live = deps.manager.getLive(req.params.id);
			if (!live || live.record.ownerId !== identity.ownerId) { res.status(404).json({ error: 'no such session' }); return; }

			live.openStreams++;
			decremented = false;
			res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
			res.write(': connected\n\n');
			const onEvent = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
			live.events.on('event', onEvent);
			req.on('close', () => { live!.events.off('event', onEvent); decrementOnce(); });
		} catch (err) {
			log.error(`[events ${req.params.id}]`, err);
			decrementOnce();
			safeSend(res, 500, { error: 'events stream failed' });
		}
	});

	// Canvas write-through (Phase 4B): workspace file is truth during a session.
	app.put('/agent/sessions/:id/files/*', express.text({ type: '*/*', limit: '10mb' }), async (req: Request, res: Response): Promise<void> => {
		try {
			const credential = bearer(req);
			if (!credential) { res.status(401).json({ error: 'Bearer token required' }); return; }
			let identity: Identity;
			try { identity = await deps.identity.resolve(credential); }
			catch { res.status(401).json({ error: 'Invalid credential' }); return; }
			const live = deps.manager.getLive(req.params.id);
			if (!live || live.record.ownerId !== identity.ownerId) { res.status(404).json({ error: 'no such session' }); return; }
			// Important 4 (final-review): the 512MB workspace cap was advisory-only — nothing
			// actually stopped a write once pauseForCap() flipped the status. Block it here too.
			if (live.record.status === 'workspace_full') {
				res.status(413).json({ error: 'workspace at capacity — free up space before writing' });
				return;
			}
			const rel = (req.params as Record<string, string>)[0] ?? '';
			if (rel.split('/').some((seg) => seg === '..') || !rel.endsWith('.pipe')) {
				res.status(400).json({ error: 'only workspace-relative .pipe paths' });
				return;
			}
			deps.manager.touch(live, credential);
			await fsp.writeFile(path.join(live.workspaceDir, rel), req.body as string, 'utf8');
			const sha = await commitTurn(live.workspaceDir, `canvas edit: ${rel}`);
			res.json({ ok: true, snapshot: sha });
		} catch (err) {
			log.error(`[files ${req.params.id}]`, err);
			safeSend(res, 500, { error: 'write failed' });
		}
	});

	// opencode → EAAS MCP: token injection with the freshest cached panel token.
	// Reachable only via the per-session random secret; never routed at the edge (/agent only).
	app.all('/internal/mcp/:id/:secret', async (req: Request, res: Response): Promise<void> => {
		const live = deps.manager.getLive(req.params.id);
		if (!live || live.mcpSecret !== req.params.secret) { res.status(404).end(); return; }
		live.openStreams++;
		const start = Date.now();

		// Task 5.2a: every `tools/call` JSON-RPC frame is a small, single control message —
		// buffer the request body here (once) so it can be parsed for the audit tap, then hand
		// it back to forward() via bodyOverride. The RESPONSE stays fully streamed (never
		// buffered), so a tool that streams its result back is unaffected; ok/error is read off
		// the HTTP status alone (the same shared parseJsonRpcRequest/isToolCallRequest seam
		// eval/src/runner.ts's ToolCallRecorder uses for the request side — see proxy.ts).
		let mcpBody: Buffer | undefined;
		let toolCall: { name: string; args: Record<string, unknown> | undefined } | undefined;
		let isToolsList = false;
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			mcpBody = await readRequestBody(req);
			const frame = parseJsonRpcRequest(mcpBody);
			if (isToolCallRequest(frame)) toolCall = { name: frame.params.name, args: frame.params.arguments };
			// `tools/list` is the one response we rewrite (OpenAI schema shim) — see sanitizeMcpToolSchemas.
			if (frame?.method === 'tools/list') isToolsList = true;
		}
		const recordToolCall = (status: 'ok' | 'error') => {
			if (!toolCall) return;
			const pipePaths = extractPipePaths(toolCall.args);
			auditor.record({
				sessionId: live.record.sessionId,
				tenantId: live.record.tenantId,
				userId: live.record.ownerId,
				kind: 'mcp.tool',
				action: toolCall.name,
				argsDigest: digestArgs(toolCall.args),
				pipePaths: pipePaths.length ? pipePaths : undefined,
				status,
				durationMs: Date.now() - start,
			});
		};
		try {
			// Stamp the upstream Bearer: a fixed RR_MCP_UPSTREAM_TOKEN (shared/real engine keyed by
			// one API key) when configured, else the caller's own panel credential (default).
			const status = await forward(req, res, deps.cfg.mcpUpstream, { authorization: `Bearer ${deps.cfg.mcpUpstreamToken ?? live.latestToken}` }, OPENCODE_TO_MCP_HEADERS, mcpBody, isToolsList ? sanitizeMcpToolSchemas : undefined);
			if (status === 401) deps.manager.pauseForAuth(live);
			recordToolCall(status < 400 ? 'ok' : 'error');
		} catch (err) {
			log.error(`[mcp-proxy ${req.params.id}]`, err);
			safeSend(res, 502, { error: 'mcp proxy failed' });
			recordToolCall('error');
		} finally {
			live.openStreams--;
		}
	});

	app.use('/agent', api);
	app.get('/healthz', (_req, res) => res.json({ ok: true }));

	app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
		if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
		log.error('[rocket-agent]', err);
		return res.status(500).json({ error: 'internal error' });
	});
	return app;
}

if (require.main === module) {
	void (async () => {
		const cfg = loadConfig();
		// 3.5: Redis-backed index when RR_REDIS_URL is set (SaaS: multi-replica rocket-agent
		// needs a shared index) — OSS single-process mode keeps the in-memory default.
		const index: SessionIndex = cfg.redisUrl ? new RedisSessionIndex(cfg.redisUrl) : new MemorySessionIndex();
		// OSS users who point ROCKETRIDE_URI at a real engine can opt into EngineIdentityResolver
		// later; v1 keeps OSS single-user (StaticIdentityResolver / EnvKeyResolver).
		const identity = cfg.mode === 'saas' ? new EngineIdentityResolver(cfg.rocketrideUri) : new StaticIdentityResolver();
		const keys = cfg.mode === 'saas' ? new SaasVaultKeyResolver(cfg.vaultUrl!, cfg.encryptionKey!) : new EnvKeyResolver();
		// Task 5.2a: one Auditor, shared between SessionManager (lifecycle records) and
		// createApp's routes (mcp.tool / agent.prompt / agent.permission) — a single sink
		// instance per process, not two independently-opened NdjsonSink file handles racing
		// each other on the same day's file.
		const auditor = new Auditor(
			cfg.mode === 'saas' ? new SaasSink({ url: cfg.auditUrl!, serviceToken: cfg.agentServiceToken! }) : new NdjsonSink(cfg.dataDir),
		);
		const manager = new SessionManager({
			cfg,
			keys,
			index,
			storeFactory: (credential) => openStore(cfg.rocketrideUri, credential),
			auditor,
		});
		// Final-review Critical 2: this replica starts with an empty live map, so any
		// non-archived record left over from the PREVIOUS process (killed outright by
		// `strategy: Recreate` on the last deploy) is an orphan — see reconcileOnBoot()'s
		// docstring in reaper.ts for why leaving it unarchived permanently eats a tenant slot.
		await reconcileOnBoot(manager, index);
		startReaper(manager, index, cfg);

		// The other half of the same fix: archive every live session (save-back + snapshot +
		// free the process) BEFORE this replica exits, so a graceful Recreate redeploy never
		// needs reconcileOnBoot() to clean up after it in the first place.
		let shuttingDown = false;
		const shutdown = (signal: NodeJS.Signals) => {
			if (shuttingDown) return;
			shuttingDown = true;
			const live = manager.listLive().length;
			log.info(`[rocket-agent] ${signal} received — archiving ${live} live session(s) before exit`);
			manager.archiveAllLive()
				.catch((err) => log.error('[rocket-agent] archiveAllLive failed during shutdown', err))
				.finally(() => process.exit(0));
		};
		process.once('SIGTERM', shutdown);
		process.once('SIGINT', shutdown);

		createApp({ cfg, manager, index, identity, auditor })
			.listen(cfg.port, () => log.info(`[rocket-agent] listening on :${cfg.port} (${cfg.mode})`));
	})();
}
