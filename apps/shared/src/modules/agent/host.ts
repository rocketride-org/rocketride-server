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
// AGENT HOST — everything the agent needs from the app that mounts it
// =============================================================================

/**
 * The agent lives in shared code and never imports its host. The host (today
 * rocket-ui) builds one AgentHost at startup and hands it over with
 * setAgentHost(); agent code reads it back with getAgentHost(). Tests set a
 * fake host built from the in-memory workspace.
 */

import type { AgentWatchPlace, AppErrorRow, ConsoleRow, WatchStatus } from '../../tools/appdev/types';
import type { IWorkspaceFileSystem } from '../vfs/vfsTypes';
import { GRANTS, type Grant } from './grants';
import type { ModelChoice } from './model';
import type { AgentReport } from './turn';

// =============================================================================
// THE SEAM
// =============================================================================

/** A running dev session for one app: rebuilds and live console, error and build feeds. */
export interface AgentDevSession {
	readonly appId: string;
	/** Whether a preview is attached, so console and errors are live. */
	readonly previewAttached: boolean;
	/**
	 * Asks for a rebuild. Resolves early when a build is already running (the
	 * rebuild only queues), so callers must watch subscribeWatch for the result.
	 */
	rebuild(): Promise<void>;
	/**
	 * Listens to the preview's console output.
	 *
	 * @returns Unsubscribe function.
	 */
	subscribeConsole(l: (row: ConsoleRow) => void): () => void;
	/**
	 * Listens to the preview's runtime errors.
	 *
	 * @returns Unsubscribe function.
	 */
	subscribeErrors(l: (row: AppErrorRow) => void): () => void;
	/**
	 * Listens to build state changes.
	 *
	 * @returns Unsubscribe function.
	 */
	subscribeWatch(l: (s: WatchStatus) => void): () => void;
}

/** A preview lent to one check. A failed lease says why; a held one must be released when the check ends. */
export type PreviewLease = { readonly ok: true; readonly session: AgentDevSession; release(): void } | { readonly ok: false; readonly why: string };

// =============================================================================
// THE APP PAGE — the agent's own copy of an app (use_app)
// =============================================================================

// Only domain types cross here: actions in, outcomes, outline lines and problems out. No Window,
// Document, Element or iframe reaches agent code.

/** An app to preview: its manifest id, its folder under apps/ and its display name. */
export interface PreviewApp {
	readonly id: string;
	readonly folder: string;
	readonly name: string;
}

/**
 * An element of the agent's copy of an app, as the page outline names it: `e1`, `e2`, ...
 * A ref names the same element for the rest of the turn while that element stays on the page.
 * The tool parses the model's strings into this type; nothing else makes one.
 */
export type ElementRef = `e${number}`;

/** One thing the agent does in its copy of an app. The list runs in order and stops at the first failure. */
export type PageAction =
	| { readonly kind: 'click'; readonly ref: ElementRef }
	/** Replaces the field's value, as a person selecting all and typing would. */
	| { readonly kind: 'type'; readonly ref: ElementRef; readonly text: string }
	/** A native <select>, by option value or label. A custom dropdown is clicks. */
	| { readonly kind: 'select'; readonly ref: ElementRef; readonly value: string }
	/** A key ('Enter', 'Escape', 'Tab', 'ArrowDown', 'a') to the element, or to the focused one. */
	| { readonly kind: 'press'; readonly key: string; readonly ref?: ElementRef }
	/** Waits until the text shows on the page (case and spacing ignored). */
	| { readonly kind: 'wait_for'; readonly text: string; readonly timeoutMs: number };

export type PageActionKind = PageAction['kind'];

/**
 * How one action went. `target` is the accessible name of the element acted on, as it was then.
 * The outcomes of a use are as many as its actions, in the same order: everything after the first
 * `failed` is `not_run`.
 */
export type ActionOutcome =
	/** `changed`: the page's DOM changed before it went quiet. `notes`: what else happened (a dialog the page opened and how it was answered, a link that would open a new tab, a rebuild under the action). */
	| { readonly status: 'done'; readonly target?: string; readonly changed: boolean; readonly notes: readonly string[] }
	| { readonly status: 'failed'; readonly target?: string; readonly why: string }
	| { readonly status: 'not_run' };

