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
// useDashboardData — the database, as the shape the screens already read
// =============================================================================
//
// This replaces the data role of `useAppData`. It loads the whole picture
// once, keeps the capture log fresh by polling, and exposes every WRITE as an
// explicit, awaitable action. There is no functional updater and no merge:
// the database is the merge, and a write that lands is followed by a reload
// of the table it touched.
//
// THE APP NEVER WRITES `dd_events`. Capture is the discord node's job (see
// `resolvePipeline`), which is what makes a question
// asked while every dashboard is closed still arrive. The browser's only
// relationship with the log is `SELECT … WHERE seq > $last`.
//
// POLL, WITH A PUSH TO MAKE IT FEEL LIVE. Every five seconds, and immediately
// whenever the shell forwards an `apaevt_sse` discord event from a running
// task. The push is a TRIGGER, not data: the row it would describe is already
// on its way into the database from the node, and reading it back is what
// guarantees two open tabs agree.
//
// CONFLICTS ARE ONLY POSSIBLE ON SETTINGS. Everything else is keyed by thread
// or appended, so two admins cannot overwrite each other; a settings slice is
// one object two people can hold different drafts of, so it carries a version
// and a save that loses the race says so and reloads.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NOT_CONNECTED, reasonOf, useDbGateway, type DbStatus, type Exec } from './gateway';
import type { DbConnection } from './config';
import { emptyFold, foldEvents, overlayThreads, type FoldState } from './fold';
import { applyReview as writeReview, applyReviewIn, getMeta, insertApprovedQa, insertReview, insertRun, loadApprovedQaByThread, loadClusters, loadEventsSince, loadGolden, loadKbContent, loadKbDocuments, loadPendingQa, loadRecentRuns, loadSettings, loadThreads, loadChangeSignature, type SignatureKey, markQaIngested as writeQaIngested, markReplay as writeReplay, META_LAST_GRADED_AT, saveGrade as writeGrade, saveSettingsSlice, setDismissed as writeDismissed, setMeta, upsertCluster as writeCluster, upsertGolden, upsertKbDocument, upsertTaughtKbDocument, type ApprovedQa, type GradeWrite, type KbDocument, type KbDocumentWrite, type ReviewWrite, type StoredSlice, type ThreadState } from './repo';
import { DEFAULT_SETTINGS, EMPTY_APP_DATA, type AppData, type BotSettings, type GoldenCase, type GraderCluster, type ReplayRun, type SettingsSlice } from '../state/types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** How often the capture log is re-read (ms). */
export const POLL_MS = 5000;

/** How many event rows one read asks for. Paged until a short page comes back. */
export const EVENT_PAGE = 1000;

/** How many replay runs the Quality screen holds: this one and the one before. */
export const RUN_HISTORY = 2;

/** What a save says when somebody else's landed first. */
export const SETTINGS_CONFLICT = 'Someone else changed these settings — reloaded the latest';

// =============================================================================
// TYPES
// =============================================================================

