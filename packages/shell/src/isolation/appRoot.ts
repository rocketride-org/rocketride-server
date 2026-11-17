// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// APP ROOT — the shell side of every isolated app frame (PR2a-1)
// =============================================================================
//
// One root per shell. `attach` gives each frame (realm) its own handler bus,
// ledger, rate limiter and outbound backstop on a gated router; the realm can
// resolve exactly these ops and nothing else:
//
//   client.request, client.addMonitor, client.removeMonitor,
//   shell.frameToken.refresh, shell.notify, shell.statusMessage,
//   shell.loginRequest, shell.openExternal, bus.topic.read (router),
//   and the emitOps shell.prefs.attach, shell.setPref.
//
// Engine credentials stay here: a run is known to the app by an `rh_` handle
// and an `rp_` project alias, and the real `tk_`/`pk_`/project id are
// substituted on the way to the engine only. `shell.event.*` is the only
// connection state an app sees, as allowlisted payloads.
//
// INERT in PR2a-1: nothing outside `src/isolation/` imports this module
// (T30 guards it) until PR2b wires it in `Shell.tsx`.
// =============================================================================

import type { DAPMessage } from 'rocketride';
import { encodeMessageData } from '../connection/binaryWire';
import { serializeError } from '../connection/errorWire';
import type { IWireEnvelope } from '../connection/errorWire';
import { createGatedBusRouter } from '../ops/busBridge';
import type { IBusEndpoint } from '../ops/busBridge';
import { createOpBus } from '../ops/busOps';
import type { IOpBus } from '../ops/busOps';
import { appKeyOf, isCanonicalAppId } from './appKey';
import { KNOWN_CAPS } from './capabilities';
import { CapabilityDeniedError } from './capabilityDenied';
import type { DenyCode } from './capabilityDenied';
import { deniedEnvelope, deniedMessage, deny, sanitizeEnvelope } from './denial';
import { admitValue, asDenial, DAP_TIMEOUT_MAX_MS, directMonitorKey, gateClientRequest, gateOp } from './gate';
import type { IGateContext, IGatedRequest } from './gate';
import { base64url, createLedger } from './ledger';
import type { ILedger, IRunEntry } from './ledger';
import { createRateLimiter, QUOTAS, SIZES } from './rate';
import type { IAppRoot, IAppRootCm, IAppRootOptions, IRealmGrant, IsolatedEntry, RealmId, RealmInfo } from './types';
import { isWireBinary, measure } from './walk';

/** The outbound backstop's credential pattern (Appendix L). */
const BACKSTOP_RE = /(?:tk|pk)_[A-Za-z0-9_-]{16,}/;
/** Later lookups of a lost run (ms): after the engine's own queueing, before teardown. */
const LOST_RUN_RETRY_MS = [30_000, 150_000];
/** Root-internal frame refresh retries (ms). */
const REFRESH_RETRY_MS = [2000, 4000, 8000];
/** `/apps/frame` answers that end the session instead of being retried. */
const REFRESH_FINAL_STATUS: ReadonlySet<number> = new Set([401, 404, 409]);

