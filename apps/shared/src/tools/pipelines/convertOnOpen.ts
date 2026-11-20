// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Convert-on-open — the pure half of the IDE door (plan §5.6.8, B20).
 *
 * A pipeline whose node config is in the pre-format-switch shape shows up on
 * the canvas as nodes with UNKNOWN config keys (the red gear). When any node
 * does and the host is connected, the editor calls the server's
 * `rrext_convert` ONCE per document revision, writes the converted text back
 * through the document (the API Params page's path), shows one banner with
 * the converter's warnings, and leaves the components the converter refused
 * red with its message. The server converts; nothing here reads a schema's
 * `legacy` block or rewrites a config.
 *
 * Everything that DECIDES lives in this module so it is testable without a
 * canvas or a client: which nodes trigger, the once-per-revision rule, the
 * no-retry-after-errors rule, the gear text, and the banner model. The
 * editor frame (PipelineEditor) owns the state and the call.
 */

import { validateConfig } from 'shared/components/node-config';
import type { INodeSchema } from 'shared/components/node-config';

// =============================================================================
// Types
// =============================================================================

/** The slice of a canvas node (or a `.pipe` component) the trigger reads. */
export interface IConfigShapeNode {
	/** The component id. */
	id: string;
	/** The service provider key. */
	provider?: string;
	/** The stored config tree. */
	config?: Record<string, unknown>;
}

/** One converter note, as the SDK's `ConvertResult` carries it. */
export interface IConvertNote {
	/** The human-readable message. */
	message: string;
	/** The component the note belongs to; absent for pipeline-level notes. */
	id?: string;
}

/** The SDK's `ConvertResult`, by shape (no SDK import in a pure module). */
export interface IConvertOutcome {
	/** The converted pipeline (the input when nothing changed). */
	pipeline: Record<string, unknown>;
	/** What was changed, dropped or filled in. */
	warnings: IConvertNote[];
	/** Components the converter refused. */
	errors: IConvertNote[];
	/** Whether anything changed. */
	touched: boolean;
}

/**
 * What the editor remembers between attempts. Both signatures are document
 * text signatures ({@link documentSig}): a document is converted at most
 * once per text, and the text the editor itself wrote is never sent back.
 */
export interface IConvertOnOpenState {
	/** The text signature of the last document sent to the converter. */
	attemptedSig: string | null;
	/** The text signature of the last converted document the editor wrote. */
	writtenSig: string | null;
}

/** The banner the editor shows after a conversion. */
export interface IConversionBanner {
	/** `error` when the converter refused a component; `warning` otherwise. */
	variant: 'warning' | 'error';
	/** The one-line summary. */
	title: string;
	/** The converter's notes, one per line, component-prefixed. */
	items: string[];
}

/** What one converter reply does to the editor. */
export interface IConvertApplied {
	/** The state after the reply. */
	state: IConvertOnOpenState;
	/** The document to write through `onContentChanged`, or null when nothing changed. */
	nextProject: Record<string, unknown> | null;
	/** The banner to show, or null when the converter had nothing to say. */
	banner: IConversionBanner | null;
	/** The converter's per-component refusal, by component id. */
	nodeErrors: Record<string, string>;
}

// =============================================================================
// Constants
// =============================================================================

/** The state before any attempt. */
export const INITIAL_CONVERT_STATE: IConvertOnOpenState = { attemptedSig: null, writtenSig: null };

/** The red gear's text while the host cannot reach a server. */
export const CONNECT_TO_CONVERT = 'connect to convert';

// =============================================================================
// The trigger
// =============================================================================

/**
 * The nodes whose stored config carries a key their schema does not declare —
 * the shape a pre-format-switch config shows up in. A node whose provider has
 * no full definition yet (the bulk catalog is summary-only) is not counted:
 * the canvas reports again when the definition lands.
 *
 * @param nodes - The canvas nodes (or the `.pipe` components).
 * @param servicesJson - The catalog with the fetched full definitions merged in.
 * @returns The ids of the nodes that trigger a conversion, in canvas order.
 */
export function unknownConfigKeyNodes(nodes: readonly IConfigShapeNode[], servicesJson: Record<string, Partial<INodeSchema> | undefined>): string[] {
	const ids: string[] = [];
	for (const node of nodes) {
		if (!node.provider) continue;
		const service = servicesJson[node.provider];
		if (!service || !Array.isArray(service.properties)) continue;
		const problems = validateConfig(service, node.config ?? {});
		if (problems.some((problem) => problem.unknownKey)) ids.push(node.id);
	}
	return ids;
}

// =============================================================================
// Once per revision
// =============================================================================

/**
 * The text signature a conversion is keyed on: the pipeline's name and its
 * components, which is what the converter reads and rewrites. Editor-only
 * fields (viewport, revision counters) are left out so a view change never
 * reads as a new text.
 *
 * @param project - The document.
 * @returns The signature.
 */
export function documentSig(project: unknown): string {
	const doc = project && typeof project === 'object' ? (project as Record<string, unknown>) : {};
	try {
		return JSON.stringify({ name: doc.name ?? null, components: doc.components ?? [] });
	} catch {
		return ' nosig';
	}
}

/**
 * Whether the editor calls the converter now.
 *
 * It does when some node carries unknown keys, the host is connected, and
 * this text has neither been sent before (an attempt that returned errors,
 * or failed, is not retried until the text changes) nor been written by the
 * editor itself (the converter's own output is never sent back: the result
 * is idempotent, the call is not free).
 *
 * @param state - The editor's memory.
 * @param sig - The current document's signature.
 * @param unknownNodeCount - How many nodes carry unknown keys.
 * @param connected - Whether a client can reach the server.
 * @returns True to call `rrext_convert`.
 */
export function shouldConvert(state: IConvertOnOpenState, sig: string, unknownNodeCount: number, connected: boolean): boolean {
	if (unknownNodeCount === 0 || !connected) return false;
	return sig !== state.attemptedSig && sig !== state.writtenSig;
}

/**
 * The state once a call is in flight for `sig`: the same text is not sent twice
 * whatever the reply turns out to be.
 *
 * @param state - The editor's memory.
 * @param sig - The signature of the document being sent.
 * @returns The state to hold while the call is pending.
 */
export function markAttempted(state: IConvertOnOpenState, sig: string): IConvertOnOpenState {
	return { ...state, attemptedSig: sig };
}

// =============================================================================
// The reply
// =============================================================================

/**
 * Applies one converter reply: the document to write (the converted pipeline
 * over the current document, with the revision bumped so the canvas reloads
 * it instead of re-serializing its stale tree), the banner, the per-node
 * refusals, and the state that keeps the written text from going back.
 *
 * @param state - The editor's memory (after {@link markAttempted}).
 * @param project - The document that was sent.
 * @param result - The converter's reply.
 * @returns What to do with it.
 */
export function applyConvertResult(state: IConvertOnOpenState, project: Record<string, unknown>, result: IConvertOutcome): IConvertApplied {
	const nodeErrors: Record<string, string> = {};
	for (const note of result.errors) {
		if (!note.id) continue;
		nodeErrors[note.id] = nodeErrors[note.id] ? `${nodeErrors[note.id]}; ${note.message}` : note.message;
	}

	let nextProject: Record<string, unknown> | null = null;
	let next = state;
	if (result.touched) {
		const revision = typeof project.docRevision === 'number' ? project.docRevision : 0;
		nextProject = { ...project, ...result.pipeline, docRevision: revision + 1 };
		next = { ...state, writtenSig: documentSig(nextProject) };
	}

	return { state: next, nextProject, banner: conversionBanner(result), nodeErrors };
}

/**
 * The banner for one reply, or null when the converter neither changed nor
 * refused anything (a current-format document with a stray key is the
 * author's to fix, not the converter's to announce).
 *
 * @param result - The converter's reply.
 * @returns The banner model.
 */
export function conversionBanner(result: IConvertOutcome): IConversionBanner | null {
	if (!result.touched && result.errors.length === 0) return null;
	const prefixed = (note: IConvertNote): string => (note.id ? `${note.id}: ${note.message}` : note.message);
	const items = [...result.errors.map(prefixed), ...result.warnings.map(prefixed)];
	if (result.errors.length > 0) {
		const refused = new Set(result.errors.map((note) => note.id).filter((id): id is string => !!id)).size;
		const head = refused === 1 ? '1 node could not be converted' : `${refused} nodes could not be converted`;
		const tail = result.touched ? ' to the current config format; the others were. Fix the red nodes, then save.' : ' to the current config format. Fix the red nodes, then save.';
		return { variant: 'error', title: `${head}${tail}`, items };
	}
	return { variant: 'warning', title: 'This pipeline was converted to the current config format. Save to keep it.', items };
}

// =============================================================================
// The red gear
// =============================================================================

/**
 * The text the red gear carries per flagged node: the converter's refusal
 * where it gave one, "connect to convert" while no server can be asked, and
 * nothing for a node the converter had no opinion on.
 *
 * @param unknownNodeIds - The nodes that carry unknown keys.
 * @param connected - Whether a client can reach the server.
 * @param nodeErrors - The converter's refusals by component id.
 * @returns The gear text by node id.
 */
export function gearMessages(unknownNodeIds: readonly string[], connected: boolean, nodeErrors: Record<string, string>): Record<string, string> {
	const messages: Record<string, string> = {};
	for (const id of unknownNodeIds) {
		if (!connected) messages[id] = CONNECT_TO_CONVERT;
		else if (nodeErrors[id]) messages[id] = nodeErrors[id];
	}
	return messages;
}
