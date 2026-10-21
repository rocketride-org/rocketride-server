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
// APP CHECK — the check_app tool, the app checker and Monaco's type reader
// =============================================================================

/**
 * `check_app` runs the full check on one app and reports what it saw, step by
 * step, to the model and, through the listener its host passes in, to the run.
 * It is the only check tool: saving a pipeline validates it, and the model
 * tests a pipeline by running it.
 *
 * In order, this file holds the report a check leaves behind, the type reader
 * (Monaco's markers), the types note a save of an app file appends, the app
 * checker (types, then a rebuild in the Design preview), and the tool.
 */

import type { AppErrorRow, ConsoleRow, WatchStatus } from '../../../tools/appdev/types';
import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import type { AgentDevSession, AgentHost } from '../host';
import { AgentTool, AgentToolkit } from '../tools';
import { brief, clip, messageOf } from './common';
import { findApp, readApps } from './inventory';
import type { AppEntry } from './inventory';

// =============================================================================
// CHECK REPORT — the evidence a check leaves behind
// =============================================================================

/** How one check step ended. */
export type CheckStatus = 'pass' | 'fail' | 'not_run';

/** What one check step ran and saw. */
export interface CheckEvidence {
	/** Step name, such as 'types' or 'build'. */
	step: string;
	/** What was run, as a short phrase. */
	ran: string;
	/** The raw output the step produced. */
	output: string;
	/** How the step ended. */
	status: CheckStatus;
	/** One line the model can act on. */
	summary: string;
}

/** The evidence from checking one app. */
export interface CheckReport {
	/** The app's manifest id, or its folder when it has none. */
	target: string;
	/** One entry per step, in the order they ran. */
	evidence: CheckEvidence[];
}

/**
 * Whether a report counts as passing. A step that did not run is not a
 * failure; only a step that ran and failed is.
 *
 * @param report - The report to judge.
 * @returns True when no evidence has status 'fail'.
 */
export function reportPassed(report: CheckReport): boolean {
	return report.evidence.every((e) => e.status !== 'fail');
}

/**
 * Indents every line of a block by two spaces.
 *
 * @param text - The block to indent.
 * @returns The indented block.
 */
function indent(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => `  ${line}`)
		.join('\n');
}

/**
 * Writes a report as the tool result: a verdict line, then each step with
 * its output indented below. A step with no output shows its summary there,
 * so a step that did not run still says why.
 *
 * @param report - The report to write out.
 * @returns The result text.
 */
function formatReport(report: CheckReport): string {
	const lines = [`CHECK ${reportPassed(report) ? 'PASSED' : 'FAILED'}: ${report.target}`];
	for (const e of report.evidence) {
		lines.push(`- [${e.status}] ${e.step}: ran ${e.ran}`);
		const body = e.output.trim() || e.summary.trim();
		if (body) lines.push(indent(body));
	}
	return lines.join('\n');
}

// =============================================================================
// TYPE READER — type errors read from Monaco's markers
// =============================================================================

/**
 * The type half of an app check. An open app's dev session loads every file of
 * the app as a Monaco model at `file:///${appId}/${relPath}`, and Monaco's
 * TypeScript service keeps its type errors for each model as markers. This
 * reads those markers, so it costs no build and no extra compiler.
 *
 * What counts as what, because a check that wrongly passes lets the agent claim
 * the app is typed and one that cannot pass leaves it stuck:
 *
 * - Only markers with owner `typescript` and severity Error count. Warnings
 *   are not failures, and the `rr-appdev` markers are link errors a build sets,
 *   which the build evidence reports.
 * - An app with no models (it is not open) is `not_run`: no models means no
 *   markers, and that is not the same as no errors.
 * - A file with no model is named in the output and the summary counts it, so
 *   a clean result never hides a file nobody looked at.
 *
 * Monaco validates a model some time after it changes (a 500 ms debounce, then
 * a round trip to the TypeScript worker, with no "done" signal), so
 * `settleMarkers` first waits for the worker to be up and hold the models, then
 * for the markers to go quiet, before a caller reads them. A model with no
 * markers yet looks exactly like a model with no errors; reading too early is
 * the false pass this reader exists to avoid.
 *
 * `monacoMarkerSource` is the only browser-only code here; everything else runs
 * against a `MarkerSource`, so tests pass a fake and never load Monaco.
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/** The owner of Monaco's TypeScript diagnostics. */
const TYPESCRIPT_OWNER = 'typescript';

/** Monaco's `MarkerSeverity.Error`, kept here so the tests need no Monaco. */
const SEVERITY_ERROR = 8;

/**
 * How long the markers must be quiet before they count as settled, in milliseconds.
 * Longer than Monaco's 500 ms validation debounce, so a quiet window that opens
 * just after an edit still outlasts the validation that edit starts.
 */
const DEFAULT_QUIET_MS = 1500;

/** The longest `settleMarkers` waits, in milliseconds, however often the markers change or the worker is slow. */
const DEFAULT_MAX_MS = 10_000;

/** The step name in the evidence. */
const TYPES_STEP = 'types';

/** What the types step does, as a short phrase. */
const TYPES_RAN = "read the TypeScript errors Monaco keeps for the app's open files";