/** One attached realm. */
interface IRealmState {
	info: RealmInfo;
	ledger: ILedger;
	gate: IGateContext;
	inflight: number;
	/** Pref keys this realm's app has written (shared by its realms, kept across reattach). */
	prefKeys: Set<string>;
	/** Ops whose drop was already logged (once per realm per op). */
	loggedDrops: Set<string>;
	/** Set by detach: late answers are ended, not recorded. */
	detached: boolean;
	detachRouter: () => void;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Calls `cb` for every string (values and keys), skipping exact binary members only. Throws what `cb` throws. */
function scanStrings(value: unknown, cb: (s: string) => void): void {
	const seen = new Set<object>();
	const stack: unknown[] = [value];
	while (stack.length > 0) {
		const v = stack.pop();
		if (typeof v === 'string') cb(v);
		else if (typeof v === 'object' && v !== null && !seen.has(v) && !isWireBinary(v) && !ArrayBuffer.isView(v)) {
			seen.add(v);
			if (Array.isArray(v)) stack.push(...v);
			else
				for (const [k, x] of Object.entries(v)) {
					cb(k);
					stack.push(x);
				}
		}
	}
}

/** A hostname without trailing dots (`example.com.` and `example.com` are one host). */
const dotless = (host: string): string => host.toLowerCase().replace(/\.+$/, '');

/** A URL's origin with its hostname dotless. */
function dotlessOrigin(url: URL): string {
	return `${url.protocol}//${dotless(url.hostname)}${url.port !== '' ? `:${url.port}` : ''}`;
}

/** `.apps.example.com` for `https://{label}.apps.example.com`. */
function appSuffixOf(template: string): string {
	try {
		const host = dotless(new URL(template.replace('{label}', 'x')).hostname);
		return host.slice(1);
	} catch {
		return '';
	}
}

/**
 * Creates the app root.
 *
 * @param cm - The slice of the ConnectionManager the root uses.
 * @param opts - Clock, randomness, frame fetch, UI hooks and log.
 * @returns The root.
 */
export function createAppRoot(cm: IAppRootCm, opts: IAppRootOptions): IAppRoot {
	const router = createGatedBusRouter(createOpBus(), { retained: cm.retained() });
	const realms = new Map<RealmId, IRealmState>();
	const appSuffix = appSuffixOf(opts.originTemplate);
	const shellOrigins = new Set<string>();
	for (const o of opts.shellOrigins) {
		try {
			shellOrigins.add(dotlessOrigin(new URL(o)));
		} catch {
			/* an unparsable origin matches nothing */
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const client = (): any => {
		const c = cm.getClient();
		if (!c || !cm.isConnected()) throw new Error('Not connected to server');
		return c;
	};

	/** Pref keys written per app, for the 256-key cap (outlives any one realm). */
	const prefKeysByApp = new Map<string, Set<string>>();

	/** Teardowns in progress: every realm request is refused meanwhile. */
	let closing = 0;
	/** Bumped by teardown and logout: an answer to a request started earlier is ended, not recorded. */
	let epoch = 0;

	/**
	 * Root work still running for realms: engine calls of client.request and
	 * the ending of what late or unrecorded answers started. teardownAll waits
	 * for it (within its timeout) so a late run is ended before it resolves.
	 */
	const background = new Set<Promise<unknown>>();
	const track = <T>(p: Promise<T>): Promise<T> => {
		background.add(p);
		const forget = (): void => void background.delete(p);
		p.then(forget, forget);
		return p;
	};

	/** One DAP request on the root's own behalf (teardown, recovery). */
	const sendEngine = (command: string, args: Record<string, unknown>, timeout = DAP_TIMEOUT_MAX_MS): Promise<DAPMessage> => Promise.resolve().then(() => client().request({ type: 'request', seq: 0, command, arguments: args } as DAPMessage, timeout) as Promise<DAPMessage>);

	/** Best-effort end of what an answer started when it cannot be recorded (late, detached, or a record failure). */
	const endOrphan = (req: IGatedRequest, response: DAPMessage): void => {
		const body = isPlainObject(response) && response.success !== false && isPlainObject(response.body) ? response.body : undefined;
		if (!body) return;
		if ((req.command === 'execute' || req.command === 'restart') && typeof body.token === 'string') {
			track(sendEngine('terminate', { token: body.token }).catch(() => opts.log('warn', '[isolation] could not end an unrecorded run')));
		}
		if (req.command === 'rrext_store' && req.subcommand === 'fs_open' && typeof body.handle === 'string') {
			track(sendEngine('rrext_store', { subcommand: 'fs_close', handle: body.handle, mode: req.fs!.mode }).catch(() => undefined));
		}
	};

	/**
	 * An execute whose answer was lost (the engine call threw, e.g. a timeout):
	 * the run may exist anyway, so look it up by its minted project and end it.
	 */
	/**
	 * Looks a lost run up by (minted project, source) and ends it. Resolves
	 * true once it is found and terminated (it then leaves the lost set).
	 */
	const endLostRun = (ledger: ILedger, project: string, source: string): Promise<boolean> =>
		sendEngine('rrext_get_token', { projectId: project, source })
			.then(async (r) => {
				const token = isPlainObject(r) && r.success !== false && isPlainObject(r.body) ? r.body.token : undefined;
				if (typeof token !== 'string') return false;
				await sendEngine('terminate', { token });
				ledger.lostRuns.delete(project);
				return true;
			})
			.catch(() => false);
	const recoverLostRun = (st: IRealmState, req: IGatedRequest): void => {
		if (req.command !== 'execute' || !req.mintedProject) return;
		const pipeline = req.args.pipeline as Record<string, unknown>;
		const source = String(req.args.source ?? pipeline.source);
		const project = req.mintedProject;
		// Remembered (and counted as a run) until found: the engine may still
		// start it after its own DAP timeout. Teardown and detach look again,
		// and so do two later retries.
		st.ledger.lostRuns.set(project, source);
		const ledger = st.ledger;
		const attempt = (retriesLeft: number[]): void => {
			track(endLostRun(ledger, project, source)).then((found) => {
				if (found || retriesLeft.length === 0 || !ledger.lostRuns.has(project)) return;
				const [delay, ...rest] = retriesLeft;
				const timer = setTimeout(() => attempt(rest), delay);
				(timer as { unref?: () => void }).unref?.();
			});
		};
		attempt([...LOST_RUN_RETRY_MS]);
	};

	/** Starts ending one realm's runs, store handles and monitors; returns the work. */
	const teardownRealm = (st: IRealmState, tally: { failed: number }): Promise<unknown>[] => {
		const work: Promise<unknown>[] = [];
		for (const run of st.ledger.runs()) {
			work.push(
				sendEngine('terminate', { token: run.token }).then(
					(r) => {
						if (r?.success === false) tally.failed++;
					},
					() => {
						tally.failed++;
					}
				)
			);
			const counts = st.ledger.monitors.get(run.handle);
			if (counts) {
				const left = new Map(counts);
				while (left.size > 0) {
					const types = [...left.keys()];
					work.push(
						Promise.resolve()
							.then(() => client().removeMonitor({ token: run.token }, types))
							.catch(() => undefined)
					);
					for (const t of types) {
						const n = left.get(t)! - 1;
						if (n > 0) left.set(t, n);
						else left.delete(t);
					}
				}
			}
		}
		for (const [project, source] of st.ledger.lostRuns) work.push(endLostRun(st.ledger, project, source));
		for (const d of st.ledger.directMonitors.values()) {
			const run = st.ledger.run(d.handle);
			if (run && d.types.length > 0) work.push(sendEngine('rrext_monitor', { token: run.token, types: [], ...(d.pipeId !== undefined ? { pipeId: d.pipeId } : {}) }).catch(() => undefined));
		}
		for (const fs of st.ledger.fsHandles()) work.push(sendEngine('rrext_store', { subcommand: 'fs_close', handle: fs.handle, mode: fs.mode }).catch(() => undefined));
		return work;
	};

	/** A denied request op: the bus rejects with `RR_DENIED:` + fields. */
	const rejectWith = (err: unknown, op: string): never => {
		throw new Error(deniedMessage(asDenial(err, op)));
	};

	const logDrop = (st: IRealmState, op: string, code: DenyCode): void => {
		if (st.loggedDrops.has(op)) return;
		st.loggedDrops.add(op);
		opts.log('warn', `[isolation] ${st.info.appId} (${st.info.realmId}): dropped ${op} (${code})`);
	};

	// ── Command handling inside client.request (plan section 4.2) ──────────

	/** A response body with the run's opaque values in place of the real ones. */
	const runBody = (body: Record<string, unknown>, run: IRunEntry): Record<string, unknown> => {
		const { publicToken: _dropped, ...rest } = body;
		void _dropped;
		return { ...rest, token: run.handle, projectId: run.projectAlias, id: run.taskIdAlias };
	};

	/** Records what the engine answered and rewrites what the realm may see. */
	const record = (st: IRealmState, req: IGatedRequest, response: DAPMessage): DAPMessage => {
		if (opts.__throwIn === 'ledger') throw new Error('test hook: ledger');
		if (!isPlainObject(response) || response.success === false) return response;
		const body = isPlainObject(response.body) ? response.body : undefined;
		const withBody = (next: Record<string, unknown>): DAPMessage => ({ ...response, body: next });
		switch (req.command) {
			case 'execute': {
				if (!body || typeof body.token !== 'string') return response;
				const pipeline = req.args.pipeline as Record<string, unknown>;
				const run = st.ledger.addRun({
					token: body.token,
					publicToken: typeof body.publicToken === 'string' ? body.publicToken : '',
					projectId: typeof body.projectId === 'string' ? body.projectId : req.mintedProject!,
					source: String(body.source ?? req.args.source ?? pipeline.source ?? ''),
					taskId: typeof body.id === 'string' ? body.id : '',
				});
				return withBody(runBody(body, run));
			}
			case 'restart': {
				const run = req.run!;
				run.completedAt = undefined;
				if (!body) return response;
				if (typeof body.token === 'string') run.token = body.token;
				if (typeof body.publicToken === 'string') run.publicToken = body.publicToken;
				if (typeof body.id === 'string') run.taskId = body.id;
				return withBody(runBody(body, run));
			}
			case 'rrext_get_token': {
				if (!body) return response;
				const { token, publicToken: _public, ...rest } = body;
				void _public;
				const run = typeof token === 'string' ? st.ledger.runByToken(token) : undefined;
				return withBody(run ? { ...rest, token: run.handle } : rest);
			}
			case 'terminate':
				st.ledger.dropRun(req.run!.handle);
				return response;
			case 'rrext_get_task_status':
				if (body && (body.completed === true || body.final === true)) st.ledger.complete(req.run!.handle);
				return response;
			case 'rrext_monitor': {
				// A run that ended during the call keeps no subscription record (DA N1).
				if (st.ledger.run(req.run!.handle) !== req.run) return response;
				const pipeId = req.args.pipeId as number | undefined;
				const k = directMonitorKey(req.run!.handle, pipeId);
				const types = [...new Set(req.args.types as string[])];
				if (types.length === 0) st.ledger.directMonitors.delete(k);
				else st.ledger.directMonitors.set(k, { handle: req.run!.handle, ...(pipeId !== undefined ? { pipeId } : {}), types });
				return response;
			}
			case 'rrext_process':
				if (req.subcommand === 'open' && body && Number.isSafeInteger(body.pipe_id)) req.run!.pipeIds.add(body.pipe_id as number);
				if (req.subcommand === 'close') req.run!.pipeIds.delete(req.args.pipe_id as number);
				return response;
			case 'rrext_store':
				if (req.subcommand === 'fs_open' && body && typeof body.handle === 'string') st.ledger.addFs(body.handle, req.fs!.mode);
				if (req.subcommand === 'fs_close') st.ledger.dropFs(req.args.handle as string);
				return response;
			default:
				return response;
		}
	};

	// ── Outbound backstop (the scrubber is PR2a-2) ──────────────────────────

	const outboundFor =
		(st: IRealmState) =>
		(message: unknown): unknown => {
			if (opts.__throwIn === 'outbound') throw new Error('test hook: outbound');
			const needles = [cm.loadToken(), ...st.ledger.secrets()].filter((s) => typeof s === 'string' && s.length >= 8);
			// The pattern is not applied to the app's own file content (plan section 4.4); exact matches still are.
			const m = message as { __rrbus?: string; result?: { ok?: boolean; value?: { command?: string } } };
			const storeReply = m?.__rrbus === 'response' && m.result?.ok === true && m.result.value?.command === 'rrext_store';
			scanStrings(message, (s) => {
				for (const needle of needles) if (s.includes(needle)) throw deny('credential', 'outbound');
				if (!storeReply && BACKSTOP_RE.test(s)) throw deny('credential', 'outbound');
			});
			return message;
		};

	// ── Per-realm handlers ──────────────────────────────────────────────────

	const fetchFrame = async (appId: string, version: number): Promise<{ entryPrefix: string; expiresAt: number }> => {
		for (let attempt = 0; ; attempt++) {
			try {
				const frame = await opts.fetchFrame(appId, version);
				return { entryPrefix: frame.entryPrefix, expiresAt: frame.expiresAt };
			} catch (err) {
				const status = (err as { status?: unknown } | null)?.status;
				if (typeof status === 'number' && REFRESH_FINAL_STATUS.has(status)) throw new Error('Session ended');
				if (attempt >= REFRESH_RETRY_MS.length) throw new Error('Frame refresh failed');
				await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_MS[attempt]));
			}
		}
	};

	const checkOpenUrl = (raw: string): string | null => {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			return null;
		}
		if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
		// Trailing dots are stripped first: `shell.example.com.` is the shell.
		const host = dotless(url.hostname);
		if (host === '' || shellOrigins.has(dotlessOrigin(url))) return null;
		if (appSuffix !== '' && (host.endsWith(appSuffix) || host === appSuffix.slice(1))) return null;
		return url.href;
	};

