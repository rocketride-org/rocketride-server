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
// QUALITY › REPLAY — the run, its regressions, and the grader
// =============================================================================
//
// THE REPLAY RUN answers "did a change to the bot break an answer that used to
// work". It asks the golden seeds of a PRIVATE COPY of the pipeline the bot runs:
// the copy's source is a webhook rather than Discord, it has no Slack tool and no
// Discord tool, and it runs under its own project id — so a replay NEVER POSTS IN
// DISCORD AND NEVER PAGES SLACK. Everything that decides anything lives in
// `src/eval/replay.ts` and `src/eval/replayCopy.ts`; this file owns the buttons,
// the preflight list, the progress line and the table.
//
// THE PREFLIGHT IS STILL THE GATE, but it guards a different door. It used to
// stand between the user and ten real messages in a real channel; now it stands
// between the user and a run that would quietly do nothing — a judge pipe the
// engine rejects, or a copy it will not start, look identical from the outside.
// Four checks, each with its own sentence.
//
// TWO RUN BUTTONS, because the first seed is the one that tells you whether the
// whole run is worth waiting for: "Run first seed" asks exactly one and takes a
// minute, "Run replay" asks them all and takes several.
//
// THE IMPORT STAYS. A run the harness produced elsewhere is still importable
// (one `{id, question, status, verdict, notes}` object per line), and a run
// driven here is downloadable in the same format plus the extras it knows.
// The two are the same `ReplayRun` shape, which is why the table needs no idea
// where a run came from.
//
// GRADE UNGRADED answers a different question — "how did the bot do on the
// questions real people actually asked" — and is unchanged: it runs the eval
// loop's grader over the captured rows that have gone quiet (`src/eval/grader.ts`).
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DataGrid, monoEl, mutedEl, useShellConnection } from 'shell';
import type { GridColumnDefinition } from 'shell';
import { describeGradeBatch, GRADE_BATCH_LIMIT, runGradeBatch, selectRowsForGrading } from '../../eval/grader';
import { goldenSet, SEED_TOPICS } from '../../eval/golden';
import { describeReplayCopyFor, describeReplayRun, preflight, preflightBlocker, probeReplay, reasonOf, runReplay, runToJsonl, type PreflightCheck, type ReplayProbe, type ReplayProgress } from '../../eval/replay';
import type { DbConnection } from '../../db/config';
import type { DashboardActions } from '../../db/useDashboardData';
import type { AppData, QualityState, ReplayRun, SeedResult, SeedStatus } from '../../state/types';
import { formatAge, formatWhen, SampleBanner, SEED_LABEL } from '../../ui/parts';
import { Btn, Chip, chipEl, DdBanner, DdCard, DdEmpty, PageHeader, StatTile, type Tone } from '../../ui/dd';
import { useToast } from '../../ui/toast';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Why "Run replay" is disabled in sample mode.
 *
 * Still exported under its v1 name — where it held the reason a replay could
 * only ever come from the test harness — because `QualityScreen.tsx` re-exports
 * the symbol and that file is outside this change. Renaming it is a two-line
 * follow-up across the two files.
 */
export const RUN_REPLAY_REASON = 'Turn off Sample data to run a test against a copy of the bot’s pipeline';

/** The grading action's label when nothing is running. */
export const GRADE_LABEL = 'Grade ungraded';

/** The replay action's label when nothing is running. */
export const RUN_REPLAY_LABEL = 'Run test';

/** The one-seed action's label — the cheap look before the long run. */
export const RUN_FIRST_SEED_LABEL = 'Run first seed';

/** The three verdicts a line may carry. */
const SEED_STATUSES: SeedStatus[] = ['pass', 'fail', 'hard_fail'];

// =============================================================================
// CONSTANTS
// =============================================================================

/** Chip tone per seed status: a fail is a failure. */
const SEED_TONE: Record<SeedStatus, Tone> = { pass: 'ok', fail: 'bad', hard_fail: 'bad' };

// =============================================================================
// IMPORT
// =============================================================================