/** The summary for an app that has no models. */
const NOT_OPEN_SUMMARY = 'types not checked until the app is open or deployed';

/** What the output says for an app that has no models. */
const NOT_OPEN_OUTPUT = "None of the app's TypeScript files are loaded in the editor, so there are no TypeScript errors to read. Open the app, or deploy it, to check its types.";

// =============================================================================
// TYPES
// =============================================================================

/** One diagnostic Monaco holds for a model. */
export interface MarkerInfo {
	/** The model uri, unencoded (`file:///${appId}/${relPath}` for an app file). */
	uri: string;
	/** The 1-based line the diagnostic starts on. */
	line: number;
	/** The diagnostic text. */
	message: string;
	/** Monaco's `MarkerSeverity` (8 is an error). */
	severity: number;
	/** What set the marker (`typescript` for type errors, `rr-appdev` for link errors). */
	owner: string;
}

/** Where the models and markers come from: Monaco in the browser, a fake in tests. */
export interface MarkerSource {
	/** The uri of every model that is loaded. */
	modelUris(): string[];
	/** Every marker Monaco holds, for every model. */
	markers(): MarkerInfo[];
	/**
	 * Calls a listener whenever any marker changes.
	 *
	 * @param listener - Called on each change.
	 * @returns A function that stops the calls.
	 */
	onChange(listener: () => void): () => void;
	/**
	 * Resolves once validation can start: the TypeScript worker is up and holds
	 * the models. A source with nothing to wait for leaves it out.
	 *
	 * @returns A promise that resolves when the markers can begin to arrive.
	 */
	ready?(): Promise<void>;
}

// =============================================================================
// MONACO SOURCE
// =============================================================================

/** The `monaco.languages.typescript` members this file drives (the typings only declare a stub). */
interface MonacoTypescriptWorkers {
	getTypeScriptWorker(): Promise<(...uris: unknown[]) => Promise<unknown>>;
}

/**
 * The marker source backed by the real Monaco. Browser only: it loads Monaco
 * (and wires its workers) the first time, so it is imported lazily and the
 * rest of this file stays loadable under the test runner.
 *
 * `ready()` asks the TypeScript worker for every TypeScript model. Asking is
 * what starts the worker on a cold page and copies those models into it, and
 * Monaco validates a model only once the worker has it. It covers every open
 * app's TypeScript models, not only the one being checked.
 *
 * @returns A marker source over every model and marker Monaco holds.
 */
export async function monacoMarkerSource(): Promise<MarkerSource> {
	const { loadMonaco } = await import('../../../components/monaco/loader');
	const monaco = await loadMonaco();
	return {
		// step: skipEncoding keeps the uri as `file:///${appId}/${relPath}`, even for names that need escaping
		modelUris: () => monaco.editor.getModels().map((model) => model.uri.toString(true)),
		markers: () =>
			monaco.editor.getModelMarkers({}).map((m) => ({
				uri: m.resource.toString(true),
				line: m.startLineNumber,
				message: m.message,
				severity: m.severity,
				owner: m.owner,
			})),
		onChange: (listener) => {
			const subscription = monaco.editor.onDidChangeMarkers(() => listener());
			return () => subscription.dispose();
		},
		ready: async () => {
			const getWorker = await (monaco.languages.typescript as unknown as MonacoTypescriptWorkers).getTypeScriptWorker();
			const uris = monaco.editor
				.getModels()
				.filter((model) => model.getLanguageId() === 'typescript')
				.map((model) => model.uri);
			await getWorker(...uris);
		},
	};
}

// =============================================================================
// SETTLE
// =============================================================================

/**
 * Waits for Monaco to finish validating. Validation starts after a debounce and
 * a trip to the TypeScript worker, and gives no "done" signal. So this waits for
 * the source to be `ready` (the worker is up and holds the models), then counts
 * the markers as settled once none has changed for `quietMs`. A slow worker or a
 * file that keeps changing is cut off at `maxMs`, and a `ready` that fails is
 * skipped: the quiet window still applies.
 *
 * @param src - The marker source.
 * @param opts - `quietMs` (default 1500) and `maxMs` (default 10 000, for the whole wait).
 * @returns A promise that resolves when the markers are quiet or the cap is reached.
 */
function settleMarkers(src: MarkerSource, opts: { quietMs?: number; maxMs?: number } = {}): Promise<void> {
	const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
	const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
	return new Promise((resolve) => {
		let quiet: ReturnType<typeof setTimeout> | undefined;
		let windowOpen = false;
		let finished = false;
		const cap = setTimeout(done, maxMs);
		const restart = (): void => {
			clearTimeout(quiet);
			quiet = setTimeout(done, quietMs);
		};
		const stop = src.onChange(() => {
			// step: a change while the worker is still starting says nothing yet; the window opens when it is ready
			if (windowOpen) restart();
		});
		function done(): void {
			finished = true;
			clearTimeout(quiet);
			clearTimeout(cap);
			stop();
			resolve();
		}
		const open = (): void => {
			if (finished) return;
			windowOpen = true;
			restart();
		};
		Promise.resolve()
			.then(() => src.ready?.())
			.then(open, open);
	});
}

