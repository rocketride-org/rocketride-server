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
// N1 (PR2a-2): every response, engine event and error text is scrubbed for
// the realm it goes to (scrub.ts): aliases for project and task ids, the
// grant's user alias, no team or run-kind fields, and a backstop. Engine
// events reach a gated realm only for runs it owns, only while attached.
// Inbound strings holding a credential or a real id are refused (N1-f).
//
// INERT in PR2a-1/PR2a-2: nothing outside `src/isolation/` imports this
// module (T30 guards it) until PR2b wires it in `Shell.tsx`.
// =============================================================================

import type { DAPMessage } from 'rocketride';
import { encodeMessageData } from '../connection/binaryWire';
import { serializeError } from '../connection/errorWire';
import type { IWireEnvelope } from '../connection/errorWire';
import { createGatedBusRouter } from '../ops/busBridge';
import type { IBusEndpoint } from '../ops/busBridge';
import { createOpBus } from '../ops/busOps';
import type { IOpBus } from '../ops/busOps';
import { createBoundedSet, createIdentityIds, createKnownProjects, isEngineShaped, isHighEntropy } from './aliases';
import type { IdentityKind } from './aliases';
import { appKeyOf, isCanonicalAppId } from './appKey';
import { KNOWN_CAPS } from './capabilities';
import { CapabilityDeniedError } from './capabilityDenied';
import type { DenyCode } from './capabilityDenied';
import { deniedEnvelope, deniedMessage, deny, sanitizeEnvelope } from './denial';
import { admitValue, asDenial, DAP_TIMEOUT_MAX_MS, directMonitorKey, gateClientRequest, gateOp } from './gate';
import type { IGateContext, IGatedRequest } from './gate';
import { base64url, createLedger, mintProjectAlias } from './ledger';
import type { ILedger, IRunEntry } from './ledger';
import { createRateLimiter, QUOTAS, SIZES } from './rate';
import { createScrubRoot, REDACTED, scrubErrorText, scrubEvent, scrubOutbound, scrubResponse } from './scrub';
import type { IScrubContext } from './scrub';
import type { IAppRoot, IAppRootCm, IAppRootOptions, IRealmGrant, IsolatedEntry, RealmId, RealmInfo } from './types';
import { measure } from './walk';

/** The shortest exact value the root remembers (shorter values would match ordinary text). */
const NEEDLE_MIN = 8;
/** Longest wait of the first client.request for the host.apiKey answer (DA F9), ms. */
const API_KEY_WAIT_MS = 3000;
/** Events buffered per execute still waiting on its answer (DA F8). */
const PENDING_EVENTS_MAX = 64;
/** A real task id (`<hash8>.<source>`, `task_server.py:1540`): only that shape of a status event's `id` is remembered. */
const TASK_ID_RE = /^[0-9a-f]{8}\.\S{1,128}$/;
/** The engine's status update, whose `id` is a real task id (`task_engine.py:1841`). */
const STATUS_EVENT = 'apaevt_status_update';
/** The guest op engine events are delivered on (`clientOps.ts` CLIENT_EVENT_OP; a literal, as in busBridge.ts). */
const CLIENT_EVENT_OP = 'client.event';
/** Later lookups of a lost run (ms after the previous one): at 30 s and 150 s. After the last one answers TASK_NOT_REGISTERED the run stops counting. */
const LOST_RUN_RETRY_MS = [30_000, 120_000];
/** The engine's code for a project/source with no live run (`TaskError.NOT_REGISTERED`, `modules/task/types.py`). */
const TASK_NOT_REGISTERED = 'TASK_NOT_REGISTERED';
/** Failures raised before the request reaches the socket (`client()` here, `DAPClient.request` in the SDK): nothing was sent, so nothing can be lost. */
const NOT_SENT_ERRORS: ReadonlySet<string> = new Set(['Not connected to server', 'Server is not connected']);
/** Root-internal frame refresh retries (ms). */
const REFRESH_RETRY_MS = [2000, 4000, 8000];
/** `/apps/frame` answers that end the session instead of being retried. */
const REFRESH_FINAL_STATUS: ReadonlySet<number> = new Set([401, 404, 409]);

/** One attached realm. */
interface IRealmState {
	info: RealmInfo;
	ledger: ILedger;
	gate: IGateContext;
	/** What the scrubber reads for this realm (N1). */
	scrub: IScrubContext;
	/** Executes waiting on their answer: minted project → events that arrived first (DA F8). */
	pending: Map<string, DAPMessage[]>;
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