/** A state shown after an outline line. */
export type OutlineState = 'checked' | 'disabled' | 'selected' | 'expanded' | 'collapsed';

/**
 * One line of the page outline: a visible element, or a run of text that sits in no element that
 * can be acted on. Names, values and text are whole: the agent hides secrets before it cuts them.
 */
export interface OutlineLine {
	/** Nesting under a dialog, form, list, menu or table; 0 at the top. Other wrappers add none. */
	readonly depth: number;
	/** The ARIA role ('button', 'textbox', 'heading', 'link', 'dialog', ...), or 'text'. */
	readonly role: string;
	/** The accessible name; for 'text', the text. */
	readonly name: string;
	/** Present only on elements that can be acted on. */
	readonly ref?: ElementRef;
	/** A field's value (a password's shows as dots). */
	readonly value?: string;
	readonly states: readonly OutlineState[];
}

/** Something the page raised during a use, apart from the actions' own outcomes. */
export interface PageProblem {
	/**
	 * console: a console.error from app code (build lines and the browser's ResizeObserver notice are left out).
	 * error: an uncaught error or unhandled rejection. crash: the shell's error boundary caught a render crash.
	 * not_ready: the app had not built or loaded when the page was read, so the outline shows the shell, not the app.
	 * dialog: an alert, confirm or prompt no action raised (on load, or between uses), and how it was answered.
	 */
	readonly kind: 'console' | 'error' | 'crash' | 'not_ready' | 'dialog';
	readonly text: string;
}

/** What one use of the page did, and the page after it. */
export interface PageUse {
	readonly outcomes: readonly ActionOutcome[];
	/** The whole page after the last action ran or failed: body, popup portal and overlays. */
	readonly outline: readonly OutlineLine[];
	readonly problems: readonly PageProblem[];
}

/**
 * The agent's own copy of an app, open for one turn. The host does every page job behind it:
 * waiting for the app to show the latest edit, finding elements by ref, sending events, waiting for
 * the page to go quiet, reading the outline, collecting errors, and showing the copy to the user with
 * each target outlined first.
 */
export interface AppPage {
	/**
	 * Runs `actions` in order once the app shows the latest work, stopping at the first failure, then
	 * reads the page. An empty list just reads it. A failed action is an outcome, never a throw.
	 *
	 * @param signal - The call's own deadline. When it aborts, the action under way fails ("ran out of
	 *   time"), the rest are not run, and the page is still read, so the call ends as a result.
	 * @throws PageGoneError once the page has closed (its turn ended) or left the app; a fresh copy needs a new openAppPage.
	 */
	use(actions: readonly PageAction[], signal: AbortSignal): Promise<PageUse>;
	/**
	 * Lends the page's preview to one check (check_app), after any use under way; no use starts until
	 * release(). The check rebuilds the app, so refs from before it may be gone.
	 *
	 * @param signal - Aborted when the user stops the run; a check still waiting for the page gives up.
	 * @returns `{ ok: false }` when the run stopped first, or the page is gone (closed, or off the app).
	 */
	lend(signal?: AbortSignal): Promise<PreviewLease>;
}

/** Thrown by AppPage.use once the page is gone: it closed, or it left the app and closed itself. */
export class PageGoneError extends Error {
	constructor(why: string) {
		super(why);
		this.name = 'PageGoneError';
	}
}

/**
 * A save that wrote nothing because the user dropped or replaced the editor's
 * text while it waited (Reload, Discard mine, Overwrite, Don't Save). Whatever
 * waits on it stops, and no editor shows it as a failure: the user did it.
 */
export class SaveDroppedError extends Error {
	constructor(path: string) {
		super(`${path} was not saved: its changes were dropped or replaced while the save waited its turn.`);
		this.name = 'SaveDroppedError';
	}
}

/** The open editors of a path with unsaved changes, as the agent's question about them drives them. */
export interface EditorControl {
	/**
	 * Saves each dirty editor in turn and calls `stored` as each one lands, so a
	 * later one's failure still counts as a change. Rejects when a save fails,
	 * and with SaveDroppedError when the user dropped the buffer while the save
	 * waited its turn.
	 */
	save(stored: () => void): Promise<void>;
	/** Drops the editor's buffer and shows the stored file again. */
	discard(): Promise<void>;
}