/**
 * Parse a replay JSONL file into seed results.
 *
 * Strict about the fields it needs and explicit about what it rejected: a
 * silently-dropped line would turn a broken export into a quietly wrong
 * quality report.
 *
 * The four fields a run driven by the app adds (`reply`, `escalated`,
 * `copyProjectId`, `retried`) are read when present and absent otherwise, so a
 * file this app wrote round-trips and a file the harness wrote still imports.
 * Keys it does not know — `postedMessageId` and `threadId`, which the runs written
 * before a replay used a private copy carry — are ignored rather than rejected.
 *
 * @param text - The file's contents.
 * @returns The parsed seeds, plus one message per rejected line.
 */
export function parseReplayJsonl(text: string): { seeds: SeedResult[]; problems: string[] } {
	const seeds: SeedResult[] = [];
	const problems: string[] = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			problems.push(`Line ${i + 1}: not valid JSON.`);
			continue;
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			problems.push(`Line ${i + 1}: not a JSON object.`);
			continue;
		}
		const record = parsed as Record<string, unknown>;
		const id = typeof record.id === 'string' ? record.id : '';
		const status = typeof record.status === 'string' ? record.status : '';
		if (id.length === 0) {
			problems.push(`Line ${i + 1}: no "id".`);
			continue;
		}
		if (!SEED_STATUSES.includes(status as SeedStatus)) {
			problems.push(`Line ${i + 1}: "status" is "${status}", expected pass, fail or hard_fail.`);
			continue;
		}
		seeds.push({
			id,
			question: typeof record.question === 'string' ? record.question : '',
			status: status as SeedStatus,
			verdict: typeof record.verdict === 'string' ? record.verdict : '',
			notes: typeof record.notes === 'string' ? record.notes : '',
			reply: typeof record.reply === 'string' ? record.reply : null,
			escalated: record.escalated === true,
			copyProjectId: typeof record.copyProjectId === 'string' ? record.copyProjectId : null,
			retried: record.retried === true,
		});
	}
	return { seeds, problems };
}

/**
 * Seeds that passed on the previous run and do not pass now.
 *
 * Kept here rather than moved to `eval/replay.ts` because the app root imports
 * it for the nav badge (through `QualityScreen`) and reads it from the two
 * PERSISTED runs; `runRegressions` in `eval/replay.ts` is the same rule over a
 * run that has not been stored yet.
 *
 * @param lastRun - The newest run, or null.
 * @param previousRun - The run before it, or null.
 * @returns The regressed seed ids.
 */
export function regressions(lastRun: ReplayRun | null, previousRun: ReplayRun | null): string[] {
	if (lastRun === null || previousRun === null) return [];
	const before = new Map(previousRun.seeds.map((seed) => [seed.id, seed.status]));
	return lastRun.seeds.filter((seed) => seed.status !== 'pass' && before.get(seed.id) === 'pass').map((seed) => seed.id);
}

// =============================================================================
// DOWNLOAD
// =============================================================================

/**
 * Hand the browser the run as a JSONL file.
 *
 * An object URL and a synthetic click, because the app has no server-side export
 * and a `ReplayRun` is a few kilobytes of text.
 *
 * @param run - The run to save.
 */