	// ── N1 state (plan sections 2 and 4.4), root-wide, cleared at logout ────
	/** Foreign project ids, from the root's own engine-event stream only (security M1). */
	const known = createKnownProjects();
	/** Every token and real task id the root saw (bounded): exact-match backstop and N1-f. */
	const seen = createBoundedSet();
	/** Real high-entropy user, team and org ids, from the SDK account info only: replaced in free text (DA F1, security N1). */
	const identities = createIdentityIds();
	/** The shell API keys (fetched at attach and on shell:login). */
	const apiKeys = new Set<string>();
	/** Engine events no attached realm owns (test counter). */
	let eventsDropped = 0;
	/** Root-made envelopes and event params already scrubbed: the choke point passes or refuses them without a second scan. */
	const verdicts = new WeakMap<object, 'ok' | 'deny'>();
	/** Settles when the latest host.apiKey answer arrived (or after API_KEY_WAIT_MS); null when none is pending. */
	let apiKeyReady: Promise<void> | null = null;

	const remember = (...values: unknown[]): void => {
		for (const v of values) if (typeof v === 'string' && v.length >= NEEDLE_MIN) seen.add(v);
	};
	/** The client's own key, read live (the SDK accessor, `client.ts:3420`). */
	const clientApiKey = (): string | undefined => {
		try {
			const key = (cm.getClient() as { getApiKey?: () => unknown } | null | undefined)?.getApiKey?.();
			return typeof key === 'string' ? key : undefined;
		} catch {
			return undefined;
		}
	};
	const addApiKey = (key: unknown): void => {
		if (typeof key === 'string' && key.length >= NEEDLE_MIN) apiKeys.add(key);
	};
	/** Fetches the API key from both sources: `getClient().getApiKey()` and `host.apiKey` (`hostOps.ts:122`). */
	const refreshApiKeys = (): void => {
		addApiKey(clientApiKey());
		// A logout or teardown bumps the epoch: an answer from the session before it must not re-add that session's key.
		const askedIn = epoch;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const answered = Promise.resolve()
			.then(() => cm.ops().request('host.apiKey', {}))
			.then(
				(answer) => {
					if (epoch === askedIn) addApiKey(isPlainObject(answer) ? answer.apiKey : undefined);
				},
				() => undefined
			);
		const waited = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, API_KEY_WAIT_MS);
			(timer as { unref?: () => void }).unref?.();
		});
		const ready: Promise<void> = Promise.race([answered, waited]).then(() => {
			clearTimeout(timer);
			if (apiKeyReady === ready) apiKeyReady = null;
		});
		apiKeyReady = ready;
	};
	/** The account's own ids (`ConnectResult`: userId, devTeam, organization.id and its teams), read live. */
	const accountIds = (): Array<[unknown, IdentityKind]> => {
		try {
			const info = (cm.getClient() as { getAccountInfo?: () => unknown } | null | undefined)?.getAccountInfo?.() as { userId?: unknown; devTeam?: unknown; organization?: { id?: unknown; teams?: Array<{ id?: unknown }> } | null } | undefined;
			if (!info) return [];
			const out: Array<[unknown, IdentityKind]> = [
				[info.userId, 'user'],
				[info.devTeam, 'team'],
				[info.organization?.id, 'org'],
			];
			for (const team of Array.isArray(info.organization?.teams) ? info.organization.teams : []) out.push([team?.id, 'team']);
			return out;
		} catch {
			return [];
		}
	};
	/** Whether any attached realm's ledger holds this project id as its own run's. */
	const ownedByAnyRealm = (projectId: string): boolean => [...realms.values()].some((st) => st.ledger.runs().some((r) => r.projectId === projectId));
	/** Every attached realm's live ledger values (N1-L: never evicted while the handle lives). */
	const liveValues = (): string[] => {
		const out: string[] = [];
		for (const st of realms.values())
			for (const r of st.ledger.runs()) {
				out.push(r.token, r.publicToken, r.taskId);
				if (isHighEntropy(r.projectId)) out.push(r.projectId);
			}
		return out;
	};
	const scrubRoot = createScrubRoot({
		known,
		seen,
		identities,
		sessionToken: () => cm.loadToken(),
		apiKeys: () => {
			const live = clientApiKey();
			return live !== undefined && live.length >= NEEDLE_MIN && !apiKeys.has(live) ? [...apiKeys, live] : [...apiKeys];
		},
		liveValues,
		accountIds,
	});

	/** Scrubs one owned event for a realm and delivers it (a hit or an over-budget event is dropped and logged). */
	const deliverEvent = (st: IRealmState, event: DAPMessage): void => {
		const scrubbed = scrubEvent(st.scrub, event);
		if (scrubbed === null) {
			logDrop(st, CLIENT_EVENT_OP, 'credential');
			return;
		}
		const params = { message: scrubbed };
		verdicts.set(params, 'ok');
		router.deliver(st.info.realmId, CLIENT_EVENT_OP, params);
	};

	/** Root-internal timers (see `IAppRootOptions.schedule`). */
	const schedule =
		opts.schedule ??
		((cb: () => void, ms: number): (() => void) => {
			const timer = setTimeout(cb, ms);
			(timer as { unref?: () => void }).unref?.();
			return () => clearTimeout(timer);
		});

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

	/** Whether a terminate answer means the run is gone: it succeeded, or the engine says the run is no longer registered. */
	const terminated = (r: DAPMessage | undefined): boolean => isPlainObject(r) && (r.success !== false || (r as { code?: unknown }).code === TASK_NOT_REGISTERED);

	/**
	 * Ends what no ledger can hold: a run (terminate) or an open handle (fs_close,
	 * pipe close). A transport failure and a negative DAP answer are both failures
	 * (the SDK resolves the latter): the call is retried on the lost-run schedule,
	 * then logged. For a handle (fs_close, pipe close) a retry helps only when
	 * the call never reached the engine (transport failure): the engine releases
	 * a handle even when its close fails, so a retry after a negative answer is
	 * answered as an unknown handle, which this treats as a failure, not as closed.
	 */
	const endOrphanCall = (what: string, command: string, args: Record<string, unknown>, retriesLeft: number[] = [...LOST_RUN_RETRY_MS]): void => {
		track(sendEngine(command, args).then(terminated, () => false)).then((done) => {
			if (done) return;
			if (retriesLeft.length === 0) {
				opts.log('warn', `[isolation] could not end an unrecorded ${what}`);
				return;
			}
			const [delay, ...rest] = retriesLeft;
			schedule(() => endOrphanCall(what, command, args, rest), delay);
		});
	};
	const endOrphanRun = (token: string): void => endOrphanCall('run', 'terminate', { token });

	/** Best-effort end of what an answer started when it cannot be recorded (late, detached, or a record failure). */
	const endOrphan = (req: IGatedRequest, response: DAPMessage): void => {
		const body = isPlainObject(response) && response.success !== false && isPlainObject(response.body) ? response.body : undefined;
		if (!body) return;
		if ((req.command === 'execute' || req.command === 'restart') && typeof body.token === 'string') endOrphanRun(body.token);
		if (req.command === 'rrext_store' && req.subcommand === 'fs_open' && typeof body.handle === 'string') {
			endOrphanCall('file handle', 'rrext_store', { subcommand: 'fs_close', handle: body.handle, mode: req.fs!.mode });
		}
		if (req.command === 'rrext_process' && req.subcommand === 'open' && Number.isSafeInteger(body.pipe_id) && req.run) {
			endOrphanCall('pipe', 'rrext_process', { subcommand: 'close', token: req.run.token, pipe_id: body.pipe_id });
		}
	};

	/** Takes back what `record` allocated for an answer the realm will never receive (it was refused after recording). */
	const unrecord = (st: IRealmState, req: IGatedRequest, response: DAPMessage): void => {
		const body = isPlainObject(response) && response.success !== false && isPlainObject(response.body) ? response.body : undefined;
		if (!body) return;
		// A restart's token is the one endOrphan terminates: the run it renewed is gone with it.
		if ((req.command === 'execute' || req.command === 'restart') && typeof body.token === 'string') {
			const run = st.ledger.runByToken(body.token);
			if (run) st.ledger.dropRun(run.handle);
		}
		if (req.command === 'rrext_store' && req.subcommand === 'fs_open' && typeof body.handle === 'string') st.ledger.dropFs(body.handle);
		if (req.command === 'rrext_process' && req.subcommand === 'open' && Number.isSafeInteger(body.pipe_id)) req.run?.pipeIds.delete(body.pipe_id as number);
	};

	/**
	 * An execute whose answer was lost (the engine call threw, e.g. a timeout):
	 * the run may exist anyway, so look it up by its minted project and end it.
	 */
	/**
	 * Looks a lost run up by (minted project, source) and ends it. Resolves
	 * true once it is found and terminated (it then leaves the lost set).
	 */
	const endLostRun = (ledger: ILedger, project: string, source: string): Promise<'found' | 'absent' | 'error'> =>
		sendEngine('rrext_get_token', { projectId: project, source })
			.then(async (r): Promise<'found' | 'absent' | 'error'> => {
				if (!isPlainObject(r)) return 'error';
				// 'absent' only for the engine's own "no such run" answer: on_rrext_get_token
				// re-raises TaskError(TASK_NOT_REGISTERED), which DAPBase.build_exception
				// sends as success:false with `code`. Any other failure (permission,
				// ambiguity, transport) is 'error' and keeps the run counted.
				if (r.success === false) return (r as { code?: unknown }).code === TASK_NOT_REGISTERED ? 'absent' : 'error';
				const token = isPlainObject(r.body) ? r.body.token : undefined;
				if (typeof token !== 'string') return 'error';
				// A failed termination keeps the run in recovery (counted, looked up again); only a
				// success, or the engine saying the run is no longer registered, ends it.
				if (!terminated(await sendEngine('terminate', { token }))) return 'error';
				ledger.lostRuns.delete(project);
				return 'found';
			})
			.catch(() => 'error' as const);
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
			// Cleared by detach, teardown or logout (ledger.clear), or already found: no more lookups.
			if (!ledger.lostRuns.has(project)) return;
			track(endLostRun(ledger, project, source)).then((result) => {
				if (result === 'found' || !ledger.lostRuns.has(project)) return;
				if (retriesLeft.length === 0) {
					// The last lookup, answered by a connected engine: it never started. Stop counting it.
					if (result === 'absent') ledger.lostRuns.delete(project);
					return;
				}
				const [delay, ...rest] = retriesLeft;
				schedule(() => attempt(rest), delay);
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
	const record = (st: IRealmState, req: IGatedRequest, response: DAPMessage, runGeneration?: number): DAPMessage => {
		if (opts.__throwIn === 'ledger') throw new Error('test hook: ledger');
		if (!isPlainObject(response) || response.success === false) return response;
		const body = isPlainObject(response.body) ? response.body : undefined;
		const withBody = (next: Record<string, unknown>): DAPMessage => ({ ...response, body: next });
		switch (req.command) {
			case 'execute': {
				if (!body || typeof body.token !== 'string') return response;
				const pipeline = req.args.pipeline as Record<string, unknown>;
				remember(body.token, body.publicToken, body.id);
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
				run.generation++;
				if (!body) return response;
				remember(body.token, body.publicToken, body.id);
				if (typeof body.token === 'string') run.token = body.token;
				if (typeof body.publicToken === 'string') run.publicToken = body.publicToken;
				if (typeof body.id === 'string') run.taskId = body.id;
				return withBody(runBody(body, run));
			}
			case 'rrext_get_token': {
				if (!body) return response;
				const { token, publicToken: _public, ...rest } = body;
				remember(token, _public);
				const run = typeof token === 'string' ? st.ledger.runByToken(token) : undefined;
				return withBody(run ? { ...rest, token: run.handle } : rest);
			}
			case 'terminate':
				st.ledger.dropRun(req.run!.handle);
				return response;
			case 'rrext_get_task_status':
				// A status asked before a restart describes the run it replaced: it must not expire the restarted one.
				if (body && (body.completed === true || body.final === true) && req.run!.generation === runGeneration) st.ledger.complete(req.run!.handle);
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

	// ── Outbound choke point (N1-e): scrub, then the backstop ────────────────

	const outboundFor =
		(st: IRealmState) =>
		(message: unknown): unknown => {
			if (opts.__throwIn === 'outbound') throw new Error('test hook: outbound');
			// What the root already scrubbed (a client.request envelope, event params) is marked by
			// reference, never recognised by shape (DA F5): passed or refused without a second scan.
			const m = message as { __rrbus?: string; result?: unknown; params?: unknown };
			const marked = m?.__rrbus === 'response' ? m.result : m?.__rrbus === 'emitOp' ? m.params : undefined;
			const verdict = typeof marked === 'object' && marked !== null ? verdicts.get(marked) : undefined;
			if (verdict === 'ok') return message;
			if (verdict === 'deny') throw deny('credential', 'outbound');
			return scrubOutbound(st.scrub, message);
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
				const runGeneration = req.run?.generation;
				try {
					// DA F9: the API key fetched at attach (or login) is known before any answer is scrubbed.
					if (apiKeyReady) {
						await apiKeyReady;
						// Admitted before a detach, teardown, logout or terminate that happened during the wait: ownership is checked again.
						const runGone = req.run !== undefined && st.ledger.run(req.run.handle) !== req.run;
						const fsGone = typeof req.fs?.handle === 'string' && st.ledger.fs(req.fs.handle) === undefined;
						if (st.detached || closing > 0 || epoch !== startedIn || runGone || fsGone) throw deny('capability', 'client.request', { command: req.command });
					}
					// DA F8: events for this run that arrive before the answer are buffered, not dropped.
					if (req.mintedProject) st.pending.set(req.mintedProject, []);
					let response: DAPMessage;
					let reachedClient = false;
					try {
						response = (await track(
							Promise.resolve().then(() => {
								const c = client();
								reachedClient = true;
								return c.request(req.message, req.timeout);
							})
						)) as DAPMessage;
					} catch (err) {
						// Lost only if it may have been sent (DA R3-1): not while disconnected.
						if (reachedClient && !(err instanceof Error && NOT_SENT_ERRORS.has(err.message))) recoverLostRun(st, req);
						throw err;
					}
					// Teardown, logout or detach happened meanwhile: end what the answer started.
					if (st.detached || epoch !== startedIn) {
						endOrphan(req, response);
						throw deny('capability', 'client.request', { command: req.command });
					}
					let recorded: DAPMessage;
					try {
						recorded = record(st, req, response, runGeneration);
					} catch (err) {
						endOrphan(req, response);
						throw err;
					}
					// N1-a: scrubbed for this realm (over budget: too_large). A backstop hit outside notes and
					// error text is refused at the choke point, on the same request id (N1-e).
					// The answer is recorded already: if the realm cannot receive it (refused here, or at the
					// choke point), what it allocated is taken back and ended, not left held.
					let hit = false;
					let encoded: ReturnType<typeof encodeMessageData>;
					try {
						try {
							({ message: recorded, hit } = scrubResponse(st.scrub, req, recorded));
						} catch (err) {
							throw err instanceof CapabilityDeniedError ? err : deny('credential', 'client.request', { command: req.command });
						}
						encoded = encodeMessageData(recorded);
						const size = measure(encoded);
						if (size.json + size.bin > SIZES.response) throw deny('too_large', 'client.request', { command: req.command });
					} catch (err) {
						unrecord(st, req, response);
						endOrphan(req, response);
						throw err;
					}
					if (hit) {
						unrecord(st, req, response);
						endOrphan(req, response);
					}
					const envelope = { ok: true, value: encoded } satisfies IWireEnvelope;
					verdicts.set(envelope, hit ? 'deny' : 'ok');
					// The run is in the ledger now: events that came first are delivered (DA F8).
					const early = req.mintedProject ? st.pending.get(req.mintedProject) : undefined;
					if (early) {
						st.pending.delete(req.mintedProject!);
						for (const event of early) deliverEvent(st, event);
					}
					return envelope;
				} catch (err) {
					if (err instanceof CapabilityDeniedError) return deniedEnvelope(err);
					// N1-c: a thrown engine error loses its stack and has its text scrubbed.
					const envelope = sanitizeEnvelope({ ok: false, error: serializeError(err) });
					if (!envelope.ok) {
						try {
							envelope.error.message = scrubErrorText(st.scrub, envelope.error.message, req.run);
						} catch {
							envelope.error.message = REDACTED;
						}
					}
					return envelope;
				} finally {
					// An execute that started nothing: its buffered events are dropped.
					const left = req.mintedProject ? st.pending.get(req.mintedProject) : undefined;
					if (left) {
						st.pending.delete(req.mintedProject!);
						eventsDropped += left.length;
					}
					req.release();
				}
			},
			(err) => deniedEnvelope(asDenial(err, 'client.request'))
		);

		const lowerLedger = (run: IRunEntry, types: string[]): void => {
			const counts = st.ledger.monitors.get(run.handle);
			if (!counts) return;
			for (const t of types) {
				const n = (counts.get(t) ?? 0) - 1;
				if (n > 0) counts.set(t, n);
				else counts.delete(t);
			}
			if (counts.size === 0) st.ledger.monitors.delete(run.handle);
		};

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
			try {
				await client().removeMonitor({ token: run!.token }, types);
			} catch (err) {
				// The SDK lowers its own counts before it tells the engine, so a failed call leaves them one
				// lower. Put the reference back (addMonitor raises the count again) so the failure changes
				// nothing and a retry removes one reference, not two. If that cannot be done either, the SDK's
				// count stays lowered and the ledger follows it, so the two agree: the reference then counts as removed.
				const restored = await client()
					.addMonitor({ token: run!.token }, types)
					.then(
						() => true,
						() => false
					);
				if (!restored) lowerLedger(run!, types);
				throw err;
			}
			lowerLedger(run!, types);
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
		for (const st of realms.values()) {
			st.ledger.clear();
			st.scrub.aliases.clear();
			st.scrub.sighted.clear();
			st.pending.clear();
		}
		known.clear();
		seen.clear();
		identities.clear();
		apiKeys.clear();
	});
	cm.on('shell:login', () => refreshApiKeys());

	// ── client.event (N1-b): owned runs only, scrubbed, only while attached ─
	cm.on('shell:event', (payload: unknown) => {
		const event = isPlainObject(payload) && isPlainObject(payload.event) ? payload.event : undefined;
		const body = event && isPlainObject(event.body) ? event.body : undefined;
		// Root-wide sets take engine-shaped values only (security N1): a task-id-shaped status id here,
		// an engine-shaped project id below. Event bodies never feed the identity store.
		if (event && event.event === STATUS_EVENT && typeof event.id === 'string' && TASK_ID_RE.test(event.id)) remember(event.id);
		const projectId = body && typeof body.project_id === 'string' && body.project_id !== '' ? body.project_id : undefined;
		const owners = projectId === undefined ? [] : [...realms.values()].filter((st) => !st.detached && st.ledger.runs().some((r) => r.projectId === projectId));
		if (owners.length === 0) {
			// A run whose execute answer is still in flight (DA F8): buffered, not foreign.
			const waiting = projectId === undefined ? undefined : [...realms.values()].find((st) => !st.detached && st.pending.has(projectId));
			const buffer = waiting?.pending.get(projectId!);
			if (buffer && buffer.length < PENDING_EVENTS_MAX) {
				buffer.push(event as unknown as DAPMessage);
				return;
			}
			eventsDropped++;
			// Only the root's own engine-event stream feeds the foreign set (security M1), and only with
			// engine-shaped ids, a UUID or a minted rrapp. id (security N1, round 2). The engine accepts any
			// caller-supplied project_id (task_server.py:1463-1465), so other ids exist; aliasing guessable
			// ones would make the scrubber a membership oracle. Such ids in free-text engine errors are a
			// documented residual (PR2_PLAN.md section 8).
			if (projectId !== undefined && !waiting && isEngineShaped(projectId)) known.add(projectId);
			return;
		}
		for (const st of owners) deliverEvent(st, event as unknown as DAPMessage);
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
				gate: { info, ledger, rate: createRateLimiter(opts.now), sessionToken: () => cm.loadToken(), inbound: () => scrubRoot.inbound(), random: opts.random, ...(opts.__throwIn ? { throwIn: opts.__throwIn } : {}) },
				scrub: { root: scrubRoot, ledger, grant, aliases: new Map(), sighted: createKnownProjects(), mintAlias: () => mintProjectAlias(opts.random), ownedByAnyRealm },
				pending: new Map(),
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
			refreshApiKeys();
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
				let stopped = false;
				const drain = async (): Promise<boolean> => {
					await Promise.allSettled(work);
					while (background.size > 0 && !stopped) await Promise.allSettled([...background]);
					return false;
				};
				let timer: ReturnType<typeof setTimeout> | undefined;
				const timedOut = await Promise.race([drain(), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), timeoutMs)))]);
				if (timer !== undefined) clearTimeout(timer);
				if (timedOut) {
					// What is still pending past the timeout is hung (security R3-L3): stop
					// tracking it, so no later teardown waits on it again. Its late answer
					// is still ended by the epoch check.
					stopped = true;
					background.clear();
				}
				if (tally.failed > 0 || timedOut) opts.log('warn', `[isolation] teardown: ${tally.failed} terminate request(s) failed${timedOut ? '; timed out' : ''}`);
				for (const st of realms.values()) st.ledger.clear();
			} finally {
				closing--;
			}
		},

		__stats: () => ({ eventsDropped, knownProjects: known.size() }),
	};
}
