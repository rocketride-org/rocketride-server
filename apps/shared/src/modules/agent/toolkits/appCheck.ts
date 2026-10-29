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
 * `check_app` runs the full check on one app (types, then a Design-preview rebuild) and reports each step to
 * the model and the run. It is the only check tool: a pipeline save validates it, and the model tests a
 * pipeline by running it.
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
 */
export function reportPassed(report: CheckReport): boolean {
	return report.evidence.every((e) => e.status !== 'fail');
}

function indent(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => `  ${line}`)
		.join('\n');
}

/**
 * Writes a report as the tool result. A step with no output shows its summary instead, so a step that
 * did not run still says why.
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
 * The type half of an app check. It reads the TypeScript errors Monaco keeps as markers on each app file's
 * model (`file:///${appId}/${relPath}`), so it costs no build. Only `typescript` Error markers count; the
 * `rr-appdev` link errors belong to the build evidence. An app with no models is `not_run` (no models means
 * no markers, not no errors), and a file with no model is named so a clean result never hides it. A model
 * with no markers yet looks clean, so callers wait on `settleMarkers` first. Only `monacoMarkerSource` needs
 * a browser; tests pass a fake `MarkerSource`.
 */

// =============================================================================
// CONSTANTS
// =============================================================================

const TYPESCRIPT_OWNER = 'typescript';

/** Monaco's `MarkerSeverity.Error`, kept here so the tests need no Monaco. */
const SEVERITY_ERROR = 8;

/** Quiet window before markers count as settled; longer than Monaco's 500 ms validation debounce. */
const DEFAULT_QUIET_MS = 1500;

/** The longest `settleMarkers` waits, in milliseconds, however often the markers change or the worker is slow. */
const DEFAULT_MAX_MS = 10_000;

const TYPES_STEP = 'types';

const TYPES_RAN = "read the TypeScript errors Monaco keeps for the app's open files";

const NOT_OPEN_SUMMARY = 'types not checked until the app is open or deployed';

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
	/**
	 * The model uri of an app file, spelled the way `modelUris()` and the markers spell it. Absent, the
	 * path is used as it is.
	 */
	modelUri?(appId: string, relPath: string): string;
	/** Every marker Monaco holds, for every model. */
	markers(): MarkerInfo[];
	/**
	 * Calls a listener whenever any marker changes.
	 *
	 * @returns A function that stops the calls.
	 */
	onChange(listener: () => void): () => void;
	/**
	 * Resolves once validation can start: the TypeScript worker is up and holds
	 * the models. A source with nothing to wait for leaves it out.
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
 * The marker source backed by the real Monaco. Browser only: it loads Monaco on first use, so import it
 * lazily to keep this file loadable under the test runner. `ready()` asks the TypeScript worker for every
 * TypeScript model; asking starts a cold worker and copies the models in, and Monaco validates a model
 * only once the worker has it. That covers every open app, not only the one being checked.
 */