/** What the mounting app provides to the agent. */
export interface AgentHost {
	/** The workspace the agent reads and edits; its read-only `.rocketride/` holds the guides. */
	vfs: IWorkspaceFileSystem;
	/**
	 * The workspace's scope ('' for the user's own files, 'team-<id>' for a
	 * team's); a conversation runs only in the scope it started in. Hosts with
	 * one scope leave it out.
	 */
	readonly scopeKey?: string;
	/**
	 * A scope's name for the user (a team's name), when the host has it.
	 *
	 * @returns The name, or undefined to name the scope by its id.
	 */
	scopeName?(scopeKey: string): string | undefined;
	/** The open editor that holds a path, for the agent's question about unsaved changes; without it a dirty file is refused. */
	editor?(path: string): EditorControl | null;
	/**
	 * Creates a new app from a template.
	 *
	 * @returns The new app's id and its bare folder name under apps/ (e.g. 'daybook-ui', not 'apps/daybook-ui').
	 */
	scaffoldApp(req: { appName: string; displayName: string; template?: 'Blank' | 'Dashboard' }): Promise<{ appId: string; folder: string }>;
	/**
	 * Packs an app folder into a deployable bundle.
	 *
	 * @param folder - The app's bare folder name under apps/ (e.g. 'daybook-ui').
	 */
	packApp(folder: string): Promise<Uint8Array>;
	/**
	 * The running dev session for an app. A plain lookup: the app listings use it to mark which apps are
	 * open, so it must never start a preview.
	 *
	 * @returns The session, or null when none is running.
	 */
	devSession(appId: string): AgentDevSession | null;
	/**
	 * A dev session with a preview attached, for one check. The user's attached preview is used when there is
	 * one (release does nothing). Otherwise the host boots a hidden preview and release() tears it down.
	 *
	 * @param app - The app to preview: its manifest id, its folder under apps/ and its display name.
	 * @param signal - Aborted when the user stops the run; a boot still under way gives up.
	 */
	leasePreview(app: PreviewApp, signal?: AbortSignal): Promise<PreviewLease>;
	/**
	 * Opens the agent's own copy of an app: always a new hidden preview, never the user's. use_app reads
	 * and acts on it. It lives until `lifetime` aborts and then closes itself, which holds for a boot still
	 * running when `lifetime` aborts too. Hosts without app previews leave it out, and use_app refuses.
	 *
	 * @param opts.lifetime - The turn's end (`runEnded` in run.ts), never the Stop-only signal: a page tied
	 *   to Stop would outlive every turn that finishes normally.
	 * @param opts.conversationId - The chat whose live view shows the copy.
	 * @throws When the preview could not start (the message says why) or the team changed.
	 */
	openAppPage?(app: PreviewApp, opts: { lifetime: AbortSignal; conversationId: string }): Promise<AppPage>;
	/**
	 * The chat's view of the agent's copies of apps, for the chat's UI. A run never reads it. Hosts that
	 * open no app pages leave it out, and the chat shows no live view.
	 */
	watchFor?(conversationId: string): AgentWatchPlace;
	/**
	 * The user's approval mode and grants, live. Without it a run asks for
	 * everything the approval list rates as asking, nothing is always allowed,
	 * and the chat shows no mode switch.
	 */
	approvals?: HostApprovals;
	/**
	 * The user's limits for one turn, read when a turn starts. Without it a
	 * turn gets DEFAULT_LIMITS.
	 */
	limits?: { read(): AgentLimits };
	/**
	 * The user's last pick of a model, which a new conversation starts from. read() always returns a
	 * choice, the default for a garbled value. Without it a new conversation uses DEFAULT_MODEL.
	 */
	lastModel?: { read(): ModelChoice; write(choice: ModelChoice): void };
	/**
	 * Opens a workspace file in its editor, for a file link on a turn's card.
	 * Hosts without editors leave it out, and the link does nothing.
	 *
	 * @returns Whether an editor opened.
	 */
	openFile?(path: string): Promise<boolean>;
	/**
	 * Where the agent's events go: the shell's reporter for the app, read once at the app's root, which
	 * renders inside the shell's TelemetryProvider (rocket-ui's RocketApp). A component under the sidebar
	 * gets the shell's do-nothing reporter, so no agent code calls useReport() itself. Hosts without
	 * telemetry (tests) leave it out, and nothing is reported. Each turn binds it with turnReport.
	 */
	readonly report?: AgentReport;
}