/** Every write the screens can make, as an explicit call. */
export interface DashboardActions {
	/**
	 * Save one settings slice.
	 *
	 * @returns Null when it landed, or the conflict sentence when somebody
	 *          else's save won — the settings have been reloaded by then.
	 */
	saveSettings: (slice: SettingsSlice, value: unknown) => Promise<string | null>;
	/** Write one grade. */
	saveGrade: (threadId: string, grade: GradeWrite) => Promise<void>;
	/** Apply a reviewer's verdict and record it. */
	applyReview: (threadId: string, patch: ReviewWrite, reviewer: string, action: string) => Promise<void>;
	/** Drop a thread from "Needs you", or put it back. */
	dismiss: (threadId: string, dismissed?: boolean) => Promise<void>;
	/**
	 * Approve a Q/A pair, seed its golden case, and stamp the review.
	 *
	 * @returns The pair as the database now holds it. Its `id` is what a
	 *          knowledge-base write stamps against, and the caller has it
	 *          before the reload that would otherwise surface it.
	 */
	teach: (threadId: string, pair: { question: string; answer: string }, golden: GoldenCase, reviewer: string) => Promise<ApprovedQa>;
	/**
	 * Stamp an approved pair as verified in the knowledge base, and catalogue
	 * the taught answer it became on the Knowledge screen.
	 */
	markQaIngested: (id: number, objectId: string, documentName: string) => Promise<void>;
	/** Catalogue a document the Knowledge screen added to the knowledge base. */
	addKbDocument: (document: KbDocumentWrite) => Promise<void>;
	/**
	 * One catalogued document's full text — a READ, here because the list
	 * leaves the text out and only an opened document needs it.
	 *
	 * @returns The text, or null when the catalog has no such document.
	 */
	readKbContent: (objectId: string) => Promise<string | null>;
	/** Store a run this app drove. */
	saveReplayRun: (run: ReplayRun) => Promise<void>;
	/** Store a run imported from a JSONL file. */
	importReplayRun: (run: ReplayRun) => Promise<void>;
	/** Add a cluster, or refresh its description. Returns the id that won. */
	upsertCluster: (id: string, label: string, description: string) => Promise<string>;
	/** Record when a grading batch finished. */
	setLastGradedAt: (ms: number) => Promise<void>;
	/** Flag a thread as replay traffic. */
	markReplay: (threadId: string, replay?: boolean) => Promise<void>;
	/** Re-read the capture log now, without waiting for the next poll. */
	poll: () => void;
	/**
	 * Ask the database one trivial statement, right now.
	 *
	 * @returns Null when it answered, or the reason it did not.
	 */
	probeDatabase: () => Promise<string | null>;
}

/** What {@link useDashboardData} hands back. */
export interface UseDashboardData {
	/** The shape the screens render. */
	data: AppData;
	/** True once the first full load has landed. */
	loaded: boolean;
	/** Where the database is. */
	dbStatus: DbStatus;
	/** The last failure's text, or null. */
	dbError: string | null;
	/** The approved pairs a writeback run would write. */
	pendingQa: ApprovedQa[];
	/** The knowledge-base catalog, newest first, without the text. */
	kbDocuments: KbDocument[];
	/** Every write. */
	actions: DashboardActions;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Merge the stored slices over the defaults, one sub-page at a time.
 *
 * A shallow spread would drop fields added after a slice was written, so
 * every group is spread individually — the same reasoning `mergeSettings` had
 * when the store was a workspace blob.
 *
 * @param stored - What the database holds, by slice.
 * @returns A complete settings object.
 */
export function settingsFromSlices(stored: Record<string, StoredSlice>): BotSettings {
	/** One slice's stored object, or an empty one. */
	const read = <K extends SettingsSlice>(slice: K): Partial<BotSettings[K]> => {
		const value = stored[slice]?.value;
		return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<BotSettings[K]>) : {};
	};
	return {
		discord: { ...DEFAULT_SETTINGS.discord, ...read('discord') },
		behavior: { ...DEFAULT_SETTINGS.behavior, ...read('behavior') },
		pipeline: { ...DEFAULT_SETTINGS.pipeline, ...read('pipeline') },
		advanced: { ...DEFAULT_SETTINGS.advanced, ...read('advanced') },
		eval: { ...DEFAULT_SETTINGS.eval, ...read('eval') },
	};
}