	const buildHandlers = (st: IRealmState): IOpBus => {
		const bus = createOpBus();
		const op = (name: string, impl: (raw: unknown) => Promise<unknown>, onRefuse: (err: unknown) => unknown): void => {
			bus.handle(name, async (raw) => {
				if (closing > 0 || st.detached) return onRefuse(deny('capability', name));
				if (st.inflight >= QUOTAS.inflight) return onRefuse(deny('rate', name));
				st.inflight++;
				try {
					return await impl(raw);
				} finally {
					st.inflight--;
				}
			});
		};
		const requestOp = (name: string, impl: (params: Record<string, unknown>, run?: IRunEntry) => unknown): void =>
			op(
				name,
				async (raw) => {
					let checked: ReturnType<typeof gateOp>;
					try {
						checked = gateOp(st.gate, name, raw);
					} catch (err) {
						return rejectWith(err, name);
					}
					return impl(checked.params, checked.run);
				},
				(err) => rejectWith(err, name)
			);
		const emitOp = (name: string, impl: (params: Record<string, unknown>) => void): void => {
			bus.handle(name, (raw) => {
				try {
					impl(gateOp(st.gate, name, raw).params);
				} catch (err) {
					logDrop(st, name, asDenial(err, name).code);
				}
			});
		};

		op(
			'client.request',
			async (raw) => {
				let req: IGatedRequest;
				try {
					req = gateClientRequest(st.gate, raw);
				} catch (err) {
					return deniedEnvelope(asDenial(err, 'client.request'));
				}
				const startedIn = epoch;
				try {
					let response: DAPMessage;
					try {
						response = (await track(Promise.resolve().then(() => client().request(req.message, req.timeout)))) as DAPMessage;
					} catch (err) {
						recoverLostRun(st, req);
						throw err;
					}
					// Teardown, logout or detach happened meanwhile: end what the answer started.
					if (st.detached || epoch !== startedIn) {
						endOrphan(req, response);
						throw deny('capability', 'client.request', { command: req.command });
					}
					let recorded: DAPMessage;
					try {
						recorded = record(st, req, response);
					} catch (err) {
						endOrphan(req, response);
						throw err;
					}
					const encoded = encodeMessageData(recorded);
					const size = measure(encoded);
					if (size.json + size.bin > SIZES.response) throw deny('too_large', 'client.request', { command: req.command });
					return { ok: true, value: encoded } satisfies IWireEnvelope;
				} catch (err) {
					if (err instanceof CapabilityDeniedError) return deniedEnvelope(err);
					return sanitizeEnvelope({ ok: false, error: serializeError(err) });
				} finally {
					req.release();
				}
			},
			(err) => deniedEnvelope(asDenial(err, 'client.request'))
		);

		requestOp('client.addMonitor', async (params, run) => {
			const types = [...new Set(params.types as string[])];
			const counts = st.ledger.monitors.get(run!.handle) ?? new Map<string, number>();
			const added = types.filter((t) => !counts.has(t)).length;
			if (st.ledger.used('monitorKeys') + added > QUOTAS.monitorKeys) rejectWith(deny('quota', 'client.addMonitor'), 'client.addMonitor');
			const release = st.ledger.reserve('monitorKeys', added);
			const startedIn = epoch;
			try {
				await client().addMonitor({ token: run!.token }, types);
				// The run may have ended (terminate, teardown, logout, detach) during the call:
				// then nothing is recorded, so no slot is held for a dead run.
				if (st.detached || epoch !== startedIn || st.ledger.run(run!.handle) !== run) {
					track(
						Promise.resolve()
							.then(() => client().removeMonitor({ token: run!.token }, types))
							.catch(() => undefined)
					);
					return;
				}
				const current = st.ledger.monitors.get(run!.handle) ?? counts;
				for (const t of types) current.set(t, (current.get(t) ?? 0) + 1);
				st.ledger.monitors.set(run!.handle, current);
			} finally {
				release();
			}
		});

		requestOp('client.removeMonitor', async (params, run) => {
			const types = [...new Set(params.types as string[])];
			await client().removeMonitor({ token: run!.token }, types);
			const counts = st.ledger.monitors.get(run!.handle);
			if (!counts) return;
			for (const t of types) {
				const n = (counts.get(t) ?? 0) - 1;
				if (n > 0) counts.set(t, n);
				else counts.delete(t);
			}
			if (counts.size === 0) st.ledger.monitors.delete(run!.handle);
		});

		requestOp('shell.frameToken.refresh', () => fetchFrame(st.info.appId, st.info.version));

		requestOp('shell.notify', (params) => {
			const text = params.message as string;
			if (text.length > SIZES.notify) rejectWith(deny('schema', 'shell.notify'), 'shell.notify');
			opts.ui.strip(st.info.realmId, { kind: 'notify', text });
		});

		requestOp('shell.statusMessage', (params) => {
			const text = params.message as string;
			if (text.length > SIZES.status) rejectWith(deny('schema', 'shell.statusMessage'), 'shell.statusMessage');
			opts.ui.strip(st.info.realmId, { kind: 'status', text });
		});

		requestOp('shell.loginRequest', () => {
			// Signed in = the root holds a session token.
			if (cm.loadToken() !== '') rejectWith(deny('capability', 'shell.loginRequest'), 'shell.loginRequest');
			cm.emit('shell:loginRequest', { appId: st.info.appId });
		});

		requestOp('shell.openExternal', async (params) => {
			const url = checkOpenUrl(params.url as string);
			if (url === null) return rejectWith(deny('schema', 'shell.openExternal'), 'shell.openExternal');
			if ((await opts.ui.confirmOpen(st.info.realmId, url)) === true) opts.openWindow(url, '_blank', 'noopener,noreferrer');
		});

		emitOp('shell.prefs.attach', (params) => {
			cm.ops().emitOp('shell.prefs.attach', { partition: params.partition });
		});

		emitOp('shell.setPref', (params) => {
			const key = params.key as string;
			if (key === '' || key.length > SIZES.prefKey) throw deny('schema', 'shell.setPref');
			const size = measure(params.value);
			if (size.json + size.bin > SIZES.prefValue) throw deny('too_large', 'shell.setPref');
			if (!st.prefKeys.has(key) && st.prefKeys.size >= SIZES.prefKeys) throw deny('quota', 'shell.setPref');
			st.prefKeys.add(key);
			// A plain (not null-prototype) copy for the prefs store.
			cm.ops().emitOp('shell.setPref', { partition: params.partition, key, value: JSON.parse(JSON.stringify(params.value)) });
		});

		return bus;
	};