// =============================================================================
// READING
// =============================================================================

/**
 * The uri prefix of an app's models.
 *
 * @param appId - The app id.
 * @returns `file:///${appId}/`; the closing slash keeps `app` apart from `app-two`.
 */
function prefixOf(appId: string): string {
	return `file:///${appId}/`;
}

/**
 * Whether a marker is a TypeScript error.
 *
 * @param marker - The marker.
 * @returns True for owner `typescript` at severity Error.
 */
function isTypeError(marker: MarkerInfo): boolean {
	return marker.owner === TYPESCRIPT_OWNER && marker.severity === SEVERITY_ERROR;
}

/**
 * The TypeScript errors in one file.
 *
 * @param src - The marker source.
 * @param appId - The app id.
 * @param relPath - The file path inside the app (for example `src/App.tsx`).
 * @returns The file's TypeScript errors, in the order Monaco holds them.
 */
function fileTypeErrors(src: MarkerSource, appId: string, relPath: string): MarkerInfo[] {
	const uri = `${prefixOf(appId)}${relPath}`;
	return src.markers().filter((m) => m.uri === uri && isTypeError(m));
}

/**
 * The TypeScript errors across every model of an app.
 *
 * @param src - The marker source.
 * @param appId - The app id.
 * @returns The app's TypeScript errors, in the order Monaco holds them.
 */
function appTypeErrors(src: MarkerSource, appId: string): MarkerInfo[] {
	const prefix = prefixOf(appId);
	return src.markers().filter((m) => m.uri.startsWith(prefix) && isTypeError(m));
}

/**
 * The files of an app that have a model loaded.
 *
 * @param src - The marker source.
 * @param appId - The app id.
 * @returns Each loaded model as a path inside the app (for example `src/App.tsx`); empty when the app is not open.
 */
function appModelPaths(src: MarkerSource, appId: string): string[] {
	const prefix = prefixOf(appId);
	return src
		.modelUris()
		.filter((uri) => uri.startsWith(prefix))
		.map((uri) => uri.slice(prefix.length));
}

// =============================================================================
// EVIDENCE
// =============================================================================

/**
 * Reads an app's type errors into check evidence.
 *
 * @param src - The marker source; settle it first (`settleMarkers`) if files just changed.
 * @param app - The app being checked; its `id` is the id its models are keyed by.
 * @param tsFiles - The app's TypeScript files, as paths inside the app (for example `src/App.tsx`).
 * @returns `not_run` when the app has no models, or has TypeScript files and
 *   none of them is loaded (the models are only json, css and the like);
 *   otherwise `fail` with one `${relPath}:${line} ${message}` line per error, or
 *   `pass`. TypeScript files with no model are named in the output and counted
 *   in a passing summary.
 */
async function appTypeEvidence(src: MarkerSource, app: AppEntry, tsFiles: string[]): Promise<CheckEvidence> {
	const prefix = app.id ? prefixOf(app.id) : undefined;
	const models = new Set(prefix ? src.modelUris().filter((uri) => uri.startsWith(prefix)) : []);
	if (!prefix || models.size === 0) return { step: TYPES_STEP, ran: TYPES_RAN, output: NOT_OPEN_OUTPUT, status: 'not_run', summary: NOT_OPEN_SUMMARY };

	const errors = src
		.markers()
		.filter((m) => m.uri.startsWith(prefix) && isTypeError(m))
		.map((m) => ({ relPath: m.uri.slice(prefix.length), line: m.line, message: m.message.replace(/\s*\n\s*/g, ' ') }))
		.sort((a, b) => (a.relPath === b.relPath ? a.line - b.line : a.relPath < b.relPath ? -1 : 1));
	const checked = tsFiles.filter((file) => models.has(`${prefix}${file}`));
	const unchecked = tsFiles.filter((file) => !models.has(`${prefix}${file}`));

	// step: models of json, css and the like prove nothing about types; with TypeScript files and none of them loaded, nothing was checked
	if (errors.length === 0 && checked.length === 0 && tsFiles.length > 0) return { step: TYPES_STEP, ran: TYPES_RAN, output: NOT_OPEN_OUTPUT, status: 'not_run', summary: NOT_OPEN_SUMMARY };

	// step: only the error list is cut; the note on unchecked files comes after it so a long list cannot hide it
	const errorText = errors.length > 0 ? errors.map((e) => `${e.relPath}:${e.line} ${e.message}`).join('\n') : `no TypeScript errors in ${checked.length} files`;
	const note = unchecked.length > 0 ? `\nNot type-checked (not loaded in the editor): ${unchecked.join(', ')}` : '';
	const output = `${clip(errorText, 'fix the first errors and check again to see the rest')}${note}`;

	if (errors.length > 0) return { step: TYPES_STEP, ran: TYPES_RAN, output, status: 'fail', summary: `types: ${errors.length} errors` };
	const summary = unchecked.length > 0 ? `types clean (${unchecked.length} files not type-checked)` : 'types clean';
	return { step: TYPES_STEP, ran: TYPES_RAN, output, status: 'pass', summary };
}