/** Read every event the app has not folded yet, a page at a time. */
async function readAllEvents(exec: Exec, from: number): Promise<Awaited<ReturnType<typeof loadEventsSince>>> {
	const all: Awaited<ReturnType<typeof loadEventsSince>> = [];
	let cursor = from;
	for (;;) {
		const page = await loadEventsSince(exec, cursor, EVENT_PAGE);
		if (page.length === 0) break;
		all.push(...page);
		cursor = page[page.length - 1].seq;
		if (page.length < EVENT_PAGE) break;
	}
	return all;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Load the dashboard out of the database and keep it fresh.
 *
 * @param conn - Where the database is, from the manifest settings.
 * @param enabled - False in sample-data mode: nothing is read or written.
 * @returns The data, its state and every write — see {@link UseDashboardData}.
 */
export function useDashboardData(conn: DbConnection, enabled: boolean): UseDashboardData {
	const { status, error, exec, tx } = useDbGateway(conn, enabled);
	const ready = enabled && status !== 'connecting';

	const [loaded, setLoaded] = useState(false);
	const [slices, setSlices] = useState<Record<string, StoredSlice>>({});
	const [threads, setThreads] = useState<ThreadState[]>([]);
	const [approved, setApproved] = useState<ApprovedQa[]>([]);
	const [pendingQa, setPendingQa] = useState<ApprovedQa[]>([]);
	const [clusters, setClusters] = useState<GraderCluster[]>([]);
	const [golden, setGolden] = useState<GoldenCase[]>([]);
	const [runs, setRuns] = useState<ReplayRun[]>([]);
	const [lastGradedAt, setLastGradedAt] = useState<number | null>(null);
	const [kbDocuments, setKbDocuments] = useState<KbDocument[]>([]);
	// The fold, bumped by a counter so a new object identity is not needed for
	// React to notice the rows changed.
	const fold = useRef<FoldState>(emptyFold());
	const [foldTick, setFoldTick] = useState(0);

	// The settings the fold classifies with, readable from inside the poll.
	const settings = useMemo(() => settingsFromSlices(slices), [slices]);
	const settingsRef = useRef(settings);
	settingsRef.current = settings;

	// A poll is in flight — a slow read must not have the next tick stack a
	// second one behind it.
	const polling = useRef(false);
	// The last fingerprint of the app-written tables; null until the first look.
	const signature = useRef<Record<SignatureKey, string> | null>(null);
	// The connection this fold belongs to. A different database is a different
	// log, and its seq numbers mean nothing here.
	const foldKey = useRef<string | null>(null);

	// --- Reads ----------------------------------------------------------------

	const reloadSettings = useCallback(async () => setSlices(await loadSettings(exec)), [exec]);
	const reloadThreads = useCallback(async () => setThreads(await loadThreads(exec)), [exec]);
	const reloadClusters = useCallback(async () => setClusters(await loadClusters(exec)), [exec]);
	const reloadGolden = useCallback(async () => setGolden(await loadGolden(exec)), [exec]);
	const reloadRuns = useCallback(async () => setRuns(await loadRecentRuns(exec, RUN_HISTORY)), [exec]);

	const reloadQa = useCallback(async () => {
		setApproved(await loadApprovedQaByThread(exec));
		setPendingQa(await loadPendingQa(exec));
	}, [exec]);

	const reloadKb = useCallback(async () => setKbDocuments(await loadKbDocuments(exec)), [exec]);

	const reloadMeta = useCallback(async () => {
		const stamp = await getMeta(exec, META_LAST_GRADED_AT);
		const ms = stamp === null ? NaN : Date.parse(stamp);
		setLastGradedAt(Number.isFinite(ms) ? ms : null);
	}, [exec]);

	/** Read the events the fold has not seen and add them to it. */
	const pollEvents = useCallback(async () => {
		if (polling.current) return;
		polling.current = true;
		try {
			const page = await readAllEvents(exec, fold.current.seq);
			if (page.length === 0) return;
			fold.current = foldEvents(fold.current, page, settingsRef.current);
			setFoldTick((tick) => tick + 1);
		} finally {
			polling.current = false;
		}
	}, [exec]);

	/**
	 * Reload whatever another tab or admin changed.
	 *
	 * Events arrive through `pollEvents`; every other table is written by the
	 * tab that acted, so this tab learns about it from a one-row fingerprint
	 * and reloads only the tables whose fingerprint moved. The first look just
	 * records the fingerprint — the first load already read everything.
	 */
	const pollOthers = useCallback(async () => {
		const next = await loadChangeSignature(exec);
		const prev = signature.current;
		signature.current = next;
		if (prev === null) return;
		const changed = (key: SignatureKey) => prev[key] !== next[key];
		if (changed('settings')) await reloadSettings();
		if (changed('threads') || changed('reviews')) await reloadThreads();
		if (changed('clusters')) await reloadClusters();
		if (changed('golden')) await reloadGolden();
		if (changed('runs')) await reloadRuns();
		if (changed('qa')) await reloadQa();
		if (changed('meta')) await reloadMeta();
		if (changed('kb')) await reloadKb();
	}, [exec, reloadSettings, reloadThreads, reloadClusters, reloadGolden, reloadRuns, reloadQa, reloadMeta, reloadKb]);

	const poll = useCallback(() => {
		if (!ready || status === 'error') return;
		void pollEvents().catch(() => undefined);
	}, [ready, status, pollEvents]);

	// --- The first load -------------------------------------------------------

	useEffect(() => {
		if (!enabled) {
			setLoaded(true);
			return;
		}
		if (status !== 'ready') return;
		let alive = true;
		void (async () => {
			try {
				// A different database is a different log: the fold's `seq` cursor
				// and its rows belong to the connection they were read from.
				const key = `${conn.provider}|${conn.host}|${conn.database}`;
				if (foldKey.current !== key) {
					foldKey.current = key;
					fold.current = emptyFold();
				}
				const stored = await loadSettings(exec);
				if (!alive) return;
				setSlices(stored);
				// The settings go in FIRST and are used for this load's fold: the
				// team role and the escalation markers decide how every event is
				// classified, and folding the whole history under the defaults and
				// then re-rendering with the real ones would relabel every row.
				const page = await readAllEvents(exec, fold.current.seq);
				if (!alive) return;
				fold.current = foldEvents(fold.current, page, settingsFromSlices(stored));
				setFoldTick((tick) => tick + 1);

				setThreads(await loadThreads(exec));
				setClusters(await loadClusters(exec));
				setGolden(await loadGolden(exec));
				setRuns(await loadRecentRuns(exec, RUN_HISTORY));
				setApproved(await loadApprovedQaByThread(exec));
				setPendingQa(await loadPendingQa(exec));
				setKbDocuments(await loadKbDocuments(exec));
				const stamp = await getMeta(exec, META_LAST_GRADED_AT);
				if (!alive) return;
				const ms = stamp === null ? NaN : Date.parse(stamp);
				setLastGradedAt(Number.isFinite(ms) ? ms : null);
				setLoaded(true);
			} catch {
				// The gateway has already put the reason on `dbError`; the screens
				// show whatever did load and say the database is unreachable.
				if (alive) setLoaded(true);
			}
		})();
		return () => {
			alive = false;
		};
		// `conn` is read for the fold key only — the gateway owns reacting to it.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled, status, exec]);

	// --- The poll -------------------------------------------------------------

	useEffect(() => {
		if (!enabled || status !== 'ready' || !loaded) return;
		const timer = setInterval(() => {
			void pollEvents().catch(() => undefined);
			void pollOthers().catch(() => undefined);
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [enabled, status, loaded, pollEvents, pollOthers]);

	// --- Writes ---------------------------------------------------------------

	const actions = useMemo<DashboardActions>(
		() => ({
			saveSettings: async (slice, value) => {
				const expected = slices[slice]?.version ?? 0;
				const result = await saveSettingsSlice(exec, slice, value, expected, 'dashboard');
				// A conflict is not an error: somebody else's save is the newer
				// truth, so it is loaded and the caller is told what happened.
				await reloadSettings();
				return result.conflict ? SETTINGS_CONFLICT : null;
			},
			saveGrade: async (threadId, grade) => {
				await writeGrade(exec, threadId, grade);
				await reloadThreads();
			},
			applyReview: async (threadId, patch, reviewer, action) => {
				await writeReview(tx, threadId, patch, reviewer, action, Date.now());
				await reloadThreads();
			},
			dismiss: async (threadId, dismissed = true) => {
				await writeDismissed(exec, threadId, dismissed);
				await reloadThreads();
			},
			teach: async (threadId, pair, goldenCase, reviewer) => {
				const now = Date.now();
				// One transaction: the approved pair, its golden case, the review
				// stamp and the audit row are one decision. A reload landing between
				// them would show an answer with no case to prove it keeps working.
				const id = await tx(async (txExec) => {
					const inserted = await insertApprovedQa(txExec, threadId, pair.question, pair.answer, reviewer, now);
					await upsertGolden(txExec, goldenCase);
					// An empty patch: teaching is not a verdict on the miss, so the
					// outcome and the cause are untouched and only the review stamp
					// is written — `approveQa` in `src/eval/review.ts` says why.
					await applyReviewIn(txExec, threadId, {}, reviewer, 'teach', now);
					return inserted;
				});
				await reloadThreads();
				await reloadGolden();
				await reloadQa();
				return {
					id,
					threadId,
					question: pair.question,
					answer: pair.answer,
					approvedBy: reviewer,
					approvedAt: now,
					ingestedAt: null,
				};
			},
			markQaIngested: async (id, objectId, documentName) => {
				// One transaction: the stamp says the answer reached the KB, and the
				// catalog row is what lists it there. Neither without the other.
				await tx(async (txExec) => {
					await writeQaIngested(txExec, id, objectId, documentName);
					await upsertTaughtKbDocument(txExec, id, objectId, documentName);
				});
				await reloadQa();
				await reloadKb();
			},
			addKbDocument: async (document) => {
				await upsertKbDocument(exec, document);
				await reloadKb();
			},
			readKbContent: (objectId) => loadKbContent(exec, objectId),
			saveReplayRun: async (run) => {
				await insertRun(tx, run, false);
				await reloadRuns();
			},
			importReplayRun: async (run) => {
				await insertRun(tx, run, true);
				await reloadRuns();
			},
			upsertCluster: async (id, label, description) => {
				const settled = await writeCluster(exec, id, label, description);
				await reloadClusters();
				return settled;
			},
			setLastGradedAt: async (ms) => {
				await setMeta(exec, META_LAST_GRADED_AT, new Date(ms).toISOString());
				await reloadMeta();
			},
			markReplay: async (threadId, replay = true) => {
				await writeReplay(exec, threadId, replay);
				await reloadThreads();
			},
			poll,
			probeDatabase: async () => {
				try {
					await exec('SELECT 1');
					return null;
				} catch (err) {
					// With the data pipe never started, the statement only says so;
					// the gateway's own error is the database's reason.
					const reason = reasonOf(err);
					return reason === NOT_CONNECTED && error !== null ? error : reason;
				}
			},
		}),
		[exec, tx, error, slices, poll, reloadSettings, reloadThreads, reloadClusters, reloadGolden, reloadRuns, reloadQa, reloadMeta, reloadKb]
	);

	// --- The shape the screens read -------------------------------------------

	const conversations = useMemo(
		() => overlayThreads(fold.current.rows, threads, approved),
		// `foldTick` IS the fold's identity: the state lives in a ref so the poll
		// can read it without re-arming, and the counter is what tells React it
		// moved.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[foldTick, threads, approved]
	);

	const data = useMemo<AppData>(() => {
		if (!enabled) return EMPTY_APP_DATA;
		return {
			version: 1,
			settings,
			// Derived, never stored: every step is a fact about the live system
			// (a saved variable, the ids on the form, a running task, a captured
			// question), and the Bot screen ORs each one with what it can see for
			// itself. `firstQuestion` is the one this layer knows.
			checklist: {
				token: false,
				channels: false,
				role: false,
				start: false,
				firstQuestion: conversations.length > 0,
			},
			// Runtime state, owned by `useBotTask` and resolved from the server.
			taskToken: null,
			captureToken: null,
			conversations,
			quality: {
				lastRun: runs[0] ?? null,
				previousRun: runs[1] ?? null,
				clusters,
				lastGradedAt,
				golden,
			},
			dismissed: threads.filter((state) => state.dismissed).map((state) => state.threadId),
		};
	}, [enabled, settings, conversations, runs, clusters, lastGradedAt, golden, threads]);

	return {
		data,
		loaded: enabled ? loaded : true,
		dbStatus: enabled ? status : 'ready',
		dbError: enabled ? error : null,
		pendingQa,
		kbDocuments,
		actions,
	};
}