export async function monacoMarkerSource(): Promise<MarkerSource> {
	const { loadMonaco } = await import('../../../components/monaco/loader');
	const monaco = await loadMonaco();
	return {
		// step: skipEncoding keeps the uri as `file:///${appId}/${relPath}`, even for names that need escaping
		modelUris: () => monaco.editor.getModels().map((model) => model.uri.toString(true)),
		// step: the dev session names a model with Uri.parse (devSession.ts), which decodes each %XX: src/foo%20bar.ts is src/foo bar.ts
		modelUri: (appId, relPath) => monaco.Uri.parse(`${prefixOf(appId)}${relPath}`).toString(true),
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
 * Waits for Monaco to finish validating, which gives no "done" signal: first for `ready` (skipped if it
 * fails), then until no marker has changed for `quietMs`. Capped at `maxMs`; the stop signal ends it at once.
 */
function settleMarkers(src: MarkerSource, opts: { quietMs?: number; maxMs?: number; signal?: AbortSignal } = {}): Promise<void> {
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
			if (finished) return;
			finished = true;
			clearTimeout(quiet);
			clearTimeout(cap);
			stop();
			opts.signal?.removeEventListener('abort', done);
			resolve();
		}
		// after the subscribe, which done() releases
		if (opts.signal?.aborted) done();
		else opts.signal?.addEventListener('abort', done, { once: true });
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

/** The uri prefix of an app's models; the closing slash keeps `app` apart from `app-two`. */
function prefixOf(appId: string): string {
	return `file:///${appId}/`;
}

function isTypeError(marker: MarkerInfo): boolean {
	return marker.owner === TYPESCRIPT_OWNER && marker.severity === SEVERITY_ERROR;
}

function fileTypeErrors(src: MarkerSource, appId: string, relPath: string): MarkerInfo[] {
	const uri = `${prefixOf(appId)}${relPath}`;
	return src.markers().filter((m) => m.uri === uri && isTypeError(m));
}

function appTypeErrors(src: MarkerSource, appId: string): MarkerInfo[] {
	const prefix = prefixOf(appId);
	return src.markers().filter((m) => m.uri.startsWith(prefix) && isTypeError(m));
}

/** The app's loaded models as paths inside the app (e.g. `src/App.tsx`); empty when the app is not open. */
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
 * Reads an app's type errors into check evidence; settle `src` first if files just changed. `not_run` when no
 * TypeScript file of the app has a model; otherwise `fail` with one `relPath:line message` per error, or
 * `pass`. Unloaded TypeScript files are named. Errors in files no longer in the app are dropped and counted,
 * because the editor keeps a deleted file's model.
 */
async function appTypeEvidence(src: MarkerSource, app: AppEntry, tsFiles: string[], hide: (text: string) => string): Promise<CheckEvidence> {
	const appId = app.id;
	const prefix = appId ? prefixOf(appId) : undefined;
	const models = new Set(prefix ? src.modelUris().filter((uri) => uri.startsWith(prefix)) : []);
	if (!appId || !prefix || models.size === 0) return { step: TYPES_STEP, ran: TYPES_RAN, output: NOT_OPEN_OUTPUT, status: 'not_run', summary: NOT_OPEN_SUMMARY };

	// step: a TypeScript file whose model no live file would get was deleted; its stale errors prove nothing
	const uriOf = (file: string): string => src.modelUri?.(appId, file) ?? `${prefix}${file}`;
	const live = new Set(tsFiles.map(uriOf));
	const all = src
		.markers()
		.filter((m) => m.uri.startsWith(prefix) && isTypeError(m))
		.map((m) => ({ uri: m.uri, relPath: m.uri.slice(prefix.length), line: m.line, message: m.message.replace(/\s*\n\s*/g, ' ') }));
	const gone = all.filter((e) => TYPESCRIPT_FILE.test(e.relPath) && !live.has(e.uri));
	const errors = all.filter((e) => !gone.includes(e)).sort((a, b) => (a.relPath === b.relPath ? a.line - b.line : a.relPath < b.relPath ? -1 : 1));
	const checked = tsFiles.filter((file) => models.has(uriOf(file)));
	const unchecked = tsFiles.filter((file) => !models.has(uriOf(file)));

	// step: models of json, css and the like prove nothing about types; with TypeScript files and none of them loaded, nothing was checked
	if (errors.length === 0 && checked.length === 0 && tsFiles.length > 0) return { step: TYPES_STEP, ran: TYPES_RAN, output: NOT_OPEN_OUTPUT, status: 'not_run', summary: NOT_OPEN_SUMMARY };

	// step: only the error list is cut; the note on unchecked files comes after it so a long list cannot hide it
	const errorText = errors.length > 0 ? errors.map((e) => `${e.relPath}:${e.line} ${e.message}`).join('\n') : `no TypeScript errors in ${checked.length} files`;
	const note = unchecked.length > 0 ? `\nNot type-checked (not loaded in the editor): ${unchecked.join(', ')}` : '';
	const goneFiles = [...new Set(gone.map((e) => e.relPath))];
	const ignored = gone.length > 0 ? `\nIgnored ${gone.length} ${gone.length === 1 ? 'marker' : 'markers'} for ${goneFiles.length === 1 ? 'a file that no longer exists' : 'files that no longer exist'}: ${goneFiles.join(', ')}.` : '';
	const output = `${clip(hide(errorText), 'fix the first errors and check again to see the rest')}${note}${ignored}`;

	if (errors.length > 0) return { step: TYPES_STEP, ran: TYPES_RAN, output, status: 'fail', summary: `types: ${errors.length} errors` };
	const summary = unchecked.length > 0 ? `types clean (${unchecked.length} files not type-checked)` : 'types clean';
	return { step: TYPES_STEP, ran: TYPES_RAN, output, status: 'pass', summary };
}

// =============================================================================
// TYPES NOTE — the type errors a save of an app file appends
// =============================================================================

/**
 * A save of an app's TypeScript file appends that file's type errors and the app total, so the model fixes
 * its own edit at once. Information only: it never counts toward the finish rule, because the markers may
 * not have settled and it covers one file. A note that cannot be read says why and never fails the save.
 */

const NOT_OPEN = "\n\nTypes not checked: the app isn't open.";

const SAVE_CLIP_HINT = 'fix the first errors and save again to see the rest';

/**
 * The type note for a saved app file.
 *
 * @param vfs - The workspace view the file tools write to; it maps `apps/<folder>` to the app id.
 * @param markers - Gets Monaco's marker source; resolves null when there is none (outside a browser, or before the editor loads).
 * @param folder - The app's folder under `apps/`.
 * @param relPath - The file's path inside the app (for example `src/App.tsx`).
 * @param hide - Hides the values the run's file tools hid, before the cut.
 * @returns The text to append: the file's errors and the app total, or why types were not checked.
 */
export async function typesNote(vfs: IWorkspaceFileSystem, markers: () => Promise<MarkerSource | null>, folder: string, relPath: string, hide: (text: string) => string): Promise<string> {
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
		return `\n\nType errors in this file (${errors.length}):\n${clip(hide(lines), SAVE_CLIP_HINT)}\nApp total: ${total}.`;
	} catch (err) {
		return `\n\nTypes not checked: ${messageOf(err)}.`;
	}
}

// =============================================================================
// APP CHECKER — what check_app runs
// =============================================================================

/**
 * An app check records two halves, in order: `types` (Monaco's settled TypeScript markers), then `build`,
 * `runtime` and `console` (a rebuild in the Design preview; with no preview, one `not_run` item). Both always
 * run, so a failed type check does not hide a failed build. Anything that cannot run is a named `not_run`,
 * never a pass or a failure. A missing, broken or id-less manifest is a `manifest` fail because the agent can
 * fix it; an unreadable `package.json` throws instead, since the manifest may be fine. Reports are filed under
 * the manifest id (else the folder), so the checks line has one entry per app.
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
	/** Aborted when the user stops the run: the marker settle and the build wait end at once. */
	signal?: AbortSignal;
	/** Hides the values the run's file tools hid; each text goes through it before it is cut. */
	hide?: (text: string) => string;
}

