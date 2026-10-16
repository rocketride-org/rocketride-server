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
// useBotTask — the bot's lifecycle, as one hook
// =============================================================================
//
// One shared always-on task, not one per viewer: the app ATTACHES to the
// running task rather than owning it. That is why every start passes
// `useExisting: true` and why the token is resolved from the server by
// (projectId, source) before the persisted one is trusted — a second viewer,
// or the same viewer after a reload, finds the same task.
//
// TWO tasks, not one. The eval-capture pipe is a separate always-on task with
// its own identity, and every lifecycle verb reconciles it: a start or restart
// brings it up (or restarts it on the new config) when Settings › Pipeline asks
// for it, and terminates it when it does not, so turning capture off really
// does stop the second Gateway session.
//
// THE TOKENS ARE RUNTIME STATE AND ARE NEVER PERSISTED. They used to be
// written to the workspace slice, which was always a half-measure — the
// server is asked for them by `(projectId, source)` on every load anyway, and
// a persisted token that had been reclaimed was a dead handle the app trusted
// until the first status poll disagreed. They live in this hook's state now,
// and nowhere else.
//
// THE DATABASE CONNECTION IS THREADED THROUGH. `resolvePipeline` needs it to
// give the bot's pipeline its `capture_db` component, which is what makes the
// node write every event server-side. A start with no connection in hand
// resolves a pipeline with no capture, which is exactly what the old
// browser-side capture was.
//
// WITH CAPTURE ON, START ASKS THE DATABASE FIRST. The capture component is a
// database node, and a database node connects when its pipeline starts, so a
// stopped container would fail the start with an engine error that names
// neither the database nor the fix. Start and Restart run one `SELECT 1`
// first and refuse with `databaseDownMessage`, which says how to start it.
// A database that goes away AFTER the start is the node's problem, and it
// handles it: capture writes fail and are logged, and the bot keeps answering.
//
// SDK calls used, all from packages/client-typescript/src/client/client.ts:
//   use            (1387) — start, ttl 0 = runs until stopped
//   terminate      (1504) — stop
//   restart        (1541) — stop-and-start in one round trip
//   getTaskStatus  (1564) — the status header and the error state
//   getTaskToken   (1593) — re-attach to a task this session did not start
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useShellConnection } from 'shell';
import type { ITaskStatus, RocketRideClient } from 'shell';
import { CAPTURE_PIPELINE, PIPELINES, pipeIdentity, resolvePipeline, missingForStart } from '../pipeline/resolve';
import type { OptionalVariables } from '../pipeline/resolve';
import { databaseDownMessage, type DbConnection } from '../db/config';
import type { AppData, BotSettings } from '../state/types';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * `TASK_STATE.RUNNING` from packages/client-typescript/src/client/types/task.ts.
 *
 * Mirrored as a literal rather than imported: `shell` re-exports the SDK's
 * TYPES only (`export type * from 'rocketride'` in packages/shell/src/api.ts),
 * so the enum is not reachable as a value through the app's one runtime door.
 */
const TASK_STATE_RUNNING = 3;

/** `TASK_STATE.STARTING` — the task is allocating, not answering yet. */
const TASK_STATE_STARTING = 1;

/** `TASK_STATE.INITIALIZING` — the bot is logging in to the Gateway. */
const TASK_STATE_INITIALIZING = 2;

/** How often the status header re-reads `getTaskStatus` (ms). */
const STATUS_POLL_MS = 6000;

/**
 * Trace level the app asks for: none.
 *
 * The conversation capture reads the node's own `apaevt_sse` broadcasts (see
 * `parseEvent.ts`), which are independent of the trace level, and so is the
 * TASK lifecycle stream that feeds the status header. Traces would buy the app
 * nothing and cost the engine a serialization per lane write.
 */
const TRACE_LEVEL = 'none' as const;

/**
 * The node's ready line (`IEndpoint.py::_on_ready` → `monitorStatus`). The
 * `<bot name>` the UX spec §4 asks for lives in its tail and nowhere else the
 * app can reach.
 */
const BOT_READY_PREFIX = 'Discord Bot ready - logged in as ';

/** Consecutive recovery failures after which F5 shows the log excerpt. */
export const FAILURES_BEFORE_LOG = 2;