	// ── shell.event.* (plan section 4.8): allowlisted payloads only ─────────

	const deliverAll = (op: string, payload: unknown, only?: (st: IRealmState) => boolean): void => {
		for (const st of realms.values()) if (!only || only(st)) router.deliver(st.info.realmId, op, payload);
	};
	cm.on('shell:connected', () => deliverAll('shell.event.connected', {}));
	// The root's own reason is not forwarded.
	cm.on('shell:disconnected', () => deliverAll('shell.event.disconnected', { reason: 'root disconnected', hasError: false }));
	cm.on('shell:statusChange', (status: unknown) => {
		const s = isPlainObject(status) ? status : {};
		const out: Record<string, unknown> = {};
		for (const key of ['state', 'connectionMode', 'authPhase']) {
			if (typeof s[key] === 'string' || typeof s[key] === 'number') out[key] = s[key];
		}
		deliverAll('shell.event.statusChange', out);
	});
	cm.on('shell:themeChange', (payload: unknown) => {
		const raw = isPlainObject(payload) && isPlainObject(payload.tokens) ? payload.tokens : {};
		const tokens: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') tokens[k] = v;
		deliverAll('shell.event.themeChange', { tokens });
	});
	cm.on('shell:viewActivated', (payload: unknown) => {
		const viewId = isPlainObject(payload) ? payload.viewId : undefined;
		if (typeof viewId !== 'string') return;
		deliverAll('shell.event.viewActivated', { viewId }, (st) => st.info.viewId === viewId);
	});
	// A logout that bypassed teardownAll: the token is already gone, so only the ledgers are cleared.
	cm.on('shell:logout', () => {
		epoch++;
		for (const st of realms.values()) st.ledger.clear();
	});