// =============================================================================
// FILES
// =============================================================================

/** Every `.ts`/`.tsx` file under `dir` as a path inside the app (`base` is `dir`'s own), in path order. */
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

/** The app's type evidence; `not_run` when the editor is missing, did not load, or holds none of its files. */
async function typesStep(app: AppEntry, markers: () => Promise<MarkerSource | null>, settle: { quietMs?: number; maxMs?: number; signal?: AbortSignal } | undefined, files: string[], hide: (text: string) => string): Promise<CheckEvidence> {
	let src: MarkerSource | null;
	try {
		src = await markers();
	} catch (err) {
		return { step: TYPES_STEP, ran: TYPES_RAN, output: `The editor's type service could not be loaded: ${messageOf(err)}`, status: 'not_run', summary: 'types not checked: the editor could not be loaded' };
	}
	if (!src) return appTypeEvidence(NO_MARKERS, app, files, hide);
	await settleMarkers(src, settle);
	return appTypeEvidence(src, app, files, hide);
}

/**
 * Evidence for an app whose manifest has no usable id: a `manifest` fail (the agent can fix it, and a
 * `package.json` it broke must not read as nothing to check), then `not_run` for each half it blocked.
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
 * Checks one app: its types, then a rebuild in its Design preview. Returns every step's evidence in run order.
 * @throws When the app's package.json cannot be read; nothing was checked then.
 */
async function checkApp(host: AgentHost, markers: () => Promise<MarkerSource | null>, app: AppEntry, opts: AppCheckOptions): Promise<CheckEvidence[]> {
	// step: a read that failed says nothing about the manifest, so there is no evidence to record either way
	if (app.unreadable) throw new Error(`Cannot check ${app.folder} (${app.error}), so nothing was checked. Run check_app again; if it keeps failing, tell the user this app was not checked.`);
	if (!app.id) return noIdEvidence(app);

	const hide = opts.hide ?? ((text: string) => text);
	const files = await typeScriptFiles(host.vfs, app.path);
	const types = await typesStep(app, markers, { ...opts.types, signal: opts.signal }, files, hide);
	const build = await appBuildEvidence(host.devSession(app.id), { ...opts.build, signal: opts.signal }, hide);
	return [types, ...build];
}