// =============================================================================
// TYPES NOTE — the type errors a save of an app file appends
// =============================================================================

/**
 * Saving an app's TypeScript file returns that file's type errors and the app's
 * total, so the model sees the result of its own edit at once and fixes it
 * without asking. The host's after-save hook calls `typesNote` (see run.ts).
 *
 * This is information only: it never counts toward the finish rule (only
 * `check_app` does), because it reads markers that may not have settled and
 * covers one file, not the app. A note that cannot be read says why and never
 * fails the save.
 */

/** What a save says when it cannot read the file's types because the app is not loaded in the editor. */
const NOT_OPEN = "\n\nTypes not checked: the app isn't open.";

/** What a cut error list in a save's note tells the model to do. */
const SAVE_CLIP_HINT = 'fix the first errors and save again to see the rest';

/**
 * The type note for a saved app file.
 *
 * @param vfs - The workspace view the file tools write to; it maps `apps/<folder>` to the app id.
 * @param markers - Gets Monaco's marker source; resolves null when there is none (outside a browser, or before the editor loads).
 * @param folder - The app's folder under `apps/`.
 * @param relPath - The file's path inside the app (for example `src/App.tsx`).
 * @returns The text to append: the file's errors and the app total, or why types were not checked.
 */
export async function typesNote(vfs: IWorkspaceFileSystem, markers: () => Promise<MarkerSource | null>, folder: string, relPath: string): Promise<string> {
	try {
		const app = (await readApps(vfs, () => false)).find((a) => a.folder === folder);
		if (!app?.id) return `\n\nTypes not checked: apps/${folder} has no manifest id, so its editor models cannot be found.`;

		let src: MarkerSource | null;
		try {
			src = await markers();
		} catch (err) {
			return `\n\nTypes not checked: the editor's type service could not be loaded (${messageOf(err)}).`;
		}

		// step: an app with no models is not open; there is nothing to settle, so do not wait
		if (!src || appModelPaths(src, app.id).length === 0) return NOT_OPEN;
		await settleMarkers(src);

		// step: the file's own model may only have appeared while settling, so look for it now
		if (!appModelPaths(src, app.id).includes(relPath)) return NOT_OPEN;

		const errors = fileTypeErrors(src, app.id, relPath).sort((a, b) => a.line - b.line);
		const total = appTypeErrors(src, app.id).length;
		if (errors.length === 0) return `\n\nType errors in this file: none. App total: ${total}.`;
		const lines = errors.map((e) => `- line ${e.line}: ${e.message.replace(/\s*\n\s*/g, ' ')}`).join('\n');
		return `\n\nType errors in this file (${errors.length}):\n${clip(lines, SAVE_CLIP_HINT)}\nApp total: ${total}.`;
	} catch (err) {
		return `\n\nTypes not checked: ${messageOf(err)}.`;
	}
}

// =============================================================================
// APP CHECKER — what check_app runs
// =============================================================================

/**
 * An app check leaves the evidence of two halves, in this order:
 *
 * 1. `types`: the TypeScript errors Monaco keeps for the app's files (see TYPE
 *    READER above). Monaco validates some time after a file changes, so the
 *    markers are settled first.
 * 2. `build`, `runtime` and `console`: a rebuild in the Design preview and what
 *    it raised (see APP BUILD below). With no preview, one `not_run` item says so.
 *
 * Both halves always run, so a failed type check does not hide a failed build.
 * Anything that cannot run is `not_run` and named, never a pass and never a
 * failure: an editor whose type service did not load, a closed preview. An app
 * whose manifest is missing, broken or has no id is a `fail` (`manifest`), because
 * the agent can fix its `package.json` and a broken one must not pass. A
 * `package.json` that cannot be read at all throws instead: the manifest may be
 * fine, so the check records nothing rather than tell the agent to fix it.
 *
 * The report is filed under the app's manifest id (its folder when it has none),
 * whichever of the folder, id or name the model passed, so the checks line has
 * one entry per app.
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/** Folders inside an app that the platform owns; their files are not the app's. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build']);

/** The app's source files that Monaco type-checks. */
const TYPESCRIPT_FILE = /\.tsx?$/;

/** A marker source with no models, so `appTypeEvidence` answers `not_run` the way it does for an app that is not open. */
const NO_MARKERS: MarkerSource = { modelUris: () => [], markers: () => [], onChange: () => () => undefined };

// =============================================================================
// TYPES
// =============================================================================

/** The timings of the app checker. */
export interface AppCheckOptions {
	/** The build step's timings (defaults: 60 000, 300 and 1500 ms). */
	build?: AppBuildOptions;
	/** How long Monaco's markers must be quiet, and the longest the wait runs, in milliseconds (defaults: 1500 and 10 000). */
	types?: { quietMs?: number; maxMs?: number };
}

// =============================================================================
// FILES
// =============================================================================

/**
 * Lists an app's TypeScript files.
 *
 * @param vfs - The workspace view.
 * @param dir - The folder to walk, from the workspace root.
 * @param base - The path of `dir` inside the app ('' for the app folder itself).
 * @returns Every `.ts` and `.tsx` file under `dir` as a path inside the app (for example `src/App.tsx`), skipping `node_modules`, `dist` and `build`; in path order.
 */