// =============================================================================
// LIMITS — how far one turn goes before it pauses
// =============================================================================

/** A turn's limits. 0 turns a limit off. */
export interface AgentLimits {
	/** The most steps (waves) a turn takes; then it pauses with Continue. */
	readonly steps: number;
	/** The most a turn's model cost may reach, in USD; then it pauses with Continue. The approval mode never raises it. */
	readonly costUsd: number;
}

/** The limits of a turn whose host sets none: 60 steps and $2. */
export const DEFAULT_LIMITS: AgentLimits = { steps: 60, costUsd: 2 };

// =============================================================================
// APPROVAL SETTINGS — the user's mode and grants, as the agent reads them
// =============================================================================

/**
 * Ask: an action the approval list rates as asking waits for the user's OK.
 * Auto: it runs without asking. Auto judges nothing; it just doesn't ask, and
 * an action the list never allows stays refused.
 */
export type ApprovalMode = 'ask' | 'auto';

export { GRANTS, type Grant } from './grants';

/**
 * A value for every grant, built over GRANTS: the one place such a record is assembled.
 *
 * @param value - The value of each grant.
 */
export function grantsFrom(value: (grant: Grant) => boolean): Readonly<Record<Grant, boolean>> {
	return Object.fromEntries(GRANTS.map((grant) => [grant, value(grant)])) as Record<Grant, boolean>;
}

/** The user's approval settings at one moment. */
export interface ApprovalPrefs {
	readonly mode: ApprovalMode;
	/** The kinds the user has always allowed. */
	readonly grants: Readonly<Record<Grant, boolean>>;
}

/**
 * The user's approval settings as a run sees them. It reads them and hears
 * every change; it can turn a grant on for the user's "Always allow" click,
 * and has no way to set the mode.
 */
export interface ApprovalSettings {
	/**
	 * The settings now.
	 */
	read(): ApprovalPrefs;
	/**
	 * Calls back after every change.
	 *
	 * @param listener - Called with no arguments; read() has the new settings.
	 * @returns The unsubscribe.
	 */
	subscribe(listener: () => void): () => void;
	/**
	 * Turns a grant on. Called only for the user's "Always allow" click.
	 *
	 * @param kind - The grant the card offered.
	 */
	grant(kind: Grant): void;
}

/** The chat's mode switch: the same settings, plus the one thing only the user does, setting the mode. */
export interface ApprovalControls extends ApprovalSettings {
	/**
	 * Sets the mode for every agent chat at once.
	 */
	setMode(mode: ApprovalMode): void;
}

/**
 * The user's approval settings as the host hands them over, as two separate
 * handles: a run gets `run`, which has no way to set the mode, and only UI
 * code gets `controls`.
 */
export interface HostApprovals {
	/** What a run reads, hears and grants through. */
	readonly run: ApprovalSettings;
	/** What the chat's mode switch uses. */
	readonly controls: ApprovalControls;
}

// =============================================================================
// REGISTRY
// =============================================================================

/** The installed host; null until the app calls setAgentHost(). */
let current: AgentHost | null = null;

/**
 * Installs the host. Call once at startup, before any agent runs.
 *
 * @param host - The host to install; replaces any earlier one.
 */
export function setAgentHost(host: AgentHost): void {
	current = host;
}

/**
 * The installed host, or a loud failure when startup never set one.
 */
export function getAgentHost(): AgentHost {
	if (!current) throw new Error('The agent host is not configured — rocket-ui sets it at startup.');
	return current;
}

/**
 * The installed host, or null when none is set. For UI that renders in hosts
 * that may not serve the agent; agent code uses getAgentHost().
 */
export function findAgentHost(): AgentHost | null {
	return current;
}
