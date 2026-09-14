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

import type { ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Auditor, NdjsonSink, digestArgs } from './audit';
import type { AgentConfig } from './config';
import { log } from './log';
import { authHeader, spawnOpencodeServer } from './opencode';
import { HttpError, Identity, KeyResolver, LiveSession, ProviderKeys, SessionIndex, SessionRecord, StoreFs } from './types';
import { commitTurn, formatComponentCatalog, initGit, revertTo, saveBack, seedWorkspace } from './workspace';

export interface SessionManagerDeps {
	cfg: AgentConfig;
	keys: KeyResolver;
	index: SessionIndex;
	/** Opens a project-store client for a user credential (Task 3.2 default: RocketRideClient). */
	storeFactory: (credential: string) => Promise<StoreFs>;
	/** Task 5.2a: emits `lifecycle` audit records (create/archive/resume/reap/revert). Defaults to an `NdjsonSink` under `cfg.dataDir` — every existing caller that doesn't pass one keeps working unchanged. */
	auditor?: Auditor;
}

export interface CreateOpts {
	identity: Identity;
	credential: string;
	pipePath?: string;
	title?: string;
}

export class SessionManager {
	private live = new Map<string, LiveSession>();
	private tenantLocks = new Map<string, Promise<void>>();
	private readonly auditor: Auditor;

	constructor(readonly deps: SessionManagerDeps) {
		this.auditor = deps.auditor ?? new Auditor(new NdjsonSink(deps.cfg.dataDir));
	}

	getLive(id: string): LiveSession | undefined {
		return this.live.get(id);
	}

	listLive(): LiveSession[] {
		return [...this.live.values()];
	}