/** How many trailing log lines the F5 excerpt shows. */
export const LOG_EXCERPT_LINES = 6;

// =============================================================================
// TYPES
// =============================================================================

/** How the Bot screen reads the task right now. */
export type BotPhase = 'unknown' | 'stopped' | 'starting' | 'running' | 'failed';

/** What {@link useBotTask} hands back. */
export interface UseBotTask {
	/** The resolved task token, or null when no task is running. */
	token: string | null;
	/** The eval-capture task's token, or null when it is not running. */
	captureToken: string | null;
	/** The last status read, or null before the first one lands. */
	status: ITaskStatus | null;
	/** Coarse phase derived from the status. */
	phase: BotPhase;
	/** True until the first status read settles (the loading cell). */
	loading: boolean;
	/** The node's own fatal text, or the last action failure. */
	error: string | null;
	/** The bot's Discord name, parsed from the node's ready line. */
	botName: string | null;
	/** Consecutive failed starts or restarts; 0 once one succeeds (F5). */
	failures: number;
	/** The tail of the task's error and warning history, for the F5 excerpt. */
	logExcerpt: string[];
	/** An action is in flight — every action control disables itself. */
	busy: boolean;
	/** Settings fields a start still needs; empty when the bot can start. */
	missing: string[];
	/** Start the bot. Resolves to an error string, or null on success. */
	start: () => Promise<string | null>;
	/** Stop the bot. Resolves to an error string, or null on success. */
	stop: () => Promise<string | null>;
	/** Restart the bot. Resolves to an error string, or null on success. */
	restart: () => Promise<string | null>;
}

// =============================================================================
// HELPERS
// =============================================================================

/** The message of an unknown throw, never an empty string. */
function reasonOf(err: unknown): string {
	if (err instanceof Error && err.message) return err.message;
	const text = String(err ?? '');
	return text.length > 0 ? text : 'The engine gave no reason.';
}

/**
 * Derive the coarse phase from a status read.
 *
 * @param status - The last status, or null when none has landed.
 * @returns The phase the Bot screen renders.
 */
function phaseOf(status: ITaskStatus | null): BotPhase {
	if (!status) return 'unknown';
	const state = typeof status.state === 'number' ? status.state : -1;
	if (status.completed === true) return 'stopped';
	if (state === TASK_STATE_STARTING || state === TASK_STATE_INITIALIZING) return 'starting';
	if (state === TASK_STATE_RUNNING) return status.serviceUp === false ? 'failed' : 'running';
	return 'stopped';
}