function downloadRunJsonl(run: ReplayRun): void {
	const blob = new Blob([runToJsonl(run)], { type: 'application/x-ndjson' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = run.fileName;
	link.rel = 'noopener';
	link.click();
	URL.revokeObjectURL(url);
}

// =============================================================================
// PREFLIGHT ROW
// =============================================================================

/**
 * One preflight check, as a line.
 *
 * @param props.check - The check to render.
 * @returns The row.
 */
const CheckChip: React.FC<{ check: PreflightCheck }> = ({ check }) => (
	<Chip tone={check.ok ? 'ok' : check.pending ? 'neutral' : 'bad'} title={check.ok ? 'OK' : check.reason}>
		{check.label}
	</Chip>
);

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link ReplayTab}. */
export interface ReplayTabProps {
	/** Everything the screens render. */
	data: AppData;
	/** The database writes: a stored run, an imported run, a grade. */
	actions: DashboardActions;
	/** The quality slice to render: the sample pair in sample mode, else the real one. */
	quality: QualityState;
	/** Sample data is on: labelled rows, every action disabled. */
	sampleMode: boolean;
	/**
	 * Where the dashboard database is.
	 *
	 * Used for ONE thing: the replay copy is built from the pipeline the bot
	 * really runs, capture component included, so the removal and the
	 * isolation guard are exercised on the real document rather than on one
	 * that never had capture in it.
	 */
	conn: DbConnection;
	/** Why a write cannot run, or null. */
	writesBlocked: string | null;
	/**
	 * Whether this tab is the one showing. The seed grid only renders while it
	 * is: a grid laid out inside a hidden tab measures every column at zero.
	 */
	active?: boolean;
	/** The Quality tabs, rendered under the page header. */
	nav?: React.ReactNode;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Replay tab.
 *
 * @param props - See {@link ReplayTabProps}.
 * @returns The tab.
 */
export const ReplayTab: React.FC<ReplayTabProps> = ({ data, actions, quality, sampleMode, conn, writesBlocked, nav, active = true }) => {
	const toast = useToast();
	const { client, isConnected } = useShellConnection();
	const fileInput = useRef<HTMLInputElement>(null);
	const [importError, setImportError] = useState<string | null>(null);
	// The grading batch: null when idle, {done,total} while it runs. One batch at
	// a time — the grader task is shared and its prompt node is stateful.
	const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

	// --- The replay run -------------------------------------------------------

	/**
	 * What the engine-side preflight learned, or null before it has run.
	 *
	 * Two of the four checks are engine answers — the judge pipe validates, and the
	 * copy validates AND starts — so until this is filled they sit grey rather than
	 * claiming either outcome.
	 */
	const [probe, setProbe] = useState<ReplayProbe | null>(null);
	/** A probe is in flight. */
	const [probing, setProbing] = useState(false);
	/** The run in flight, or null when nothing is running. */
	const [run, setRun] = useState<ReplayProgress | null>(null);
	/** Ticks the elapsed clock while a run is in flight. */
	const [clock, setClock] = useState(Date.now());
	/**
	 * Stop was pressed.
	 *
	 * The ref is what the RUNNER reads (it closed over it once, and a ref is the
	 * only thing a closure can see change); the state is what the BUTTON reads,
	 * because a ref mutation renders nothing and the control would otherwise go on
	 * offering a Stop that had already happened.
	 */
	const [stopping, setStopping] = useState(false);

	/** Set by Stop; read by the runner between seeds. */
	const stopRequested = useRef(false);

	const lastRun = quality.lastRun;
	const previousRun = quality.previousRun;
	const regressed = useMemo(() => regressions(lastRun, previousRun), [lastRun, previousRun]);
	const now = Date.now();

	/** The cases a run would ask: the vendored seeds plus what review taught. */
	const cases = useMemo(() => goldenSet(data.quality.golden), [data.quality.golden]);

	/**
	 * What the copy a run would start is.
	 *
	 * Pure and local — the copy is built from the saved settings, so this needs no
	 * engine and is correct the moment the tab opens. Null when the copy cannot be
	 * built at all, which the `copy` preflight row then explains.
	 */
	const copyDescription = useMemo(() => describeReplayCopyFor(data.settings, conn), [data.settings, conn]);

	// A probe is about ONE copy. Choosing a different pipe in Settings builds a
	// different one, so the two engine-side rows go back to grey rather than
	// claiming a result that was true of the pipe before.
	const pipeChoice = data.settings.pipeline.pipe;
	useEffect(() => {
		setProbe(null);
	}, [pipeChoice]);

	// The elapsed clock, armed only while a run is in flight.
	useEffect(() => {
		if (run === null) return;
		const timer = setInterval(() => setClock(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [run]);

	/**
	 * The preflight rows, for a given probe result.
	 *
	 * Taken as arguments rather than read from state so the run can evaluate the
	 * checks against a probe it has just made, in the same tick, without waiting
	 * for React to commit it.
	 */
	const checksFor = useCallback(
		(withProbe: ReplayProbe | null): PreflightCheck[] =>
			preflight({
				connected: isConnected && client !== null,
				goldenCount: cases.length,
				probe: withProbe,
			}),
		[isConnected, client, cases.length]
	);

	const checks = useMemo(() => checksFor(probe), [checksFor, probe]);

	// --- Import ---------------------------------------------------------------

	/** Read the picked file, parse it, and make it the newest run. */
	async function handleFile(file: File): Promise<void> {
		setImportError(null);
		let text: string;
		try {
			text = await file.text();
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			setImportError(`Could not read ${file.name}: ${reason}`);
			toast.error(`Could not read ${file.name}.`);
			return;
		}
		const { seeds, problems } = parseReplayJsonl(text);
		if (seeds.length === 0) {
			const detail = problems.length > 0 ? problems.slice(0, 3).join(' ') : 'The file had no usable lines.';
			setImportError(`Nothing imported from ${file.name}. ${detail}`);
			toast.error(`Nothing imported from ${file.name}.`);
			return;
		}
		const imported: ReplayRun = { importedAt: Date.now(), fileName: file.name, seeds };
		// A run is a ROW now, not a slot: the import appends it and "this run
		// and the one before it" is `ORDER BY recorded_at DESC LIMIT 2`. The old
		// shape had to spread `prev.quality` to keep the clusters and the golden
		// set from being thrown away by an import; they are their own tables, so
		// an import cannot reach them at all.
		if (writesBlocked !== null) {
			setImportError(writesBlocked);
			toast.error(`${writesBlocked}. The run was not stored.`);
			return;
		}
		try {
			await actions.importReplayRun(imported);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			setImportError(`Could not store the run: ${reason}`);
			toast.error(`Could not store the run: ${reason}`);
			return;
		}
		if (problems.length > 0) {
			setImportError(`Imported ${seeds.length} of ${seeds.length + problems.length} lines. Skipped: ${problems.slice(0, 3).join(' ')}`);
			toast.error(`Imported ${seeds.length} seeds; ${problems.length} lines were skipped.`);
			return;
		}
		toast.success(`Imported ${seeds.length} seeds from ${file.name}.`);
	}

	// --- The replay run -------------------------------------------------------

	/**
	 * Ask the engine the two questions the browser cannot answer.
	 *
	 * Validates `eval-judge.pipe`, builds the copy, runs it past the isolation
	 * guard, validates it and starts it — then terminates it again, because the run
	 * starts its own. Nothing is posted anywhere: the copy has no way to post.
	 *
	 * @returns What it learned, or null when there is no connection.
	 */
	const runProbe = useCallback(async (): Promise<ReplayProbe | null> => {
		if (!client || !isConnected) return null;
		setProbing(true);
		try {
			const learned = await probeReplay(client, data.settings, conn);
			setProbe(learned);
			return learned;
		} finally {
			setProbing(false);
		}
	}, [client, isConnected, data.settings, conn]);

	/** Check the preflight without running anything. */
	async function handleProbe(): Promise<void> {
		const learned = await runProbe();
		if (learned === null) {
			toast.error('Not connected to the engine.');
			return;
		}
		const blocker = preflightBlocker(checksFor(learned));
		if (blocker === null) toast.success('Ready: the private copy starts and the judge is valid.');
		else toast.error(blocker);
	}

	/**
	 * Ask the seeds, judge the answers, and store the run.
	 *
	 * @param limit - Ask only the first N cases. Omitted asks them all.
	 */
	async function handleRun(limit?: number): Promise<void> {
		if (!client || !isConnected || sampleMode || run !== null) return;
		stopRequested.current = false;
		setStopping(false);

		// The probe first: two of the four checks cannot be answered without it, and
		// a run that cannot start its copy must say so before it claims to have run.
		const learned = probe ?? (await runProbe());
		if (learned === null) {
			toast.error('Not connected to the engine.');
			return;
		}
		const blocker = preflightBlocker(checksFor(learned));
		if (blocker !== null) {
			toast.error(blocker);
			return;
		}

		setClock(Date.now());
		try {
			const result = await runReplay({
				client,
				cases,
				settings: data.settings,
				previousRun: data.quality.lastRun,
				limit,
				onProgress: setRun,
				shouldStop: () => stopRequested.current,
				conn,
			});
			// Stored even when the run stopped early: "six of ten ran" is a more
			// useful record than none, and the run before it is simply the next
			// row down.
			await actions.saveReplayRun(result.run);
			const summary = describeReplayRun(result.run);
			if (result.error !== null) toast.error(`Test stopped: ${result.error} ${summary}`);
			else if (result.stopped) toast.success(`Test stopped after ${result.run.seeds.length} seeds. ${summary}`);
			else if ((result.run.regressions ?? []).length > 0 || (result.run.hardFails ?? 0) > 0) {
				toast.error(`Test finished: ${summary}`);
			} else toast.success(`Test finished: ${summary}`);
		} catch (err) {
			toast.error(`Test failed: ${reasonOf(err)}`);
		} finally {
			setRun(null);
			stopRequested.current = false;
			setStopping(false);
		}
	}

	/** Why the replay action cannot act, or null when it can. */
	const runBlocked = sampleMode
		? RUN_REPLAY_REASON
		: !isConnected || !client
			? 'Not connected to the engine'
			: // A run that cannot be STORED is a run whose result is lost the
				// moment the tab is closed, so the database counts as a precondition.
				(writesBlocked ?? preflightBlocker(checks.filter((check) => !check.pending)));

	// --- Grading --------------------------------------------------------------

	/**
	 * How many rows one click would grade.
	 *
	 * The same pure selector the batch itself runs, so the button's title and the
	 * work it does can never disagree. Recomputed per render because `now` moves:
	 * a row becomes gradeable simply by staying quiet.
	 */
	const gradeable = sampleMode
		? []
		: selectRowsForGrading(data.conversations, {
				now,
				quietHours: data.settings.eval.quietHours,
				ignoreQuiet: data.settings.eval.gradeNowIgnoresQuiet,
				limit: GRADE_BATCH_LIMIT,
			});

	/** Run one batch and report what it did. */
	async function handleGrade(): Promise<void> {
		if (!client || !isConnected || progress !== null) return;
		setProgress({ done: 0, total: gradeable.length });
		try {
			const result = await runGradeBatch({
				client,
				data,
				actions,
				now: Date.now(),
				limit: GRADE_BATCH_LIMIT,
				onProgress: (done, total) => setProgress({ done, total }),
			});
			const summary = describeGradeBatch(result);
			// An engine failure mid-batch keeps the grades already written, so the
			// counts are still worth reporting — with the reason beside them.
			if (result.error !== null) {
				toast.error(`Grading stopped: ${result.error} ${summary}`);
				return;
			}
			if (result.graded + result.excluded + result.failed === 0) {
				toast.success('Nothing to grade — no open row has been quiet long enough.');
				return;
			}
			if (result.failed > 0) toast.error(summary);
			else toast.success(summary);
		} catch (err) {
			toast.error(`Grading failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setProgress(null);
		}
	}

	/** Why the grading action cannot act, or null when it can. */
	const gradeBlocked = sampleMode ? 'Turn off Sample data to grade real rows' : !isConnected || !client ? 'Not connected to the engine' : writesBlocked !== null ? writesBlocked : gradeable.length === 0 ? 'No open row has been quiet long enough yet — see Settings › Eval › Quiet Hours' : null;

	// --- Columns --------------------------------------------------------------

	const columns = useMemo(
		() =>
			[
				{
					title: 'Seed',
					field: 'id',
					rrType: 'string',
					rrDefault: true,
					rrDefaultSort: 'asc',
					rrDescription: 'Stable seed id — what a regression is keyed on across runs.',
					width: 120,
					headerSort: true,
					formatter: (cell) => monoEl(String(cell.getValue() ?? '')),
				},
				{
					title: 'Question',
					field: 'question',
					rrType: 'string',
					rrDefault: true,
					rrDescription: 'The seed question the test posted.',
					headerSort: false,
					formatter: (cell) => mutedEl(String(cell.getValue() ?? '')),
				},
				{
					title: 'This run',
					field: 'status',
					rrType: 'enum',
					rrDefault: true,
					rrOptions: SEED_STATUSES.map((status) => ({ value: status, label: SEED_LABEL[status] })),
					rrDescription: 'This run’s grade for the seed.',
					width: 130,
					headerSort: true,
					formatter: (cell) => {
						const status = String(cell.getValue() ?? 'fail') as SeedStatus;
						return chipEl(SEED_TONE[status] ?? 'neutral', SEED_LABEL[status] ?? status);
					},
				},
				{
					title: 'Previous',
					field: 'previousStatus',
					rrType: 'enum',
					rrDefault: true,
					rrDescription: 'The same seed’s grade on the run before this one, side by side.',
					width: 130,
					headerSort: true,
					formatter: (cell) => {
						const value = cell.getValue();
						if (typeof value !== 'string' || value.length === 0) return mutedEl('—');
						const status = value as SeedStatus;
						return chipEl(SEED_TONE[status] ?? 'neutral', SEED_LABEL[status] ?? status);
					},
				},
				{
					title: 'Verdict',
					field: 'verdict',
					rrType: 'string',
					rrDefault: true,
					rrDescription: 'The judge’s one-line verdict. “partial” is not a pass.',
					width: 180,
					headerSort: false,
					formatter: (cell) => mutedEl(String(cell.getValue() ?? '')),
				},
				{
					title: 'Judge notes',
					field: 'notes',
					rrType: 'string',
					rrDescription: 'The judge’s full notes. Hidden by default — turn it on from the columns menu.',
					headerSort: false,
					formatter: (cell) => mutedEl(String(cell.getValue() ?? '')),
				},
				{
					title: 'Escalated',
					field: 'escalationLabel',
					rrType: 'string',
					rrDescription: 'Whether the bot escalated instead of answering. Hidden by default — turn it on from the columns menu.',
					width: 110,
					headerSort: true,
					formatter: (cell) => mutedEl(String(cell.getValue() ?? '')),
				},
				{
					title: 'Reply',
					field: 'reply',
					rrType: 'string',
					rrDescription: 'What the bot actually posted. Only a run driven here has this; an import does not. Hidden by default.',
					headerSort: false,
					formatter: (cell) => mutedEl(String(cell.getValue() ?? '')),
				},
				{
					title: 'Topic',
					field: 'topic',
					rrType: 'string',
					rrDescription: 'The seed table’s own topic column, for the ten vendored seeds. Hidden by default.',
					width: 150,
					headerSort: true,
					formatter: (cell) => mutedEl(String(cell.getValue() ?? '')),
				},
			] satisfies GridColumnDefinition[],
		[]
	);

	/**
	 * The seeds the table renders.
	 *
	 * The RUN IN FLIGHT wins over the stored run, so the rows fill in live; once
	 * it finishes, the stored run is the same data and the table does not blink.
	 */
	const shownSeeds = run !== null ? run.seeds : (lastRun?.seeds ?? []);

	/**
	 * The run the one on screen is measured against.
	 *
	 * While a run is IN FLIGHT that is the stored `lastRun`, not `previousRun`:
	 * the run filling the table has not been stored yet, so the newest stored run
	 * is still the one before it. Reading `previousRun` here would compare the
	 * live run against the run two back and report regressions that are a week
	 * stale — which is also what the stored run's own `regressions` would then
	 * disagree with, since `runReplay` is handed `quality.lastRun`.
	 */
	const baseline = run !== null ? lastRun : previousRun;

	const rows = useMemo(() => {
		const before = new Map((baseline?.seeds ?? []).map((seed) => [seed.id, seed.status]));
		return shownSeeds.map((seed) => ({
			...seed,
			previousStatus: before.get(seed.id) ?? '',
			escalationLabel: seed.escalated === true ? 'yes' : seed.reply ? 'no' : '—',
			topic: SEED_TOPICS[seed.id] ?? '',
		}));
	}, [shownSeeds, baseline]);

	const passed = shownSeeds.filter((s) => s.status === 'pass').length;
	const failed = shownSeeds.filter((s) => s.status === 'fail').length;
	const hardFailed = shownSeeds.filter((s) => s.status === 'hard_fail').length;
	/**
	 * Regressions of the run on screen.
	 *
	 * Computed from the seeds and the baseline while a run is in flight, so the
	 * count rises as it goes; the stored run's `regressed` once it is stored. Both
	 * are the same rule — see `regressions` above and `runRegressions` in
	 * `src/eval/replay.ts`.
	 */
	const shownRegressions = useMemo(() => {
		if (run === null) return regressed;
		const before = new Map((baseline?.seeds ?? []).map((seed) => [seed.id, seed.status]));
		return shownSeeds.filter((seed) => seed.status !== 'pass' && before.get(seed.id) === 'pass').map((seed) => seed.id);
	}, [run, regressed, baseline, shownSeeds]);

	const lastGradedAt = sampleMode ? null : (quality.lastGradedAt ?? null);

	/** The elapsed line while a run is in flight. */
	const elapsed = run === null ? '' : `${Math.max(0, Math.round((clock - run.startedAt) / 1000))} s`;

	/** The action card's controls. Named for what it is, so the data-layer
	 *  `actions` prop and this JSX cannot shadow each other. Same buttons, same
	 *  handlers: Run replay is the page's one primary; Import and Download are
	 *  quiet, on the right. */
	const headerControls = (
		<div className="dd-row" style={{ width: '100%' }}>
			{run === null ? (
				<>
					<Btn variant="primary" icon="play" onClick={() => void handleRun()} disabled={runBlocked !== null || probing} title={runBlocked ?? `Ask the private copy all ${cases.length} seed question${cases.length === 1 ? '' : 's'}, one at a time. Nothing is posted in Discord.`}>
						{`${RUN_REPLAY_LABEL} (${cases.length} case${cases.length === 1 ? '' : 's'})`}
					</Btn>
					{/* The cheap look before the long wait: one seed proves the copy
					    answers at all, and costs one question instead of ten. */}
					<Btn onClick={() => void handleRun(1)} disabled={runBlocked !== null || probing || cases.length === 0} title={runBlocked ?? `Ask only ${cases[0]?.id ?? 'the first seed'} — the quick check that the copy answers at all`}>
						{RUN_FIRST_SEED_LABEL}
					</Btn>
					<Btn onClick={() => void handleProbe()} disabled={sampleMode || !isConnected || !client || probing} title={sampleMode ? RUN_REPLAY_REASON : 'Validate the judge pipeline, build the private copy and start it once. Nothing is posted in Discord.'}>
						{probing ? 'Checking…' : 'Check preflight'}
					</Btn>
				</>
			) : (
				<Btn
					variant="danger"
					icon="stop"
					onClick={() => {
						stopRequested.current = true;
						setStopping(true);
					}}
					disabled={stopping}
					title="Stop after the seed that is running — the question already asked is still waited for and scored"
				>
					{stopping ? 'Stopping…' : 'Stop'}
				</Btn>
			)}
			<Btn icon="gauge" onClick={() => void handleGrade()} disabled={gradeBlocked !== null || progress !== null || run !== null} title={progress !== null ? 'A grading batch is running' : (gradeBlocked ?? `Grade the ${gradeable.length} open row${gradeable.length === 1 ? '' : 's'} that have gone quiet`)}>
				{progress === null ? GRADE_LABEL : `Grading ${progress.done} / ${progress.total}…`}
			</Btn>
			<span className="dd-spacer" />
			<Btn variant="ghost" icon="upload" onClick={() => fileInput.current?.click()} disabled={sampleMode || run !== null} title={sampleMode ? 'Turn off Sample data to import a run' : 'Import a test JSONL file'}>
				Import test results
			</Btn>
			<Btn variant="ghost" icon="download" onClick={() => lastRun !== null && downloadRunJsonl(lastRun)} disabled={lastRun === null || run !== null} title={lastRun === null ? 'No run to download yet' : 'Save this run as JSONL — one line per seed, importable again'}>
				Download run JSONL
			</Btn>
		</div>
	);

	/** The preflight, as a row of chips — always on screen, because it is the gate. */
	const failing = checks.filter((check) => !check.ok);
	const preflightRow = (
		<div className="dd-stack" style={{ gap: 10 }}>
			<div className="dd-row" style={{ gap: 8 }}>
				{!sampleMode && checks.map((check) => <CheckChip key={check.id} check={check} />)}
				<span className="dd-caption">{lastGradedAt === null ? 'Never graded' : `Last graded ${formatAge(lastGradedAt, now)}`}</span>
			</div>
			{!sampleMode && failing.length > 0 && (
				<ul className="dd-eventlog">
					{failing.map((check) => (
						<li key={check.id}>
							<strong className="dd-strong">{check.label}:</strong> {check.reason}
						</li>
					))}
				</ul>
			)}
			{!sampleMode && (
				<p className="dd-caption" style={{ margin: 0 }}>
					A test asks {cases.length} seed question{cases.length === 1 ? '' : 's'} of a private copy of the pipeline the bot runs, one at a time, and reads each answer straight off the result. <strong className="dd-strong">It never posts in Discord and it never pages Slack</strong> — the copy’s source is a webhook instead of the Discord bot, its Slack and Discord tools are removed, and it runs under its own project id. Every check has to pass first.
					{copyDescription !== null && ` The copy: project ${copyDescription.projectId.slice(0, 8)}… · source ${copyDescription.source} · ${copyDescription.componentCount} components · no Discord source, no Slack tool.`}
				</p>
			)}
		</div>
	);

	/** The progress line, only while a run is in flight. */
	const progressPanel =
		run === null ? null : (
			<DdBanner variant="info">
				{run.phase === 'done' || run.phase === 'settled' ? `${run.done} of ${run.total} seeds done · ${elapsed} elapsed` : `Seed ${Math.min(run.done + 1, run.total)} of ${run.total} · ${run.phase === 'starting' ? 'starting the private copy' : run.phase === 'retrying' ? 'the answer was not usable — asking once more' : run.phase === 'judging' ? 'judging the reply' : 'waiting for the copy to answer'} · ${elapsed} elapsed${run.current === null ? '' : ` · ${run.current.id}`}`}
				{stopping ? ' · stopping after this seed' : ''}
			</DdBanner>
		);

	return (
		<div className="dd-page">
			<PageHeader title="Quality" subtitle="Ask a private copy of Ralph the golden questions and see what got better or worse. Nothing is posted in Discord." />
			{nav}
			{sampleMode && <SampleBanner />}

			<input
				ref={fileInput}
				type="file"
				accept=".jsonl,.json,.txt,application/json"
				style={{ display: 'none' }}
				onChange={(e) => {
					const file = e.target.files?.[0];
					// Reset the input so picking the same file twice still fires.
					e.target.value = '';
					if (file) void handleFile(file);
				}}
			/>

			{/* The action card: the run, the gate, the grading. */}
			<DdCard>
				<div className="dd-stack" style={{ gap: 14, paddingTop: 6 }}>
					{headerControls}
					{preflightRow}
				</div>
			</DdCard>

			{/* ERROR state: what the import rejected, and why. */}
			{importError !== null && <DdBanner variant="error">{importError}</DdBanner>}
			{progressPanel}

			{lastRun === null && run === null ? (
				/* EMPTY */
				<DdCard>
					<DdEmpty icon="play" title="No test yet" description={`Ask the ${cases.length} golden seeds of a private copy of the bot’s pipeline — nothing is posted in Discord and nobody is paged — or import the JSONL a harness wrote, one {id, question, status, verdict, notes} object per line. ${GRADE_LABEL} does not need a test run: it grades the captured conversations that have gone quiet.`} />
				</DdCard>
			) : (
				<>
					{/* POPULATED — the numbers first. */}
					<div className="dd-stats">
						<StatTile label="Passed" value={passed} tone="ok" />
						<StatTile label="Failed" value={failed} tone="bad" />
						<StatTile label="Hard fails" value={hardFailed} tone="bad" />
						<StatTile label="Regressions" value={shownRegressions.length} tone={shownRegressions.length > 0 ? 'bad' : undefined} note={previousRun !== null ? `vs ${previousRun.fileName}` : 'no previous run'} />
					</div>
					{shownRegressions.length > 0 && <DdBanner variant="warning">{shownRegressions.length === 1 ? `${shownRegressions[0]} passed last run and does not now.` : `${shownRegressions.length} seeds passed last run and do not now: ${shownRegressions.join(', ')}.`}</DdBanner>}

					<div style={{ height: 420, display: 'flex', flexDirection: 'column' }}>
						<DdCard
							title={run === null ? 'Last test' : 'Test in progress'}
							actions={
								lastRun !== null && run === null ? (
									<span className="dd-caption">
										{lastRun.fileName} · {formatWhen(lastRun.importedAt)}
										{lastRun.startedAt !== undefined && lastRun.finishedAt !== undefined ? ` · took ${Math.max(1, Math.round((lastRun.finishedAt - lastRun.startedAt) / 1000))} s` : ''}
										{lastRun.stoppedEarly === true ? ' · stopped early' : ''}
										{previousRun !== null ? ` · compared with ${previousRun.fileName} from ${formatWhen(previousRun.importedAt)}` : ' · no previous run to compare with'}
									</span>
								) : undefined
							}
							flush
							fill
						>
							{active && <DataGrid<SeedResult & { previousStatus: string }> columns={columns} data={rows} tableId="discord-dashboard-quality" paginate={false} height="100%" emptyTitle={run === null ? 'No seeds in this run' : 'Nothing scored yet'} emptyDescription={run === null ? 'The imported file had no usable lines.' : 'The first seed has been asked; its row appears once the copy answers or the wait runs out.'} />}
						</DdCard>
					</div>
				</>
			)}
		</div>
	);
};