	return {
		attach(entry: IsolatedEntry, endpoint: IBusEndpoint, grant: IRealmGrant = {}): RealmId {
			if (!entry || entry.isolated !== true || entry.firstParty === true || !isCanonicalAppId(entry.id)) {
				throw new Error('appRoot.attach: only an isolated, third-party entry can be attached');
			}
			const realmId = `realm-${base64url(opts.random(12))}`;
			const caps = new Set(['core', ...(grant.capabilities ?? []).filter((c) => KNOWN_CAPS.has(c))]);
			const info: RealmInfo = {
				realmId,
				label: `${entry.id}#${realmId}`,
				appId: entry.id,
				appKey: appKeyOf(entry.id),
				moduleId: entry.moduleId,
				viewId: grant.viewId ?? '',
				version: grant.version ?? entry.registryVersion ?? 1,
				caps,
			};
			const ledger = createLedger({ now: opts.now, random: opts.random });
			const st: IRealmState = {
				info,
				ledger,
				gate: { info, ledger, rate: createRateLimiter(opts.now), sessionToken: () => cm.loadToken(), random: opts.random, ...(opts.__throwIn ? { throwIn: opts.__throwIn } : {}) },
				inflight: 0,
				prefKeys: prefKeysByApp.get(entry.id) ?? prefKeysByApp.set(entry.id, new Set()).get(entry.id)!,
				loggedDrops: new Set(),
				detached: false,
				detachRouter: () => {},
			};
			st.detachRouter = router.addGatedRealm(endpoint, {
				info,
				handlers: buildHandlers(st),
				outbound: outboundFor(st),
				admit: (lane, value) => {
					if (closing > 0) throw deny('capability', lane);
					return admitValue(st.gate, lane, value);
				},
			});
			realms.set(realmId, st);
			return realmId;
		},

		detach(realmId: RealmId): void {
			const st = realms.get(realmId);
			if (!st) return;
			realms.delete(realmId);
			st.detached = true;
			st.detachRouter();
			// Best effort: the frame is gone, so nothing waits for this.
			const tally = { failed: 0 };
			void Promise.allSettled(teardownRealm(st, tally)).then(() => {
				if (tally.failed > 0) opts.log('warn', `[isolation] detach: ${tally.failed} terminate request(s) failed`);
			});
			st.ledger.clear();
		},

		async teardownAll(timeoutMs: number): Promise<void> {
			// New requests are refused while this runs, and answers to requests
			// started before it are terminated instead of recorded (epoch).
			closing++;
			epoch++;
			try {
				const tally = { failed: 0 };
				const work: Promise<unknown>[] = [];
				for (const st of realms.values()) work.push(...teardownRealm(st, tally));
				// Then the root's own background work: engine calls started before the
				// teardown, and the ending of what their late answers started (DA N3).
				const drain = async (): Promise<boolean> => {
					await Promise.allSettled(work);
					while (background.size > 0) await Promise.allSettled([...background]);
					return false;
				};
				let timer: ReturnType<typeof setTimeout> | undefined;
				const timedOut = await Promise.race([drain(), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), timeoutMs)))]);
				if (timer !== undefined) clearTimeout(timer);
				if (tally.failed > 0 || timedOut) opts.log('warn', `[isolation] teardown: ${tally.failed} terminate request(s) failed${timedOut ? '; timed out' : ''}`);
				for (const st of realms.values()) st.ledger.clear();
			} finally {
				closing--;
			}
		},
	};
}