async function typeScriptFiles(vfs: IWorkspaceFileSystem, dir: string, base = ''): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await vfs.list(dir)) {
		const rel = `${base}${entry.name}`;
		if (entry.type === 'dir') {
			if (!SKIPPED_DIRS.has(entry.name)) found.push(...(await typeScriptFiles(vfs, `${dir}/${entry.name}`, `${rel}/`)));
		} else if (TYPESCRIPT_FILE.test(entry.name)) {
			found.push(rel);
		}
	}
	return found.sort();
}

// =============================================================================
// STEPS
// =============================================================================

/**
 * The type evidence for an app.
 *
 * @param app - The app, with an id.
 * @param markers - The host's marker source getter.
 * @param settle - How long to let Monaco's markers settle.
 * @param files - The app's TypeScript files.
 * @returns The evidence; `not_run` when the editor is not there, did not load, or holds none of the app's files.
 */
async function typesStep(app: AppEntry, markers: () => Promise<MarkerSource | null>, settle: AppCheckOptions['types'], files: string[]): Promise<CheckEvidence> {
	let src: MarkerSource | null;
	try {
		src = await markers();
	} catch (err) {
		return { step: TYPES_STEP, ran: TYPES_RAN, output: `The editor's type service could not be loaded: ${messageOf(err)}`, status: 'not_run', summary: 'types not checked: the editor could not be loaded' };
	}
	if (!src) return appTypeEvidence(NO_MARKERS, app, files);
	await settleMarkers(src, settle);
	return appTypeEvidence(src, app, files);
}

/**
 * The evidence for an app whose manifest has no usable id. This fails, because
 * the agent can always fix it, and a `package.json` it broke while editing would
 * otherwise read as an app with nothing to check.
 *
 * @param app - The app.
 * @returns A failing `manifest` item that says how to fix it, then a `not_run` item for each half it blocked.
 */
function noIdEvidence(app: AppEntry): CheckEvidence[] {
	const why = app.error ?? 'appManifest has no id';
	const file = `${app.path}/package.json`;
	const output = `${file} cannot be used as an app: ${why}. Fix the JSON and the appManifest (it needs an id and a name) in ${file}, then check again. Types and build were not checked.`;
	return [
		{ step: 'manifest', ran: `read the appManifest in ${file}`, output, status: 'fail', summary: `manifest: ${why}` },
		{ step: TYPES_STEP, ran: TYPES_RAN, output, status: 'not_run', summary: 'types not checked: the manifest has no usable id' },
		{ step: 'build', ran: BUILD_RAN, output, status: 'not_run', summary: 'build not checked: the manifest has no usable id' },
	];
}

/**
 * Checks one app: its types, then a rebuild in its Design preview.
 *
 * @param host - The agent host: its workspace holds the app's files, and it finds the app's running dev session.
 * @param markers - Gets Monaco's marker source; resolves null when there is none (outside a browser, or before the editor loads).
 * @param app - The app to check, as `findApp` found it.
 * @param opts - Timings; tests pass short ones.
 * @returns The evidence from every step, in the order they ran.
 * @throws When the app's package.json cannot be read, with the read error; nothing was checked then.
 */
async function checkApp(host: AgentHost, markers: () => Promise<MarkerSource | null>, app: AppEntry, opts: AppCheckOptions): Promise<CheckEvidence[]> {
	// step: a read that failed says nothing about the manifest, so there is no evidence to record either way
	if (app.unreadable) throw new Error(`Cannot check ${app.folder} (${app.error}), so nothing was checked. Run check_app again; if it keeps failing, tell the user this app was not checked.`);
	if (!app.id) return noIdEvidence(app);

	const files = await typeScriptFiles(host.vfs, app.path);
	const types = await typesStep(app, markers, opts.types, files);
	const build = await appBuildEvidence(host.devSession(app.id), opts.build);
	return [types, ...build];
}

// =============================================================================
// APP BUILD — a preview rebuild, with its build, runtime and console errors
// =============================================================================

