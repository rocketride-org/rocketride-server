// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

// =============================================================================
// OPEN-TOOL NOTE — a running node's button (plan 3.6)
// =============================================================================
//
// A running node that a front end talks to (the chat and dropper sources,
// later the database and explorer bases) emits an `open-tool` status note:
// the app id of that front end, with the node's own id beside it. The
// server fills the note's identity placeholders per control, so by the time
// it reaches a host the note names ONE {address, nodeId}. The host op
// `openTool(appId, address, nodeId)` opens that app's document bound to the
// pair; no URL is built, no credential rides along.
//
// Pure: the note walk, the label and the document key are decided here and
// tested without React, so both hosts and the renderer agree on one word.
// =============================================================================

/** The app ids the platform's pipe-bound front ends register under. */
export const OPEN_TOOL_LABELS: Readonly<Record<string, string>> = {
	'rocketride.chat': 'Open Chat',
	'rocketride.dropper': 'Open Dropper',
	'rocketride.sql': 'Explore',
};

/** One node's resolved button: what to open, where it is bound. */
export interface IOpenToolNote {
	/** The front end's app id (`rocketride.chat`, `rocketride.dropper`, `rocketride.sql`, …). */
	appId: string;
	/** The node the document binds to: the component id in the pipeline. */
	nodeId: string;
	/** The running control's address, as the server filled it. */
	address: string;
	/** The button's label: the note's own `button-text`, else the app's default word. */
	label: string;
}

/**
 * The label for a front end's button.
 *
 * @param appId - The front end's app id.
 * @param buttonText - The note's own `button-text`, when the node names one.
 * @returns The note's text, else the app's default word, else a generic Open.
 */
export function openToolLabel(appId: string, buttonText?: string): string {
	return buttonText || OPEN_TOOL_LABELS[appId] || 'Open';
}

/**
 * Reads the `open-tool` notes out of a task status's notes list.
 *
 * A note is one dict with `open-tool` (the app id), `nodeId` and `address`
 * all present as non-empty strings; anything else in the list is not a
 * button (the endpoint info without a front end, free-text notes). A note
 * the server could not fill (a placeholder left in `nodeId` or `address`)
 * is not a button either: a document cannot bind to a placeholder.
 *
 * @param notes - The status body's notes, as delivered.
 * @returns Every button the notes carry, in list order.
 */
export function openToolNotes(notes: ReadonlyArray<unknown> | undefined): IOpenToolNote[] {
	if (!notes) return [];
	const out: IOpenToolNote[] = [];
	for (const note of notes) {
		if (note === null || typeof note !== 'object') continue;
		const record = note as Record<string, unknown>;
		const appId = record['open-tool'];
		const nodeId = record['nodeId'];
		const address = record['address'];
		if (typeof appId !== 'string' || !appId) continue;
		if (typeof nodeId !== 'string' || !nodeId || nodeId.includes('{')) continue;
		if (typeof address !== 'string' || !address || address.includes('{')) continue;
		const buttonText = record['button-text'];
		out.push({ appId, nodeId, address, label: openToolLabel(appId, typeof buttonText === 'string' ? buttonText : undefined) });
	}
	return out;
}

/**
 * The `open-tool` buttons of ONE node, looked up across every running
 * source's status: a database node's note arrives in the status of the
 * source whose engine runs it, so a non-source node finds its button by
 * `nodeId` in the whole map rather than in a status of its own. One button
 * per `{appId, address, nodeId}`, in first-seen order.
 *
 * @param statuses - The per-source status map (undefined = nothing running).
 * @param nodeId - The node whose buttons to collect.
 * @returns The node's buttons.
 */