	/**
	 * Serializes the check-then-reserve section of create() per tenant.
	 * `await index.countActive(...)` always yields at least one microtask tick
	 * before its result is available, so two create() calls invoked back to
	 * back can both read the pre-reservation count before either has written
	 * its reservation — reordering the write earlier does NOT close that gap
	 * on its own (verified empirically). This lock makes the second caller's
	 * countActive() wait until the first caller's reservation write has
	 * actually landed, so it observes the up-to-date count.
	 */
	private async withTenantLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.tenantLocks.get(tenantId) ?? Promise.resolve();
		let release!: () => void;
		this.tenantLocks.set(tenantId, new Promise<void>((resolve) => { release = resolve; }));
		await prev;
		try {
			return await fn();
		} finally {
			release();
		}
	}

	async create(opts: CreateOpts): Promise<SessionRecord> {
		const { cfg, keys, index } = this.deps;

		// Reserve the slot FIRST (status: 'starting'), inside the per-tenant lock,
		// so countActive() sees it for any concurrent create() on this tenant —
		// closing the TOCTOU window that existed when the record was only written
		// after the (slow) opencode spawn completed.
		const record = await this.withTenantLock(opts.identity.tenantId, async () => {
			const activeCount = await index.countActive(opts.identity.tenantId);
			if (activeCount >= cfg.maxSessionsPerTenant) {
				throw new HttpError(429, `tenant session limit reached (${cfg.maxSessionsPerTenant})`);
			}
			const sessionId = randomUUID();
			const rec: SessionRecord = {
				sessionId,
				ownerId: opts.identity.ownerId,
				tenantId: opts.identity.tenantId,
				title: opts.title ?? (opts.pipePath ? path.basename(opts.pipePath, '.pipe') : 'New session'),
				pipePath: opts.pipePath ?? '',
				pipesTouched: [],
				status: 'starting',
				createdAt: Date.now(),
				lastActivity: Date.now(),
			};
			await index.put(rec);
			return rec;
		});

		try {
			const providerKeys = await keys.resolve(opts.credential);
			if (!providerKeys.anthropic && !providerKeys.openai) {
				throw new HttpError(412, 'no inference key configured — add an Anthropic or OpenAI API key');
			}
			const sessionRoot = this.sessionRoot(record.sessionId);
			const workspaceDir = path.join(sessionRoot, 'workspace');
			await fsp.mkdir(workspaceDir, { recursive: true });
			if (opts.pipePath) {
				const store = await this.deps.storeFactory(opts.credential);
				try {
					await seedWorkspace({
						workspaceDir,
						pipePath: opts.pipePath,
						store,
						docsDir: cfg.docsDir,
						assetsDir: cfg.assetsDir,
					});
				} finally {
					await store.close();
				}
			} else {
				// A blank-workspace seed still MUST place AGENTS.md + the rr-builder agent + docs;
				// never swallow a failure here — an unseeded workspace silently strips the agent's
				// system prompt and makes `agent: rr-builder` an "agent not found" error downstream.
				// Log loudly (visibility) but don't abort session creation over docs/prompt seeding.
				try {
					await seedWorkspace({
						workspaceDir,
						pipePath: '',
						store: { fsReadString: async () => '', fsWriteString: async () => undefined, close: async () => undefined },
						docsDir: cfg.docsDir,
						assetsDir: cfg.assetsDir,
					});
				} catch (err) {
					log.error(`[session ${record.sessionId}] seedWorkspace failed — AGENTS.md/rr-builder agent NOT seeded (assetsDir=${cfg.assetsDir}, docsDir=${cfg.docsDir}):`, err);
				}
			}
			// Seed docs/COMPONENTS.md — the live, greppable provider catalog. Fixes the agent inventing
			// providers (e.g. `pdf_parser`) because list_components is ~60 KB and gets truncated. Best-effort.
			await this.seedComponentCatalog(workspaceDir, opts.credential).catch((err) => {
				log.error(`[session ${record.sessionId}] component catalog seed failed (agent will fall back to describe_component):`, err);
			});
			await initGit(workspaceDir);
			const live = await this.attach(record, providerKeys, opts.credential, sessionRoot);
			this.watchFileEdits(live);
			record.status = 'active';
			await index.put(record);
			this.auditor.record({
				sessionId: record.sessionId,
				tenantId: record.tenantId,
				userId: record.ownerId,
				kind: 'lifecycle',
				action: 'session.create',
				argsDigest: digestArgs({ pipePath: opts.pipePath, title: opts.title }),
				status: 'ok',
			});
			return record;
		} catch (err) {
			// Release the reservation so a failure doesn't permanently eat into the tenant's
			// session cap. Final-review fix (Important 3): attach() can succeed and THEN a
			// later step throw (e.g. this index.put) — index.remove() alone would leave an
			// orphaned opencode child (and a live-map entry no route can ever reach, since
			// there's no index record to resolve it through) silently running and consuming
			// a real process/port/workspace slot the tenant cap no longer even counts.
			this.killAndEvict(record.sessionId);
			await index.remove(record.sessionId).catch(() => { /* best-effort cleanup */ });
			throw err;
		}
	}

	/** Kills + evicts a live session that attach() started but a later step failed to commit — never leaves an orphaned child process behind. */
	private killAndEvict(id: string): void {
		const live = this.live.get(id);
		if (!live) return;
		live.proc.kill('SIGTERM');
		this.live.delete(id);
	}

	/** Spawn (or re-spawn on resume) the session's opencode server. */
	protected async attach(record: SessionRecord, providerKeys: ProviderKeys, credential: string, sessionRoot: string): Promise<LiveSession> {
		const { cfg } = this.deps;
		const mcpSecret = randomBytes(16).toString('hex');
		const workspaceDir = path.join(sessionRoot, 'workspace');
		const sessionHome = path.join(sessionRoot, 'home');
		const handle = await spawnOpencodeServer(cfg, {
			sessionId: record.sessionId,
			workspaceDir,
			sessionHome,
			mcpProxyUrl: `http://127.0.0.1:${cfg.port}/internal/mcp/${record.sessionId}/${mcpSecret}`,
			providerKeys,
		});
		const live: LiveSession = {
			record,
			...handle,
			mcpSecret,
			latestToken: credential,
			workspaceDir,
			sessionHome,
			events: new EventEmitter(),
			openStreams: 0,
		};
		this.live.set(record.sessionId, live);
		return live;
	}

	sessionRoot(sessionId: string): string {
		return path.join(this.deps.cfg.dataDir, 'sessions', sessionId);
	}

	/** Compact provider catalog markdown — identical for all sessions on a server; refreshed every 10 min. */
	private catalogCache?: { md: string; at: number };

	/**
	 * Seed `docs/COMPONENTS.md` with the server's live provider catalog so the agent greps a real
	 * provider instead of inventing one. Cached across sessions (same server). Best-effort: a stub
	 * store (no `listServices`) or empty catalog just skips the file.
	 */
	private async seedComponentCatalog(workspaceDir: string, credential: string): Promise<void> {
		const TTL_MS = 10 * 60 * 1000;
		let md = this.catalogCache && Date.now() - this.catalogCache.at < TTL_MS ? this.catalogCache.md : '';
		if (!md) {
			const store = await this.deps.storeFactory(credential);
			try {
				const services = await store.listServices?.();
				if (!services || Object.keys(services).length === 0) return;
				md = formatComponentCatalog(services);
				this.catalogCache = { md, at: Date.now() };
			} finally {
				await store.close();
			}
		}
		await fsp.mkdir(path.join(workspaceDir, 'docs'), { recursive: true });
		await fsp.writeFile(path.join(workspaceDir, 'docs', 'COMPONENTS.md'), md, 'utf8');
	}

	/** D3 (index.ts route) delegates here so the `session.revert` lifecycle audit record lives next to every other lifecycle emit point. Operates on the on-disk workspace directly — works even when the session isn't currently live. */
	async revert(id: string, sha: string): Promise<string> {
		const workspaceDir = path.join(this.sessionRoot(id), 'workspace');
		const newSha = await revertTo(workspaceDir, sha);
		const record = await this.deps.index.get(id);
		this.auditor.record({
			sessionId: id,
			tenantId: record?.tenantId ?? '',
			userId: record?.ownerId ?? '',
			kind: 'lifecycle',
			action: 'session.revert',
			argsDigest: digestArgs({ sha }),
			status: 'ok',
		});
		return newSha;
	}

	async destroy(id: string): Promise<void> {
		const live = this.live.get(id);
		if (!live) return;
		live.proc.kill('SIGTERM');
		this.live.delete(id);
	}

	/**
	 * Hard-delete a session: kill any live opencode process, remove the on-disk session
	 * tree (workspace + home + git history), and drop the index record so it disappears
	 * from the owner's list. Unlike {@link archive}, this is irreversible — there is no
	 * transcript left to resume. The filesystem removal is best-effort so a stale or
	 * partially-written session dir can never wedge the delete; the index record is
	 * removed last, since it's the sole thing the owner's list (and every route) resolves
	 * through — a leftover dir with no record is harmless, a record with no dir is not.
	 */
	async purge(id: string): Promise<void> {
		const record = await this.deps.index.get(id);
		this.killAndEvict(id);
		await fsp.rm(this.sessionRoot(id), { recursive: true, force: true }).catch(() => {
			/* best-effort: a missing/partial dir must not block dropping the record */
		});
		await this.deps.index.remove(id);
		if (record) {
			this.auditor.record({
				sessionId: id, tenantId: record.tenantId, userId: record.ownerId,
				kind: 'lifecycle', action: 'session.delete', argsDigest: digestArgs({}), status: 'ok',
			});
		}
	}

	/**
	 * Shutdown hook (final-review Critical 2): archive every still-live session — save-back +
	 * snapshot + free the process — before the pod exits. `strategy: Recreate` kills the
	 * process outright on redeploy; without this, each live session's index record is left
	 * 'active'/'paused_auth' with no process behind it. That orphan then counts toward the
	 * tenant's cap forever (countActive() has no way to know the process is gone), and
	 * neither the reaper's idle sweep (only walks currently-live sessions) nor retention
	 * (only purges ALREADY-archived records) will ever touch it — see reconcileOnBoot() in
	 * reaper.ts for the boot-time half of this fix. Best-effort: one session's save-back
	 * failure (flagged via saveFailed, same as any other archive()) must not block the rest
	 * from archiving during a time-boxed shutdown.
	 */
	async archiveAllLive(): Promise<void> {
		await Promise.allSettled(this.listLive().map((live) => this.archive(live.record.sessionId)));
	}

	/** Refresh the latest-token cache + activity clock; un-pause an auth-paused session. */
	touch(live: LiveSession, credential: string): void {
		live.latestToken = credential;
		live.record.lastActivity = Date.now();
		if (live.record.status === 'paused_auth') {
			live.record.status = 'active';
			live.events.emit('event', { type: 'auth.refreshed' });
			void this.deps.index.put(live.record);
		}
	}

	/** Upstream said the cached token is dead: pause, tell the panel to reconnect. Session survives. */
	pauseForAuth(live: LiveSession): void {
		if (live.record.status === 'paused_auth') return;
		live.record.status = 'paused_auth';
		live.events.emit('event', { type: 'auth.expired', message: 'Sign-in expired — reopen the panel to continue' });
		void this.deps.index.put(live.record);
	}

	pauseForCap(live: LiveSession): void {
		if (live.record.status === 'workspace_full') return;
		live.record.status = 'workspace_full';
		live.events.emit('event', { type: 'workspace_full', capBytes: this.deps.cfg.workspaceCapBytes });
		void this.deps.index.put(live.record);
	}

	/** Save all workspace pipes to the project store with the freshest cached token. */
	async saveBackNow(live: LiveSession): Promise<string[]> {
		const store = await this.deps.storeFactory(live.latestToken);
		try {
			const seededDir = live.record.pipePath.includes('/')
				? live.record.pipePath.slice(0, live.record.pipePath.lastIndexOf('/')) : '';
			const { written, skipped } = await saveBack({ workspaceDir: live.workspaceDir, store, storeDirFor: () => seededDir });
			for (const storePath of written) {
				const rel = storePath.replace(/^\.projects\//, '');
				if (!live.record.pipesTouched.includes(rel)) live.record.pipesTouched.push(rel);
			}
			await this.deps.index.put(live.record);
			if (written.length) live.events.emit('event', { type: 'saved', pipes: written });
			// Visibility: a skipped pipe (invalid JSON) didn't reach the store — tell the panel which,
			// instead of it silently never appearing in the Pipelines bar.
			if (skipped.length) live.events.emit('event', { type: 'save.failed', sessionId: live.record.sessionId, pipes: skipped });
			return written;
		} finally {
			await store.close();
		}
	}

	/**
	 * Archive: save-back + final snapshot + free the process. Workspace + opencode session data
	 * persist for resume. `trigger` (Task 5.2a) only changes the emitted lifecycle audit action —
	 * the reaper's idle sweep passes `'reap'` so an unattended archive is distinguishable in the
	 * audit trail from one the owner (or a shutdown archiveAllLive()) explicitly requested.
	 */
	async archive(id: string, trigger: 'user' | 'reap' = 'user'): Promise<void> {
		const action = trigger === 'reap' ? 'session.reap' : 'session.archive';
		const live = this.live.get(id);
		if (!live) {
			const record = await this.deps.index.get(id);
			if (record && record.status !== 'archived') {
				record.status = 'archived';
				await this.deps.index.put(record);
				this.auditor.record({
					sessionId: record.sessionId, tenantId: record.tenantId, userId: record.ownerId,
					kind: 'lifecycle', action, argsDigest: digestArgs({}), status: 'ok',
				});
			}
			return;
		}
		let saveFailed = false;
		try {
			await this.saveBackNow(live);
		} catch (err) {
			saveFailed = true;
			log.error(`[archive ${id}] save-back failed:`, err);
			// Never marks the session unsaved-data-lost: the workspace (and its untouched
			// pipesTouched list) persists on disk, so a future /save or archive retries it.
			live.events.emit('event', { type: 'save.failed', sessionId: id, pipes: live.record.pipesTouched });
		}
		await commitTurn(live.workspaceDir, 'session archived').catch((err) => log.warn(`[archive ${id}] final commit failed (workspace still persisted on disk):`, (err as Error).message));
		live.proc.kill('SIGTERM');
		live.record.status = 'archived';
		live.record.saveFailed = saveFailed;
		await this.deps.index.put(live.record);
		this.live.delete(id);
		this.auditor.record({
			sessionId: live.record.sessionId, tenantId: live.record.tenantId, userId: live.record.ownerId,
			kind: 'lifecycle', action, argsDigest: digestArgs({}), status: saveFailed ? 'error' : 'ok',
		});
	}

	/** In-flight resume() calls per session id, so a second concurrent caller awaits the first instead of double-spawning. */
	private resumeInFlight = new Map<string, Promise<SessionRecord>>();

	/** Resume: re-spawn opencode over the SAME sessionHome — its on-disk session data rehydrates the transcript. */
	async resume(id: string, identity: Identity, credential: string): Promise<SessionRecord> {
		const existing = this.resumeInFlight.get(id);
		if (existing) return existing;
		const attempt = this.doResume(id, identity, credential).finally(() => this.resumeInFlight.delete(id));
		this.resumeInFlight.set(id, attempt);
		return attempt;
	}

	private async doResume(id: string, identity: Identity, credential: string): Promise<SessionRecord> {
		const record = await this.deps.index.get(id);
		if (!record || record.ownerId !== identity.ownerId) throw new HttpError(404, 'no such session');
		if (this.live.has(id)) return record;
		if ((await this.deps.index.countActive(record.tenantId)) >= this.deps.cfg.maxSessionsPerTenant) {
			throw new HttpError(429, `tenant session limit reached (${this.deps.cfg.maxSessionsPerTenant})`);
		}
		const providerKeys = await this.deps.keys.resolve(credential);
		if (!providerKeys.anthropic && !providerKeys.openai) throw new HttpError(412, 'no inference key configured');
		const live = await this.attach(record, providerKeys, credential, this.sessionRoot(id));
		this.watchFileEdits(live);
		record.status = 'active';
		record.lastActivity = Date.now();
		try {
			await this.deps.index.put(record);
		} catch (err) {
			// Same leak class as create() (Important 3, final-review): attach() already
			// succeeded — an index write failure here must not leave an orphaned child with
			// no index record (and no tenant-cap accounting) behind.
			this.killAndEvict(id);
			throw err;
		}
		this.auditor.record({
			sessionId: record.sessionId, tenantId: record.tenantId, userId: record.ownerId,
			kind: 'lifecycle', action: 'session.resume', argsDigest: digestArgs({}), status: 'ok',
		});
		return record;
	}

	/** Test-only: register a LiveSession against a fake opencode URL without spawning a binary. */
	async attachFake(identity: Identity, credential: string, fakeBaseUrl: string): Promise<string> {
		const sessionId = randomUUID();
		const workspaceDir = path.join(this.sessionRoot(sessionId), 'workspace');
		await fsp.mkdir(workspaceDir, { recursive: true });
		// Real sessions always seed at least AGENTS.md — a genuinely empty tree
		// leaves `git commit` with nothing to commit on the initial `initGit()` call.
		await fsp.writeFile(path.join(workspaceDir, 'AGENTS.md'), '# fake session\n', 'utf8');
		await initGit(workspaceDir);
		const record: SessionRecord = {
			sessionId,
			ownerId: identity.ownerId,
			tenantId: identity.tenantId,
			title: 'fake',
			pipePath: '',
			pipesTouched: [],
			status: 'active',
			createdAt: Date.now(),
			lastActivity: Date.now(),
		};
		this.live.set(sessionId, {
			record,
			proc: { kill: () => true } as unknown as ChildProcess,
			port: 0,
			password: 'fake-password',
			baseUrl: fakeBaseUrl,
			mcpSecret: randomBytes(16).toString('hex'),
			latestToken: credential,
			workspaceDir,
			sessionHome: path.join(this.sessionRoot(sessionId), 'home'),
			events: new EventEmitter(),
			openStreams: 0,
		});
		await this.deps.index.put(record);
		return sessionId;
	}

	/**
	 * Per-turn snapshots: subscribe to the session's opencode SSE stream and commit
	 * on every file-change event.
	 *
	 * VERIFY V2 (confirmed against the pinned opencode binary + @opencode-ai/sdk's
	 * types.gen.d.ts, both v1.18.16): the event NAME is `file.edited` with
	 * `properties.file`, as originally assumed — but the wire ENVELOPE is
	 * `GlobalEvent = { directory, payload: Event }`, one level deeper than the
	 * `{ type, properties }` shape this code previously read at the top level. That
	 * mismatch meant `event.type` was always `undefined` and no per-turn snapshot
	 * ever fired. Confirmed live: a spawned server's first SSE frame is
	 * `{"payload":{"id":"evt_...","type":"server.connected","properties":{}}}`.
	 */
	private watchFileEdits(live: LiveSession): void {
		const url = `${live.baseUrl}/global/event`; // VERIFY V2
		const sessionId = live.record.sessionId;
		// Checked instead of a proc 'exit' listener: some callers (tests, and any future
		// caller) register a LiveSession with a stub `proc` that isn't a real ChildProcess/
		// EventEmitter. `this.live` is the single source of truth for "is this session still
		// current" — archive()/destroy() always remove it (and resume() always replaces it
		// with a new LiveSession instance), so an identity check here is exactly the fresh
		// per-attach guard reconnect needs.
		const stillLive = () => this.live.get(sessionId) === live;
		// Set on each file.edited, cleared after an idle save-back — so we only push to the store when
		// the turn actually changed a file (not on every idle). Persists across stream reconnects.
		let dirty = false;
		const connect = async (): Promise<void> => {
			if (!stillLive()) return;
			try {
				const res = await fetch(url, { headers: { authorization: authHeader(live.password), accept: 'text/event-stream' } });
				if (res.ok && res.body) {
					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					let buf = '';
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						buf += decoder.decode(value, { stream: true });
						let idx: number;
						while ((idx = buf.indexOf('\n\n')) >= 0) {
							const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
							const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
							if (!data) continue;
							try {
								const { payload } = JSON.parse(data) as { payload?: { type: string; properties?: { file?: string } } };
								if (payload?.type === 'file.edited') {
									dirty = true;
									const sha = await commitTurn(live.workspaceDir, `agent edit: ${payload.properties?.file ?? 'unknown'}`);
									if (sha) live.events.emit('event', { type: 'snapshot', sha, file: payload.properties?.file });
								} else if (payload?.type === 'session.idle' && dirty) {
									// Auto-save: the agent finished a turn that changed files — propagate the workspace
									// .pipe files to the RocketRide store (filesystem-sync), so new/edited pipelines show
									// up in the Pipelines bar with no manual "Save to project". saveBackNow emits `saved`
									// (→ bar refresh) and `save.failed` (invalid pipes) itself; this catch is for store errors.
									dirty = false;
									void this.saveBackNow(live).catch((err) => {
										log.error(`[auto-save ${sessionId}]`, err);
										live.events.emit('event', { type: 'save.failed', sessionId, pipes: live.record.pipesTouched });
									});
								}
							} catch { /* non-JSON frame */ }
						}
					}
				}
			} catch { /* connect/read failed — fall through to the reconnect check below */ }
			// The event stream IS the per-turn snapshot audit trail — a dropped connection
			// (network blip, opencode hiccup) must not silently end it while the session lives.
			if (!stillLive()) return;
			const retry = setTimeout(() => void connect(), 1000);
			retry.unref();
		};
		void connect();
	}
}