/**
 * The build half of an app check. It rebuilds the app in its Design preview and
 * reports what the build, the running app and the console say. Rod's dev session
 * builds only while a preview is attached (`devSession.ts:599`), so with no
 * preview the evidence says so and nothing is built.
 *
 * What counts as what, because a check that wrongly passes lets the agent claim
 * the app runs and one that cannot pass on a healthy app leaves it stuck:
 *
 * - `rebuild()` queues and coalesces: while a build runs it sets a flag and
 *   returns at once, and the running build is followed by another. So the wait
 *   is on the watch state, not on the promise: the result is the last `ok` or
 *   `error` that no `building` or `installing` follows within `settleMs`.
 * - Every feed replays its backlog on subscribe, including the watch state. The
 *   replay is dropped, so a stale `ok` or an error from an earlier build is never
 *   this rebuild's result. A rebuild that never starts a build therefore times
 *   out as `not_run`: nothing new happened, so nothing is proven.
 * - A hot refresh (`target: 'hot refresh'`) swaps one module into a mounted app
 *   and reports `ok` with no `building` before it. It can land while the full
 *   build is still running, so it is never this rebuild's result.
 * - A build that does not settle in `buildWaitMs` is `not_run`, not `fail`: the
 *   app may be fine. The summary says whether no build started or one was seen
 *   running that did not finish.
 * - Runtime errors are the error rows that arrive after this rebuild's first
 *   `building` or `installing` until `runtimeGraceMs` after the build settles,
 *   which is when the app mounts and throws. The old app can still raise errors
 *   until the new build begins, and those are not this rebuild's. The shell's
 *   harmless `ResizeObserver loop` window errors are not counted: a healthy app
 *   raises them and would never pass. A clean result means none arrived in that
 *   window, and the output says so.
 * - Console errors are reported but never fail the check: the preview shell wraps
 *   the whole window's `console.error`, so shell code, libraries and React's dev
 *   warnings land there on a healthy app. Uncaught errors (runtime) block; console
 *   errors inform.
 * - A failed build mounts nothing, so runtime and console are not read; the build
 *   evidence carries the error rows the build raised and says what was skipped.
 *
 * Output goes through `clip`, so a long list is cut and says how to see the rest.
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/** How long the build may take to settle before it is called still running, in milliseconds. */
const DEFAULT_BUILD_WAIT_MS = 60_000;

/** How long after an `ok` or `error` no new build may start for the result to stand, in milliseconds. */
const DEFAULT_SETTLE_MS = 300;

/** How long after the build settles the preview is watched for mount errors, in milliseconds. */
const DEFAULT_RUNTIME_GRACE_MS = 1500;

/** The watch `target` of a hot refresh, which swaps one module into a mounted app without a build. */
const HOT_REFRESH_TARGET = 'hot refresh';

/** Window errors the shell forwards that a healthy app raises (the browser's ResizeObserver notices), which are not failures. */
const BENIGN_ERROR = /ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/;

/** What the build step does, as a short phrase. */
const BUILD_RAN = 'rebuild the app in its Design preview and wait for the build to settle';

/** What the runtime step does, as a short phrase. */
const RUNTIME_RAN = 'watch the preview for runtime errors from the rebuild until just after the app mounts';

/** What the console step does, as a short phrase. */
const CONSOLE_RAN = "read the preview's console errors from the rebuild";

/** How the model gets the preview open. Only the user can, until the run mounts a view tool (open question 1). */
const OPEN_PREVIEW = "ask the user to open the app's Design preview in the App Builder, then run check_app again";

/** What the output says when the preview is closed. */
const PREVIEW_CLOSED_OUTPUT = `The app's Design preview is not open, and the app is built only while it is, so nothing was built and no runtime or console errors were read. To include them, ${OPEN_PREVIEW}.`;

// =============================================================================
// TYPES
// =============================================================================

/** The timings of the build step. */
interface AppBuildOptions {
	/** How long the build may take to settle before it is called still running, in milliseconds (default 60 000). */
	buildWaitMs?: number;
	/** How long after an `ok` or `error` no new build may start, in milliseconds (default 300). */
	settleMs?: number;
	/** How long after the build settles the preview is watched for mount errors, in milliseconds (default 1500). */
	runtimeGraceMs?: number;
}

/** How the wait for the build ended. */
type BuildOutcome = { kind: 'settled'; status: WatchStatus } | { kind: 'timeout'; started: boolean } | { kind: 'unstarted'; message: string };

// =============================================================================
// EVIDENCE
// =============================================================================

/**
 * A piece of build evidence for a step that did not run.
 *
 * @param step - The step name.
 * @param ran - What would have run.
 * @param output - What the output says.
 * @param summary - Why it did not, and what was not checked.
 * @returns The evidence.
 */
function notRun(step: string, ran: string, output: string, summary: string): CheckEvidence {
	return { step, ran, output, status: 'not_run', summary };
}

/**
 * Writes a wait as a person would.
 *
 * @param ms - The wait in milliseconds.
 * @returns For example `60 s`, or `150 ms` for a wait under a second.
 */