export function openToolNotesFor(statuses: Readonly<Record<string, { notes?: ReadonlyArray<unknown> } | undefined>> | undefined, nodeId: string): IOpenToolNote[] {
	if (!statuses) return [];
	const seen = new Set<string>();
	const out: IOpenToolNote[] = [];
	for (const status of Object.values(statuses)) {
		for (const note of openToolNotes(status?.notes)) {
			if (note.nodeId !== nodeId) continue;
			const key = `${note.appId}/${note.address}/${note.nodeId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(note);
		}
	}
	return out;
}

/**
 * The SOURCE's endpoint note in a status's notes list: the note carrying a
 * data door (`url-link`, a webhook), else the `open-tool` note of the source
 * itself (a URL-less chat or dropper source). A database node's `open-tool`
 * note merged into the same list is never the endpoint, wherever it stands:
 * the source is told apart by its id (`sourceId`, the status entry's
 * component) or, when the caller has none, by the address naming it as its
 * last segment.
 *
 * @param notes - The status body's notes, as delivered.
 * @param sourceId - The source component the status belongs to, when known.
 * @returns The endpoint note, or null when the list has none.
 */
export function sourceEndpointNote<T>(notes: ReadonlyArray<T> | undefined, sourceId?: string): T | null {
	if (!notes) return null;
	let door: T | null = null;
	let own: T | null = null;
	for (const note of notes) {
		if (note === null || typeof note !== 'object') continue;
		const record = note as unknown as Record<string, unknown>;
		if (door === null && typeof record['url-link'] === 'string') door = note;
		if (own !== null || typeof record['open-tool'] !== 'string') continue;
		const nodeId = record['nodeId'];
		const address = record['address'];
		if (typeof nodeId !== 'string' || typeof address !== 'string') continue;
		const isSource = sourceId !== undefined ? nodeId === sourceId : address.endsWith(`.${nodeId}`);
		if (isSource) own = note;
	}
	return door ?? own;
}

/** One button of the actions strip, as the renderer draws it. */
export interface IActionButton {
	/** Stable React key. */
	key: string;
	/** `tool`: opens a node's front end; `endpoint`: opens the Endpoint Info modal. */
	kind: 'tool' | 'endpoint';
	/** The button's text. */
	label: string;
	/** Whether the button is inert: the strip shows LIVE state while the panel replays a past run. */
	disabled: boolean;
	/** The note behind a `tool` button. */
	tool?: IOpenToolNote;
}

/**
 * The actions strip's buttons, in order: one per tool note, then Endpoint
 * Info when the source has an endpoint note. During a replay every button
 * is disabled — the strip acts on the live task, not on the replayed
 * moment, and a dimmed wrapper alone stops the pointer, not the keyboard.
 *
 * @param tools - The node's front-end buttons.
 * @param hasEndpointInfo - Whether the source has an endpoint note to show.
 * @param disabled - The panel's replay state.
 * @returns The buttons to draw; empty = nothing to render.
 */
export function actionButtons(tools: ReadonlyArray<IOpenToolNote>, hasEndpointInfo: boolean, disabled: boolean): IActionButton[] {
	const out: IActionButton[] = tools.map((tool) => ({ key: `${tool.appId}/${tool.address}/${tool.nodeId}`, kind: 'tool', label: tool.label, disabled, tool }));
	if (hasEndpointInfo) out.push({ key: 'endpoint', kind: 'endpoint', label: 'Endpoint Info', disabled });
	return out;
}

/**
 * The document key a tool document binds under: `<address>/<nodeId>`, so the
 * tool document URI is `tool:<appId>/<address>/<nodeId>` in every host.
 *
 * @param address - The running control's address.
 * @param nodeId - The bound node's component id.
 * @returns The per-document key.
 */
export function openToolDocKey(address: string, nodeId: string): string {
	return `${address}/${nodeId}`;
}

/** An address (two or three dot-free segments) with an optional `/<nodeId>`. */
const TOOL_DOC_KEY = /^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)(?:\/([A-Za-z0-9_-]+))?$/;

/**
 * The inverse of {@link openToolDocKey}, for the apps a tool document mounts:
 * the address and, when the key carries one, the node. A bare address is
 * still a valid key (the chat and dropper sources bind by address alone);
 * anything else (a saved-connection id, an editor key) is not a tool key.
 *
 * @param docKey - The host document key.
 * @returns `{address, nodeId?}`, or null when the key is not address-shaped.
 */
export function parseToolDocKey(docKey: string): { address: string; nodeId?: string } | null {
	const match = TOOL_DOC_KEY.exec(docKey);
	if (!match) return null;
	return match[2] ? { address: match[1], nodeId: match[2] } : { address: match[1] };
}

/**
 * The tab title for a tool document: the address alone when the node IS the
 * address's source (a chat or dropper source), else the address and the node.
 *
 * @param address - The running control's address.
 * @param nodeId - The bound node's component id.
 * @returns The title.
 */
export function openToolTitle(address: string, nodeId: string): string {
	return address.endsWith(`.${nodeId}`) ? address : `${address} · ${nodeId}`;
}