// =============================================================================
// APP BUILD — a preview rebuild, with its build, runtime and console errors
// =============================================================================

/**
 * The build half of an app check: rebuild the app in its Design preview and report the build, runtime and
 * console. The dev session builds only while a preview is attached, so with none nothing is built.
 * - `rebuild()` queues and coalesces, so the wait is on the watch state: the result is the last `ok` or
 *   `error` that no `building`/`installing` follows within `settleMs`.
 * - Every feed replays its backlog on subscribe; the replay is dropped so an earlier build is never this
 *   result. A rebuild that never starts a build times out as `not_run`.
 * - A hot refresh reports `ok` with no `building` and can land mid-build, so it is never the result.
 * - No settle within `buildWaitMs` is `not_run`, not `fail`: the app may be fine.
 * - Runtime errors are error rows from this rebuild's first `building` until `runtimeGraceMs` after it
 *   settles. The shell's benign `ResizeObserver loop` errors are ignored.
 * - Console errors inform but never fail: the shell wraps `console.error`, so a healthy app logs there too.
 * - A failed build mounts nothing, so runtime and console are skipped.
 */

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_BUILD_WAIT_MS = 60_000;

const DEFAULT_SETTLE_MS = 300;

const DEFAULT_RUNTIME_GRACE_MS = 1500;

/** The watch `target` of a hot refresh, which swaps one module into a mounted app without a build. */
const HOT_REFRESH_TARGET = 'hot refresh';

/** Window errors the shell forwards that a healthy app raises (the browser's ResizeObserver notices), which are not failures. */
const BENIGN_ERROR = /ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/;

const BUILD_RAN = 'rebuild the app in its Design preview and wait for the build to settle';

const RUNTIME_RAN = 'watch the preview for runtime errors from the rebuild until just after the app mounts';

const CONSOLE_RAN = "read the preview's console errors from the rebuild";

const OPEN_PREVIEW = "ask the user to open the app's Design preview in the App Builder, then run check_app again";

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
	/** Aborted when the user stops the run: the build wait ends at once. */
	signal?: AbortSignal;
}

/** How the wait for the build ended. */
type BuildOutcome = { kind: 'settled'; status: WatchStatus } | { kind: 'timeout'; started: boolean } | { kind: 'unstarted'; message: string } | { kind: 'stopped' };

// =============================================================================
// EVIDENCE
// =============================================================================

/** Evidence for a step that did not run; `summary` says why and what went unchecked. */
function notRun(step: string, ran: string, output: string, summary: string): CheckEvidence {
	return { step, ran, output, status: 'not_run', summary };
}