function describeWait(ms: number): string {
	return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

/**
 * Writes error rows as one line each.
 *
 * @param rows - The preview's error rows.
 * @returns `source: message` per row (just the message when there is no source), with a multi-line message on one line.
 */
function errorLines(rows: AppErrorRow[]): string[] {
	return rows.map((row) => `${row.source ? `${row.source}: ` : ''}${row.message.replace(/\s*\n\s*/g, ' ')}`);
}

/**
 * Cuts a list of lines that is too long.
 *
 * @param lines - The lines.
 * @returns The lines as text, cut with a note on how to see less.
 */
function listText(lines: string[]): string {
	return clip(lines.join('\n'), 'fix the first errors and check again to see the rest');
}

// =============================================================================
// REBUILD
// =============================================================================

/**
 * Rebuilds the app in its Design preview and reports what it saw.
 *
 * @param session - The app's dev session, or null when none is running.
 * @param opts - The timings; tests pass short ones.
 * @returns With no session or no preview attached, one `not_run` item
 *   (`preview closed: build not checked`). Otherwise `build` (`build OK` or
 *   `build failed: ${reason}`) and, when the build is OK, `runtime` (`runtime
 *   clean` or `runtime: ${n} errors`) and, only when there are some, `console`
 *   (`console: ${n} errors`, which is reported but does not fail the check). A
 *   build that does not start or settle in time, or a rebuild that cannot run, is
 *   a single `not_run` item. It never throws.
 */
async function appBuildEvidence(session: AgentDevSession | null, opts: AppBuildOptions = {}): Promise<CheckEvidence[]> {
	if (!session || !session.previewAttached) return [notRun('build', 'rebuild the app in its Design preview', PREVIEW_CLOSED_OUTPUT, 'preview closed: build not checked')];

	const buildWaitMs = opts.buildWaitMs ?? DEFAULT_BUILD_WAIT_MS;
	const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
	const runtimeGraceMs = opts.runtimeGraceMs ?? DEFAULT_RUNTIME_GRACE_MS;

	const errorRows: AppErrorRow[] = [];
	const consoleRows: ConsoleRow[] = [];
	const stops: Array<() => void> = [];
	let capTimer: ReturnType<typeof setTimeout> | undefined;
	let quietTimer: ReturnType<typeof setTimeout> | undefined;
	// step: each subscribe replays its backlog before it returns; those rows and that state are older than this rebuild
	let replaying = true;
	// step: the rows before this rebuild's first building or installing belong to the old app
	let building = false;
	// step: whether any build status has come in since the replay, for naming a timeout
	let started = false;

	try {
		const outcome = await new Promise<BuildOutcome>((resolve) => {
			capTimer = setTimeout(() => resolve({ kind: 'timeout', started }), buildWaitMs);
			// step: one push per subscribe, so a later subscribe that throws still leaves the earlier ones to be released
			stops.push(
				session.subscribeErrors((row) => {
					if (!replaying && building && !BENIGN_ERROR.test(row.message)) errorRows.push(row);
				})
			);
			stops.push(
				session.subscribeConsole((row) => {
					if (!replaying && building && row.level === 'error') consoleRows.push(row);
				})
			);
			stops.push(
				session.subscribeWatch((status) => {
					// step: a hot refresh lands mid-build with no building before it; it is no build result
					if (replaying || status.target === HOT_REFRESH_TARGET) return;
					// step: an ok or error stands only if no new build starts within settleMs; a queued rebuild starts right after the running one
					if (status.state === 'ok' || status.state === 'error') {
						started = true;
						clearTimeout(quietTimer);
						quietTimer = setTimeout(() => resolve({ kind: 'settled', status }), settleMs);
					} else if (status.state === 'building' || status.state === 'installing') {
						started = true;
						building = true;
						clearTimeout(quietTimer);
					}
				})
			);
			replaying = false;
			// step: its promise is no signal, because a rebuild that only queues resolves at once
			Promise.resolve()
				.then(() => session.rebuild())
				.catch((err: unknown) => resolve({ kind: 'unstarted', message: messageOf(err) }));
		});

		if (outcome.kind === 'timeout') {
			const wait = describeWait(buildWaitMs);
			if (!outcome.started) return [notRun('build', BUILD_RAN, `No build started within ${wait} of the rebuild request, so nothing was built or checked. The preview may be paused or closed; ${OPEN_PREVIEW}.`, `no build started within ${wait}`)];
			return [notRun('build', BUILD_RAN, `The build did not finish within ${wait}, so it was not seen to pass or fail. It may still be running; check again in a moment.`, `build still running after ${wait}`)];
		}
		if (outcome.kind === 'unstarted') return [notRun('build', BUILD_RAN, `The rebuild could not run: ${outcome.message}`, `build not run: ${brief(outcome.message)}`)];

		if (outcome.status.state === 'error') {
			const reason = outcome.status.reason?.trim() || 'no reason reported';
			const raised = errorRows.length > 0 ? `\nErrors the build raised:\n${listText(errorLines(errorRows))}` : '';
			const output = `${clip(`Build failed: ${reason}`, 'the reason is long; fix the first problem and check again')}${raised}\nRuntime and console were not checked because the build failed.`;
			return [{ step: 'build', ran: BUILD_RAN, output, status: 'fail', summary: `build failed: ${brief(reason)}` }];
		}

		// step: the app mounts after the build settles; give its errors time to arrive
		await new Promise((resolve) => setTimeout(resolve, runtimeGraceMs));
		const took = outcome.status.durationMs !== undefined ? ` in ${outcome.status.durationMs} ms` : '';
		const evidence: CheckEvidence[] = [{ step: 'build', ran: BUILD_RAN, output: `Build finished OK${took}.`, status: 'pass', summary: 'build OK' }];
		if (errorRows.length > 0) {
			evidence.push({ step: 'runtime', ran: RUNTIME_RAN, output: listText(errorLines(errorRows)), status: 'fail', summary: `runtime: ${errorRows.length} errors` });
		} else {
			evidence.push({ step: 'runtime', ran: RUNTIME_RAN, output: `No runtime errors arrived from the rebuild until ${describeWait(runtimeGraceMs)} after the build settled.`, status: 'pass', summary: 'runtime clean' });
		}
		if (consoleRows.length > 0) {
			evidence.push({ step: 'console', ran: CONSOLE_RAN, output: listText(consoleRows.map((row) => row.text.replace(/\s*\n\s*/g, ' '))), status: 'pass', summary: `console: ${consoleRows.length} errors` });
		}
		return evidence;
	} catch (err) {
		// step: subscribing to a session that is gone throws; that is a check that could not run, not an app that failed
		return [notRun('build', BUILD_RAN, `The rebuild could not run: ${messageOf(err)}`, `build not run: ${brief(messageOf(err))}`)];
	} finally {
		clearTimeout(capTimer);
		clearTimeout(quietTimer);
		for (const stop of stops) stop();
	}
}

// =============================================================================
// TOOL — check_app, the one way the agent gets evidence that an app holds up
// =============================================================================

/** The name the model calls the tool by. */
export const APP_CHECK_TOOL = 'check_app';

/** System-prompt fragment for the tool. */
const INSTRUCTIONS = `## Checking apps

- Run \`check_app\` on each app you changed, after your last change to it and before you say you're done, because only a check_app run after the last change counts as evidence.
- If check_app fails, fix what it reports and run it again, because an answer with a failing app is sent back.
- Leave the "Checked:" line to the system, because it is built from the check results and anything you write there is dropped.`;

/** What the model reads about the tool: when to use it, when not to, one example. */
const DESCRIPTION = `Run the full check on an app and record what it saw: its TypeScript errors, then a rebuild in its Design preview with the build, runtime and console errors. The result lists every step that ran, its output, and whether it passed.

Use it:
- after your last change to an app, before you tell the user you're done;
- again after fixing a failed check.

Don't use it:
- to read state: use read_file or list_directory to see what a file holds;
- after each small edit: saving an app file already returns its type errors;
- on a pipeline: saving a .pipe file already validates it, and you test a pipeline by running it with run_pipeline and reading its log.

Steps that could not run (for example, "preview closed: build not checked") are named in the result; say so plainly in your answer.

Example: after editing the app "daybook-ui", call check_app { "app": "daybook-ui" }.`;

/**
 * Hears each check_app result. A call that throws has no result, so the
 * listener never hears it; the run learns of it from the call's error.
 *
 * @param folder - The checked app's folder under `apps/`.
 * @param report - What the check saw.
 */
export type AppCheckListener = (folder: string, report: CheckReport) => void;

/**
 * The `check_app` tool. It finds the app the model named, runs the app checker
 * on it, and tells the listener what it saw, so the run can tell whether each
 * app it changed was checked and what the answer's checks line should say. The
 * toolkit keeps no record of its own.
 */
export class AppCheckToolkit extends AgentToolkit {
	readonly name = 'app-check';
	readonly instructions = INSTRUCTIONS;

	/** The agent host: its workspace lists the apps and their files, and it finds an app's running dev session. */
	private readonly host: AgentHost;
	/** Gets Monaco's marker source. */
	private readonly markers: () => Promise<MarkerSource | null>;
	/** Hears every result. */
	private readonly onResult: AppCheckListener;
	/** The checker's timings. */
	private readonly opts: AppCheckOptions;

	/**
	 * Builds the toolkit for one agent.
	 *
	 * @param host - The agent host.
	 * @param markers - Gets Monaco's marker source; resolves null when there is none (outside a browser, or before the editor loads).
	 * @param onResult - Hears each result; the run keeps the record, not this toolkit.
	 * @param opts - Timings; tests pass short ones.
	 */
	constructor(host: AgentHost, markers: () => Promise<MarkerSource | null>, onResult: AppCheckListener, opts: AppCheckOptions = {}) {
		super();
		this.host = host;
		this.markers = markers;
		this.onResult = onResult;
		this.opts = opts;
	}

	/**
	 * Runs one check.
	 *
	 * @param args - The model's arguments: the app, by folder, manifest id or name.
	 * @returns The evidence, written for the model.
	 * @throws When no app is named or none matches (the message names the apps that exist), or when the app's package.json cannot be read; the listener hears nothing then.
	 */
	private async run(args: Record<string, unknown>): Promise<string> {
		// step: refuse a call that names no app, saying how to fix it
		const ref = typeof args.app === 'string' ? args.app.trim() : '';
		if (!ref) throw new Error('app is required: pass the app id or its folder under apps/ to check.');
		const app = findApp(await readApps(this.host.vfs, (id) => this.host.devSession(id) !== null), ref);

		// step: run it, then hand the report on as evidence
		const report: CheckReport = { target: app.id ?? app.folder, evidence: await checkApp(this.host, this.markers, app, this.opts) };
		this.onResult(app.folder, report);
		return formatReport(report);
	}

	/**
	 * The member tools.
	 *
	 * @returns The single `check_app` tool.
	 */
	tools(): AgentTool[] {
		return [
			new AgentTool({
				name: APP_CHECK_TOOL,
				description: DESCRIPTION,
				parameters: {
					type: 'object',
					properties: {
						app: { type: 'string', description: 'The app to check: its folder under apps/ (for example daybook-ui) or its manifest id' },
					},
					required: ['app'],
					additionalProperties: false,
				},
				execute: (a) => this.run(a),
			}),
		];
	}
}