/** The string entries of one of the status history lists. */
function historyOf(status: ITaskStatus | null, key: 'errors' | 'warnings'): string[] {
	const value = status ? status[key] : undefined;
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * The fatal text to show on the error state: the node's own words first.
 *
 * `status.errors` is a 1000-entry HISTORY, not a current-state field, so it is
 * only read once the task actually IS in trouble — a transient error logged
 * while the bot went on answering must not pin a red banner on the screen for
 * the life of the run. "In trouble" means a non-zero exit or a task that
 * reached RUNNING with its service down, which is exactly the `failed` phase.
 *
 * The UX spec (F1, F5) asks for "the exact fix text the node already emits" —
 * bad token, missing Message Content Intent, missing channel permissions all
 * arrive as engine errors or as the status line, so those are what is shown,
 * unaltered.
 *
 * @param status - The last status read.
 * @param phase - The phase derived from that status.
 * @returns The node's fatal line, or null when nothing is wrong.
 */
function fatalOf(status: ITaskStatus | null, phase: BotPhase): string | null {
	if (!status) return null;
	const badExit = typeof status.exitCode === 'number' && status.exitCode !== 0;
	const errors = historyOf(status, 'errors');
	// A push source never completes on its own: "Completed" with an error in
	// the history is the engine's way of reporting a source that failed to
	// start (the exit code stays 0), so treat it as a failure too.
	const completedWithErrors = status.completed === true && errors.length > 0;
	if (phase !== 'failed' && !badExit && !completedWithErrors) return null;
	if (badExit && status.exitMessage) return String(status.exitMessage);
	if (errors.length > 0) return errors[errors.length - 1];
	if (typeof status.status === 'string' && status.status.length > 0) return status.status;
	return badExit ? `The task exited with code ${status.exitCode}.` : 'The bot is not serving requests.';
}

/**
 * The bot's Discord name, out of the node's ready line.
 *
 * `status.name` is the TASK name, which this app itself sets — it can never be
 * the bot's identity, so the header labels it as what it is unless this parse
 * succeeds.
 *
 * @param status - The last status read.
 * @returns The name the node logged in as, or null.
 */
function botNameOf(status: ITaskStatus | null): string | null {
	const line = status && typeof status.status === 'string' ? status.status : '';
	if (!line.startsWith(BOT_READY_PREFIX)) return null;
	const name = line.slice(BOT_READY_PREFIX.length).trim();
	return name.length > 0 ? name : null;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Own the bot task: resolve its token, poll its status, and expose start,
 * stop and restart.
 *
 * @param data - The dashboard data, for the settings the pipeline is
 *        resolved from.
 * @param enabled - False in sample-data mode: no calls leave the browser.
 * @param variables - The optional envkey names and what the server holds, for
 *        the start preconditions.
 * @param conn - Where the dashboard database is, so the bot's pipeline gets
 *        its capture component.
 * @param probeDatabase - One trivial statement against that database; null
 *        when it answered, else the reason. Asked before Start and Restart
 *        while capture is on.
 * @returns The task surface — see {@link UseBotTask}.
 */
export function useBotTask(data: AppData, enabled: boolean, variables: OptionalVariables, conn: DbConnection, probeDatabase: () => Promise<string | null>): UseBotTask {
	const { client, isConnected } = useShellConnection();
	const settings: BotSettings = data.settings;

	const [token, setToken] = useState<string | null>(null);
	const [captureToken, setCaptureToken] = useState<string | null>(null);
	const [status, setStatus] = useState<ITaskStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	// Consecutive failed recovery attempts (UX spec F5).
	const [failures, setFailures] = useState(0);

	// The chosen pipe and its task identity. Re-read on every render: a
	// Settings › Pipeline change must move the app to the other pipe's task.
	const pipe = PIPELINES[settings.pipeline.pipe];
	const identity = pipeIdentity(pipe);
	const captureIdentity = pipeIdentity(CAPTURE_PIPELINE);
	const captureEnabled = settings.pipeline.captureEnabled;

	// The latest tokens, for callbacks that must not re-create on every change.
	const tokenRef = useRef<string | null>(token);
	tokenRef.current = token;
	const captureRef = useRef<string | null>(captureToken);
	captureRef.current = captureToken;

	// --- Token resolution -----------------------------------------------------

	useEffect(() => {
		if (!enabled || !isConnected || !client || !identity.projectId || !identity.source) return;
		let alive = true;
		client
			.getTaskToken({ projectId: identity.projectId, source: identity.source })
			.then((resolved) => {
				if (!alive) return;
				// The server knows what is actually running, and it is the only
				// thing that does: no task resolves to undefined, which clears the
				// handle rather than leaving a dead one behind.
				setToken(resolved ?? null);
			})
			.catch(() => {
				// Unreachable or unauthorised: no token, and the status poll is
				// what reports the truth.
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [enabled, isConnected, client, identity.projectId, identity.source]);

	// The capture task is resolved even when capture is OFF: a task left running
	// by an earlier session is exactly what the next lifecycle verb has to
	// terminate, and it cannot terminate a token it never learned.
	useEffect(() => {
		if (!enabled || !isConnected || !client || !captureIdentity.projectId || !captureIdentity.source) return;
		let alive = true;
		client
			.getTaskToken({ projectId: captureIdentity.projectId, source: captureIdentity.source })
			.then((resolved) => {
				if (!alive) return;
				setCaptureToken(resolved ?? null);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [enabled, isConnected, client, captureIdentity.projectId, captureIdentity.source]);

	// --- Status polling -------------------------------------------------------

	useEffect(() => {
		if (!enabled || !isConnected || !client) {
			setLoading(false);
			return;
		}
		if (!token) {
			setStatus(null);
			setLoading(false);
			return;
		}
		let alive = true;

		/** One status read; a failure clears the status rather than lying. */
		const read = () => {
			client
				.getTaskStatus(token)
				.then((next) => {
					if (!alive) return;
					setStatus(next);
					setLoading(false);
					// A healthy task retires the last action's failure text for the
					// same reason `fatalOf` ignores the error history: a bot that is
					// answering must not wear a red banner about a past attempt.
					//
					// The checklist learns nothing here any more. It used to tick
					// "token saved" and "bot started" from a RUNNING task and persist
					// that — a stored memory of a fact the Bot screen reads straight
					// off `bot.phase`, which is where it now comes from.
					if (next.state === TASK_STATE_RUNNING && next.serviceUp !== false) {
						setActionError(null);
					}
				})
				.catch(() => {
					if (!alive) return;
					setStatus(null);
					setLoading(false);
				});
		};

		read();
		const timer = setInterval(read, STATUS_POLL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [enabled, isConnected, client, token]);

	// --- Actions --------------------------------------------------------------

	/**
	 * Bring the shadow capture task in line with Settings › Pipeline.
	 *
	 * Capture on and nothing running starts it; capture on and something running
	 * RESTARTS it, so a settings change reaches it too; capture off terminates
	 * whatever is left. Best effort by design: the capture branch posts nothing
	 * to Discord, so a capture that will not start must not stop the bot from
	 * answering. The reason is returned for the caller's toast.
	 *
	 * @param c - The connected client.
	 * @returns The failure reason, or null.
	 */
	const reconcileCapture = useCallback(
		async (c: RocketRideClient): Promise<string | null> => {
			const existing = captureRef.current;
			const pipeline = resolvePipeline(CAPTURE_PIPELINE, settings, { applyNodeConfig: false });
			try {
				if (!captureEnabled) {
					if (existing === null) return null;
					await c.terminate(existing);
					setCaptureToken(null);
					return null;
				}
				if (existing !== null) {
					await c.restart({
						token: existing,
						projectId: captureIdentity.projectId,
						source: captureIdentity.source,
						pipeline: pipeline as unknown as Record<string, unknown>,
					});
					const resolved = await c.getTaskToken({ projectId: captureIdentity.projectId, source: captureIdentity.source }).catch(() => existing);
					setCaptureToken(resolved ?? existing);
					return null;
				}
				const result = await c.use({
					pipeline,
					useExisting: true,
					ttl: 0,
					name: 'Discord Dashboard capture',
					pipelineTraceLevel: TRACE_LEVEL,
				});
				setCaptureToken(result.token);
				return null;
			} catch (err) {
				return reasonOf(err);
			}
		},
		[settings, captureEnabled, captureIdentity.projectId, captureIdentity.source]
	);

	/**
	 * Refuse a start the database would fail, with the way to fix it.
	 *
	 * @returns Null when capture is off or the database answered; otherwise
	 *          the message, which is also put on the Bot screen.
	 */
	const checkDatabase = useCallback(
		async (verb: 'start' | 'restart'): Promise<string | null> => {
			if (!settings.advanced.captureToDatabase) return null;
			const reason = await probeDatabase();
			if (reason === null) return null;
			const message = databaseDownMessage(conn, reason, verb);
			setActionError(message);
			return message;
		},
		[settings.advanced.captureToDatabase, probeDatabase, conn]
	);

	const start = useCallback(async (): Promise<string | null> => {
		if (!client || !isConnected) return 'Not connected to the engine.';
		const missing = missingForStart(settings, variables);
		if (missing.length > 0) {
			setFailures((n) => n + 1);
			return `Cannot start yet — missing ${missing.join(' and ')}. Check Settings › Discord and the server variables.`;
		}
		setBusy(true);
		setActionError(null);
		try {
			const down = await checkDatabase('start');
			if (down !== null) return down;
			const result = await client.use({
				// With capture on, this is where the bot's pipeline gains its
				// `capture_db` component — so starting the bot is what starts the
				// server-side capture, and the two can never be out of step.
				pipeline: resolvePipeline(pipe, settings, { conn }),
				useExisting: true,
				// ttl 0 = no idle timeout. The bot runs until it is stopped.
				ttl: 0,
				name: 'Discord Dashboard bot',
				pipelineTraceLevel: TRACE_LEVEL,
			});
			setToken(result.token);
			setFailures(0);
			const captureError = await reconcileCapture(client);
			return captureError === null ? null : `Bot started, but the capture branch failed: ${captureError}`;
		} catch (err) {
			const reason = reasonOf(err);
			setActionError(reason);
			setFailures((n) => n + 1);
			return reason;
		} finally {
			setBusy(false);
		}
	}, [client, isConnected, settings, variables, pipe, conn, reconcileCapture, checkDatabase]);

	const stop = useCallback(async (): Promise<string | null> => {
		const current = tokenRef.current;
		if (!client || !isConnected) return 'Not connected to the engine.';
		if (!current) return 'The bot is not running.';
		setBusy(true);
		setActionError(null);
		try {
			await client.terminate(current);
			// The shadow capture is a separate task; stopping the bot stops it too,
			// otherwise it keeps a Gateway session open with nobody watching.
			if (captureRef.current !== null) {
				await client.terminate(captureRef.current).catch(() => undefined);
			}
			setToken(null);
			setCaptureToken(null);
			setStatus(null);
			setFailures(0);
			return null;
		} catch (err) {
			const reason = reasonOf(err);
			setActionError(reason);
			return reason;
		} finally {
			setBusy(false);
		}
	}, [client, isConnected]);

	const restart = useCallback(async (): Promise<string | null> => {
		const current = tokenRef.current;
		if (!client || !isConnected) return 'Not connected to the engine.';
		// Nothing to restart yet — a plain start is what the user means.
		if (!current) return start();
		const missing = missingForStart(settings, variables);
		if (missing.length > 0) {
			setFailures((n) => n + 1);
			return `Cannot restart yet — missing ${missing.join(' and ')}. Check Settings › Discord and the server variables.`;
		}
		// Before anything is stopped: a pipe change below stops the bot first,
		// and a refused start after that would leave it down.
		const down = await checkDatabase('restart');
		if (down !== null) return down;
		// The engine's restart re-initializes the task it already has; it keeps
		// the pipeline graph that task was born with. When Settings › Pipeline now
		// names a different pipe (a different project id), only a fresh task can
		// run it, so stop and start instead.
		const runningProject = (status as unknown as { project_id?: string } | null)?.project_id ?? null;
		if (runningProject && identity.projectId && runningProject !== identity.projectId) {
			const stopError = await stop();
			if (stopError && !/not running/i.test(stopError)) return stopError;
			return start();
		}
		setBusy(true);
		setActionError(null);
		try {
			await client.restart({
				token: current,
				projectId: identity.projectId,
				source: identity.source,
				pipeline: resolvePipeline(pipe, settings, { conn }) as unknown as Record<string, unknown>,
			});
			// `restart` keeps the task identity, so the token survives; re-resolve
			// it anyway so a server-side re-key cannot leave a dead handle.
			const resolved = await client.getTaskToken({ projectId: identity.projectId, source: identity.source }).catch(() => current);
			setToken(resolved ?? current);
			setFailures(0);
			const captureError = await reconcileCapture(client);
			return captureError === null ? null : `Bot restarted, but the capture branch failed: ${captureError}`;
		} catch (err) {
			const reason = reasonOf(err);
			// The task is gone (it completed, was terminated, or the engine came
			// back): the engine cannot restart it, but a fresh start is what the
			// user meant, so do that instead of counting a recovery failure.
			if (/not running|not found|no such task|token is required/i.test(reason)) {
				setToken(null);
				setBusy(false);
				return start();
			}
			setActionError(reason);
			setFailures((n) => n + 1);
			return reason;
		} finally {
			setBusy(false);
		}
	}, [client, isConnected, settings, variables, pipe, identity.projectId, identity.source, conn, start, reconcileCapture, checkDatabase]);

	const phase = enabled ? phaseOf(status) : 'unknown';
	// The F5 excerpt: the tail of what the engine recorded, errors last, so the
	// most recent line is the one nearest the reader.
	const logExcerpt = [...historyOf(status, 'warnings'), ...historyOf(status, 'errors')].slice(-LOG_EXCERPT_LINES);

	return {
		token,
		captureToken,
		status,
		phase,
		loading: enabled ? loading : false,
		error: actionError ?? fatalOf(status, phase),
		botName: botNameOf(status),
		failures,
		logExcerpt,
		busy,
		missing: missingForStart(settings, variables),
		start,
		stop,
		restart,
	};
}