/** Writes a wait as a person would: `60 s`, or `150 ms` under a second. */
function describeWait(ms: number): string {
	return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

/** One `source: message` line per error row (the message alone without a source), multi-line messages joined. */
function errorLines(rows: AppErrorRow[]): string[] {
	return rows.map((row) => `${row.source ? `${row.source}: ` : ''}${row.message.replace(/\s*\n\s*/g, ' ')}`);
}

/** Joins lines into text, hides the run's hidden values, then cuts it with a note on how to see less. */
function listText(lines: string[], hide: (text: string) => string): string {
	return clip(hide(lines.join('\n')), 'fix the first errors and check again to see the rest');
}

// =============================================================================
// REBUILD
// =============================================================================

/**
 * Rebuilds the app in its Design preview and reports `build`, then `runtime` when the build is OK, then
 * `console` only when it has errors (reported, never failing). No preview, or a build that does not start or
 * settle, is one `not_run` item. Never throws.
 */
async function appBuildEvidence(session: AgentDevSession | null, opts: AppBuildOptions, hide: (text: string) => string): Promise<CheckEvidence[]> {
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
			// a run stopped during the types step asks for no rebuild
			if (opts.signal?.aborted) return resolve({ kind: 'stopped' });
			opts.signal?.addEventListener('abort', () => resolve({ kind: 'stopped' }), { once: true });
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

		if (outcome.kind === 'stopped') return [notRun('build', BUILD_RAN, 'The run was stopped before the build finished, so the build was not checked.', 'build not checked: run stopped')];
		if (outcome.kind === 'timeout') {
			const wait = describeWait(buildWaitMs);
			if (!outcome.started) return [notRun('build', BUILD_RAN, `No build started within ${wait} of the rebuild request, so nothing was built or checked. The preview may be paused or closed; ${OPEN_PREVIEW}.`, `no build started within ${wait}`)];
			return [notRun('build', BUILD_RAN, `The build did not finish within ${wait}, so it was not seen to pass or fail. It may still be running; check again in a moment.`, `build still running after ${wait}`)];
		}
		if (outcome.kind === 'unstarted') return [notRun('build', BUILD_RAN, `The rebuild could not run: ${outcome.message}`, `build not run: ${brief(hide(outcome.message))}`)];

		if (outcome.status.state === 'error') {
			const reason = hide(outcome.status.reason?.trim() || 'no reason reported');
			const raised = errorRows.length > 0 ? `\nErrors the build raised:\n${listText(errorLines(errorRows), hide)}` : '';
			const output = `${clip(`Build failed: ${reason}`, 'the reason is long; fix the first problem and check again')}${raised}\nRuntime and console were not checked because the build failed.`;
			return [{ step: 'build', ran: BUILD_RAN, output, status: 'fail', summary: `build failed: ${brief(reason)}` }];
		}

		// step: the app mounts after the build settles; give its errors time to arrive
		await new Promise((resolve) => setTimeout(resolve, runtimeGraceMs));
		const took = outcome.status.durationMs !== undefined ? ` in ${outcome.status.durationMs} ms` : '';
		const evidence: CheckEvidence[] = [{ step: 'build', ran: BUILD_RAN, output: `Build finished OK${took}.`, status: 'pass', summary: 'build OK' }];
		if (errorRows.length > 0) {
			evidence.push({ step: 'runtime', ran: RUNTIME_RAN, output: listText(errorLines(errorRows), hide), status: 'fail', summary: `runtime: ${errorRows.length} errors` });
		} else {
			evidence.push({ step: 'runtime', ran: RUNTIME_RAN, output: `No runtime errors arrived from the rebuild until ${describeWait(runtimeGraceMs)} after the build settled.`, status: 'pass', summary: 'runtime clean' });
		}
		if (consoleRows.length > 0) {
			const lines = consoleRows.map((row) => row.text.replace(/\s*\n\s*/g, ' '));
			evidence.push({ step: 'console', ran: CONSOLE_RAN, output: listText(lines, hide), status: 'pass', summary: `console: ${consoleRows.length} errors` });
		}
		return evidence;
	} catch (err) {
		// step: subscribing to a session that is gone throws; that is a check that could not run, not an app that failed
		return [notRun('build', BUILD_RAN, `The rebuild could not run: ${messageOf(err)}`, `build not run: ${brief(hide(messageOf(err)))}`)];
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

- Run \`check_app\` on each app you changed, on its own, in a later step than your last change to it, and before you say you're done, because only a check_app run after the last change counts as evidence.
- Run it once after your last change to an app, not after each edit, because saving already reports type errors. If you changed no app, skip it.
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
- on a pipeline: saving a .pipe file already validates it, and you test a pipeline by running it with rocketride_client and reading its log.

Steps that could not run (for example, "preview closed: build not checked") are named in the result; say so plainly in your answer.

Example: after editing the app "daybook-ui", call check_app { "app": "daybook-ui" }.`;

/**
 * Hears each check_app result. A call that throws has no result, so the
 * listener never hears it; the run learns of it from the call's error.
 *
 * @param folder - The checked app's folder under `apps/`.
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
	private readonly onResult: AppCheckListener;
	private readonly opts: AppCheckOptions;

	/**
	 * Builds the toolkit for one agent.
	 *
	 * @param markers - Gets Monaco's marker source; resolves null when there is none (outside a browser, or before the editor loads).
	 * @param onResult - Hears each result; the run keeps the record, not this toolkit.
	 * @param opts - Timings (tests pass short ones) and the run's stop signal.
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

		const report: CheckReport = { target: app.id ?? app.folder, evidence: await checkApp(this.host, this.markers, app, this.opts) };
		this.onResult(app.folder, report);
		return formatReport(report);
	}

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
