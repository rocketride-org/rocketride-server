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
// THE REPLAY COPY — the live answer pipeline with Discord and Slack cut out
// =============================================================================
//
// This is the reference bot's isolation, restored. `eval/replay.ts` in the
// reference never touched Discord: it regenerated the production pipes into
// `pipelines/.eval/*.eval.pipe` under their own `project_id`, asserted the copies
// could not collide with production, fed each golden question straight in, and
// read the answer off the return value. This module is that regeneration, done
// in memory on the pipeline the app is actually running.
//
// FOUR TRANSFORMS, AND WHY EACH ONE IS THE WHOLE POINT:
//
// 1. THE SOURCE BECOMES A WEBHOOK. The live pipes are sourced by the `discord`
//    component, whose input is Discord itself — there is no way to ask it a
//    question except by posting one where people can read it. The webhook source
//    emits `tags, text, json, audio, video, image, questions`, a SUPERSET of the
//    discord source's `text, image, audio, video, tags`, so every downstream edge
//    stays valid after the swap and `client.send(token, question, …,
//    'text/plain')` reaches the agent on the `text` lane — which is the same lane
//    the node writes a brand-new question to (`pipe.writeText(message.content)`).
// 2. SLACK IS REMOVED, COMPONENT AND PROMPT. Deleting `tool_slack_1` is not
//    enough: the agent's instructions carry a HARD RULE telling it to call
//    `tool_slack_1_message_post` before every escalation, and an agent told to
//    call a tool that is not there spends a turn failing. So the rule is dropped
//    and the bracketed `[calls tool_slack…]` stage direction is cut out of the
//    examples — leaving the example's REPLY text, which is what teaches the
//    escalation wording the scoring then reads.
// 3. THE PROJECT ID CHANGES. `(project_id, source)` IS the task identity the
//    engine keys on, so a copy that kept the live id would be the same task: the
//    first `client.use` would either attach to the running bot or restart it.
//    {@link REPLAY_COPY_PROJECT_ID} is a constant nothing else in the app uses.
// 4. CAPTURE IS REMOVED. The bot's pipeline carries a `capture_db` component
//    that writes every question, reply and reaction into the dashboard
//    database (`resolvePipeline`). A replay asks the bot ten questions nobody
//    asked, and those must not land in Conversations as traffic, be graded, or
//    enter the Scorecard's denominator. So the database component goes, along
//    with the `captureEvents` / `captureNodeId` / `captureSource` keys that
//    point at it — and the guard refuses a copy where capture survived.
// 5. THE RESULT IS ASSERTED, NOT ASSUMED. {@link assertReplayCopyIsolated} is the
//    reference's `assertIsolated`, widened: it re-reads the finished document and
//    refuses to let a run start if anything that could reach Discord, Slack or
//    the dashboard database survived, or if the id collides with any pipe the
//    app ships.
//
// Everything here is PURE — no engine, no state, no clock. `src/eval/replay.ts`
// owns the task; this module owns the document, and `replayCopy.selftest.ts`
// checks the document against the real shipped pipe.
// =============================================================================

import { CAPTURE_PIPELINE, PIPELINES, pipeIdentity } from '../pipeline/resolve';
import { DATA_PROJECT_ID } from '../db/config';
import { EVAL_PIPES } from './pipes';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * The copy's `project_id` — half of the task identity, and the isolation.
 *
 * A literal nothing else in the app uses. The live pipes' ids are in their
 * `.pipe` files, the eval pipes' in theirs, and
 * {@link assertReplayCopyIsolated} refuses to run if this one ever equals any of
 * them.
 */
export const REPLAY_COPY_PROJECT_ID = '0f6a2c9e-5b1d-4e7a-9c3f-8d2b7a1e4c60';

/** The copy's source component id — the other half of the identity. */
export const REPLAY_COPY_SOURCE = 'replay_webhook';

/** The display name the swapped-in source carries. */
export const REPLAY_COPY_SOURCE_NAME = 'Test webhook';

/**
 * Providers a replay copy may never contain.
 *
 * `discord` is the live source; `tool_discord` and `tool_slack` are the two tools
 * that can speak to the outside world on their own. Everything else in the live
 * pipe is read-only (`tool_github` ×3 with `readOnly: true`, a GET-only
 * `tool_http_request` behind a URL whitelist) or local.
 */
export const FORBIDDEN_PROVIDERS: string[] = ['discord', 'tool_discord', 'tool_slack'];

/**
 * The two database providers a capture component can be.
 *
 * Not in {@link FORBIDDEN_PROVIDERS}, because a database node is not a way to
 * reach the outside world and the description line should not claim a replay
 * "removed" one from a pipe that never had it. It is still refused by the
 * guard — see {@link assertReplayCopyIsolated} — when it is wired to the copy's
 * source or to a removed tool, which is what a capture component is.
 */
export const DATABASE_PROVIDERS: string[] = ['db_postgres', 'rocketride_sql'];

/** The node config keys that turn server-side capture on. */
export const CAPTURE_KEYS: string[] = ['captureEvents', 'captureNodeId', 'captureTable', 'captureSource'];

/** The instruction entry the copy drops entirely — Slack's HARD RULE. */
const SLACK_RULE_PREFIX = 'SLACK PAGING';

/**
 * The bracketed stage direction the copy cuts out of an example reply.
 *
 * Replaced with a single space rather than deleted outright, so the words on
 * either side of it do not run together.
 */
const SLACK_CALL_CLAUSE = /\s*\[calls tool_slack[^\]]*\]\s*/gi;

/** Any mention of the Slack tool, for the guard. */
const ANY_SLACK_TOOL = /tool_slack/i;

/** The Slack HARD RULE, for the guard. */
const ANY_SLACK_RULE = /SLACK PAGING/i;

// =============================================================================
// TYPES
// =============================================================================

/** One pipeline component, as far as this module needs to know it. */
type Component = Record<string, unknown>;

/** What the tab says about the copy it is about to run. */
export interface ReplayCopyDescription {
	/** The copy's `project_id`. */
	projectId: string;
	/** The copy's source component id. */
	source: string;
	/** How many components survived. */
	componentCount: number;
	/** Every provider in the copy, in document order, deduplicated. */
	providers: string[];
	/** Which forbidden providers are confirmed ABSENT — what the copy cut out. */
	removed: string[];
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Deep-clone a JSON document.
 *
 * The same `JSON.parse(JSON.stringify(…))` `resolvePipeline` uses: these
 * documents are plain JSON, and a copy that shared structure with the live
 * pipeline would be one mutation away from editing the running bot's graph.
 *
 * @param value - Any JSON value.
 * @returns An independent copy.
 */
function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The components of a pipeline document.
 *
 * @param pipeline - A pipeline document.
 * @returns The components array, or [] when the document has none.
 */
function componentsOf(pipeline: Record<string, unknown>): Component[] {
	return Array.isArray(pipeline.components) ? (pipeline.components as Component[]) : [];
}

/**
 * The id of a pipeline's source component.
 *
 * The server's own resolution order, as `sourceOf` in `src/eval/pipes.ts` reads
 * it: the top-level `source` field when the document names one, otherwise the
 * single component whose `config.mode` is `'Source'`.
 *
 * @param pipeline - A pipeline document.
 * @returns The source component's id, or '' when it declares none.
 */
export function sourceIdOf(pipeline: Record<string, unknown>): string {
	const declared = typeof pipeline.source === 'string' ? pipeline.source : '';
	if (declared.length > 0) return declared;
	const source = componentsOf(pipeline).find((component) => {
		const config = (component.config ?? {}) as Record<string, unknown>;
		return config.mode === 'Source';
	});
	return String(source?.id ?? '');
}

/**
 * Rewrite or drop the `from` references of one edge list.
 *
 * Both of a component's wiring keys (`input` for data lanes, `control` for an
 * agent's tools) are the same `{ …, from }` shape, so they are handled by one
 * function: an entry naming a RENAMED component is repointed, an entry naming a
 * REMOVED one is dropped, and anything else is left alone.
 *
 * @param edges - The value of a component's `input` or `control` key.
 * @param renamed - Old component id to new component id.
 * @param removed - Component ids that no longer exist.
 * @returns The rewritten edges, or undefined when there were none to rewrite.
 */
function rewriteEdges(edges: unknown, renamed: Map<string, string>, removed: Set<string>): Record<string, unknown>[] | undefined {
	if (!Array.isArray(edges)) return undefined;
	const out: Record<string, unknown>[] = [];
	for (const edge of edges) {
		if (edge === null || typeof edge !== 'object' || Array.isArray(edge)) continue;
		const entry = edge as Record<string, unknown>;
		const from = typeof entry.from === 'string' ? entry.from : '';
		if (removed.has(from)) continue;
		const to = renamed.get(from);
		out.push(to === undefined ? entry : { ...entry, from: to });
	}
	return out;
}

/**
 * Strip Slack out of every array of strings in a value.
 *
 * Walks the whole tree rather than the two keys that are known to carry
 * instructions today (`instructions` and `default.instructions`), because an
 * agent's config is PROFILE-SHAPED: the editor writes the active profile's
 * fields at the top level and keeps the others in blocks beside them, so a pipe
 * saved from a different profile puts the same instruction list somewhere this
 * module has never heard of. The transform is the same wherever it lives.
 *
 * @param value - Any JSON value from an agent component's config.
 * @returns The value with the Slack rule dropped and the Slack stage direction
 *          cut out of whatever remains.
 */
function stripSlackFromStrings(value: unknown): unknown {
	if (Array.isArray(value)) {
		const strings = value.length > 0 && value.every((entry) => typeof entry === 'string');
		if (strings) {
			return (value as string[]).filter((entry) => !entry.trimStart().startsWith(SLACK_RULE_PREFIX)).map((entry) => entry.replace(SLACK_CALL_CLAUSE, ' '));
		}
		return value.map((entry) => stripSlackFromStrings(entry));
	}
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			out[key] = stripSlackFromStrings(entry);
		}
		return out;
	}
	return value;
}

/**
 * Drop the capture keys from anywhere in a config tree.
 *
 * The whole tree rather than the two places they are written today, for the
 * reason {@link stripSlackFromStrings} walks the whole tree: an editor-saved
 * component keeps its inactive profiles as blocks beside the active one, and
 * `captureEvents` in one of those is still `captureEvents` the moment someone
 * switches profile.
 *
 * @param value - Any JSON value from a component's config.
 * @returns The value without {@link CAPTURE_KEYS}.
 */
function stripCaptureKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((entry) => stripCaptureKeys(entry));
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			if (CAPTURE_KEYS.includes(key)) continue;
			out[key] = stripCaptureKeys(entry);
		}
		return out;
	}
	return value;
}

/**
 * Whether anything in a tree still turns capture on.
 *
 * The positive form of {@link stripCaptureKeys}, for the guard: the component
 * can be gone while a node is still told to write to it, which costs the node
 * a failing write per event and — worse — would write if the component ever
 * came back.
 *
 * @param value - Any JSON value.
 * @returns True when `captureEvents: true` appears anywhere.
 */
function hasCaptureEnabled(value: unknown): boolean {
	if (Array.isArray(value)) return value.some((entry) => hasCaptureEnabled(entry));
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (record.captureEvents === true) return true;
		return Object.values(record).some((entry) => hasCaptureEnabled(entry));
	}
	return false;
}

/** The `from` ids on a component's `control` list. */
function controlSources(component: Component): string[] {
	const control = component.control;
	if (!Array.isArray(control)) return [];
	return control
		.filter((edge): edge is Record<string, unknown> => edge !== null && typeof edge === 'object' && !Array.isArray(edge))
		.map((edge) => (typeof edge.from === 'string' ? edge.from : ''))
		.filter((from) => from.length > 0);
}

/**
 * Every string anywhere in a JSON tree.
 *
 * @param value - Any JSON value.
 * @param found - Accumulator, for the recursion.
 * @returns Every string in the tree, keys included — a guard that ignored keys
 *          would pass a document whose component was keyed `tool_slack_1`.
 */
function everyString(value: unknown, found: string[] = []): string[] {
	if (typeof value === 'string') {
		found.push(value);
		return found;
	}
	if (Array.isArray(value)) {
		for (const entry of value) everyString(entry, found);
		return found;
	}
	if (value !== null && typeof value === 'object') {
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			found.push(key);
			everyString(entry, found);
		}
	}
	return found;
}

// =============================================================================
// THE LIVE IDENTITIES
// =============================================================================

/**
 * Every `project_id` the app can already have running.
 *
 * The four answer pipes, the shadow capture pipe, the eval loop's own pipes
 * and the DATA PIPE the dashboard reads through. Derived rather than listed
 * so a new pipe cannot be added to the app without the guard knowing about it
 * — which is the failure the reference's `assertIsolated` existed to prevent.
 */
export const LIVE_PROJECT_IDS: string[] = [...Object.values(PIPELINES).map((pipe) => pipeIdentity(pipe).projectId), pipeIdentity(CAPTURE_PIPELINE).projectId, ...Object.values(EVAL_PIPES).map((pipe) => pipeIdentity(pipe.pipeline).projectId), DATA_PROJECT_ID].filter((id) => id.length > 0);

// =============================================================================
// THE COPY
// =============================================================================

/**
 * Build the replay copy of a resolved live pipeline.
 *
 * The caller passes what the BOT would start —
 * `resolvePipeline(PIPELINES[settings.pipeline.pipe], settings)` — so the copy
 * carries the same prompts, the same retrieval, the same model and the same
 * Settings as the bot the run is meant to be measuring. Then, in order:
 *
 * 1. the `discord` source becomes a webhook source called
 *    {@link REPLAY_COPY_SOURCE}, keeping the original's `ui` so the copy opens in
 *    the canvas looking like the pipe it came from; every `input[].from`,
 *    `control[].from` and the top-level `source` field that named the old id are
 *    repointed at it;
 * 2. every `tool_slack` component is removed (and `tool_discord` too, defensively
 *    — no shipped pipe has one, and a pipe that grew one must not reach a replay),
 *    along with every edge that fed from one;
 * 3. the CAPTURE component is removed — a database component wired from the
 *    source or from one of the tools just removed — so a replay's ten
 *    questions never reach the dashboard database;
 * 4. every component loses `captureEvents`, `captureNodeId`,
 *    `captureTable` and `captureSource`, and every
 *    agent component loses the Slack rule and the Slack stage direction — see
 *    {@link stripCaptureKeys} and {@link stripSlackFromStrings};
 * 5. `project_id` becomes {@link REPLAY_COPY_PROJECT_ID}.
 *
 * The input is never mutated.
 *
 * @param live - The RESOLVED live pipeline document.
 * @returns The copy, ready for {@link assertReplayCopyIsolated}.
 */
export function buildReplayCopy(live: Record<string, unknown>): Record<string, unknown> {
	const copy = clone(live);
	const components = componentsOf(copy);

	// --- 1. the source ------------------------------------------------------
	const renamed = new Map<string, string>();
	const swapped: Component[] = components.map((component) => {
		if (component.provider !== 'discord') return component;
		const oldId = String(component.id ?? '');
		if (oldId.length > 0) renamed.set(oldId, REPLAY_COPY_SOURCE);
		const source: Component = {
			id: REPLAY_COPY_SOURCE,
			provider: 'webhook',
			name: REPLAY_COPY_SOURCE_NAME,
			config: {
				hideForm: true,
				mode: 'Source',
				parameters: {},
				type: 'webhook',
				name: 'Webhook',
			},
		};
		// The original's position, so the copy opens where the pipe it came from
		// does. Absent on a hand-built document, and absent then too.
		if (component.ui !== undefined) source.ui = component.ui;
		return source;
	});

	// --- 2. the tools that can reach the outside world ----------------------
	const removed = new Set<string>();
	const withoutTools = swapped.filter((component) => {
		const provider = String(component.provider ?? '');
		if (provider !== 'tool_slack' && provider !== 'tool_discord') return true;
		removed.add(String(component.id ?? ''));
		return false;
	});

	// --- 3. the capture component -------------------------------------------
	// A database component wired FROM the source (under either its old id or
	// the new one) or from a tool that just went IS the capture component —
	// that wiring is what `resolvePipeline` builds and nothing else does. A
	// database wired from somewhere else is left alone: it would be part of
	// the answer, and a replay is supposed to measure the pipe as it runs.
	const kept = withoutTools.filter((component) => {
		if (!DATABASE_PROVIDERS.includes(String(component.provider ?? ''))) return true;
		const wired = controlSources(component).some((from) => renamed.has(from) || removed.has(from) || from === REPLAY_COPY_SOURCE);
		if (!wired) return true;
		removed.add(String(component.id ?? ''));
		return false;
	});

	// --- the wiring, for all three of the above -----------------------------
	copy.components = kept.map((component) => {
		const out: Component = { ...component };
		const input = rewriteEdges(component.input, renamed, removed);
		if (input !== undefined) out.input = input;
		const control = rewriteEdges(component.control, renamed, removed);
		if (control !== undefined) out.control = control;

		// --- 4. the capture keys, and the prompts ----------------------------
		// The keys come off EVERY component, not just the two that carry them
		// today: `captureEvents` left behind is a node told to write to a
		// component that is not there.
		if (out.config !== undefined) {
			out.config = stripCaptureKeys(out.config) as Record<string, unknown>;
		}
		if (String(component.provider ?? '').startsWith('agent_') && out.config !== undefined) {
			out.config = stripSlackFromStrings(out.config) as Record<string, unknown>;
		}
		return out;
	});

	const declared = typeof copy.source === 'string' ? copy.source : '';
	const repointed = renamed.get(declared);
	if (repointed !== undefined) copy.source = repointed;

	// --- 5. the identity ---------------------------------------------------
	copy.project_id = REPLAY_COPY_PROJECT_ID;
	return copy;
}

// =============================================================================
// THE GUARD
// =============================================================================

/**
 * Refuse a copy that could reach Discord, Slack, or a live task.
 *
 * The reference's `assertIsolated`, which aborted a replay rather than risk one
 * question reaching production. The four rules, and the failure each one catches:
 *
 * - NO FORBIDDEN PROVIDER. A `discord` component left in the copy would sign the
 *   support bot's token in a second time; a `tool_slack` or `tool_discord` would
 *   let the agent post.
 * - NO LIVE PROJECT ID. `(project_id, source)` is the task identity, so a copy
 *   that kept a live id would restart, or attach to, the pipe it was copied from.
 * - NO MENTION OF SLACK, ANYWHERE. The component can be gone while the agent is
 *   still instructed to page it, which costs a turn and can leak the rule's words
 *   into a reply. This rule reads every string in the document, keys included.
 * - NOTHING CAPTURES. `captureEvents: true` anywhere means a node has been
 *   told to write what the replay asks into the dashboard database, where it
 *   would appear as traffic, be graded, and move the Scorecard.
 * - NO DATABASE WIRED TO THE SOURCE. The key half of the same rule from the
 *   other side: a database component with a control edge from the copy's own
 *   source is a capture component by construction, whatever its config says.
 * - THE SOURCE IS A WEBHOOK. The one positive check: without it, a document whose
 *   discord component was simply deleted would pass the rules above and then
 *   start a task with no way to ask it anything.
 *
 * @param copy - What {@link buildReplayCopy} produced.
 * @param liveProjectIds - Every `project_id` the app can already be running —
 *        {@link LIVE_PROJECT_IDS}.
 * @throws Error, whose message says in plain language what is wrong.
 */
export function assertReplayCopyIsolated(copy: Record<string, unknown>, liveProjectIds: string[]): void {
	const components = componentsOf(copy);

	for (const component of components) {
		const provider = String(component.provider ?? '');
		if (FORBIDDEN_PROVIDERS.includes(provider)) {
			throw new Error(`The test copy still has a ${provider} component (${String(component.id ?? 'unnamed')}). A test must not be able to post anywhere, so the run was not started.`);
		}
	}

	const projectId = String(copy.project_id ?? '');
	if (liveProjectIds.includes(projectId)) {
		throw new Error(`The test copy's project id ${projectId} is one the app already runs, so starting it would restart that pipeline instead of a copy. The run was not started.`);
	}

	for (const text of everyString(copy)) {
		if (ANY_SLACK_TOOL.test(text)) {
			throw new Error('The test copy still mentions the Slack tool, so the agent would try to page Slack while answering a seed. The run was not started.');
		}
		if (ANY_SLACK_RULE.test(text)) {
			throw new Error('The test copy still carries the SLACK PAGING rule, so the agent would try to page Slack before every escalation. The run was not started.');
		}
	}

	if (hasCaptureEnabled(copy)) {
		throw new Error('The test copy still has capture turned on, so the seeds it asks would be written into the dashboard database as real traffic. The run was not started.');
	}

	const sourceId = sourceIdOf(copy);

	for (const component of components) {
		if (!DATABASE_PROVIDERS.includes(String(component.provider ?? ''))) continue;
		if (!controlSources(component).includes(sourceId)) continue;
		throw new Error(`The test copy still has a database component (${String(component.id ?? 'unnamed')}) wired to its source, which is what a capture component is. The run was not started.`);
	}

	const source = components.find((component) => String(component.id ?? '') === sourceId);
	if (source === undefined || String(source.provider ?? '') !== 'webhook') {
		throw new Error(`The test copy's source is ${sourceId.length > 0 ? `${sourceId} (${String(source?.provider ?? 'missing')})` : 'not declared'} rather than a webhook, so there would be no way to ask it a question. The run was not started.`);
	}
}

// =============================================================================
// THE DESCRIPTION
// =============================================================================

/**
 * What the copy is, in the fields the Replay tab prints.
 *
 * `removed` is derived from the copy ALONE — the forbidden providers it is
 * confirmed not to carry — rather than diffed against the live pipe, because the
 * sentence on screen is a promise about what is going to run, and a diff would
 * say "nothing was removed" for a pipe (the minimal one) that never had Slack in
 * it while the promise is just as true.
 *
 * @param copy - What {@link buildReplayCopy} produced.
 * @returns The copy's identity, size, providers and what it cannot do.
 */
export function describeReplayCopy(copy: Record<string, unknown>): ReplayCopyDescription {
	const components = componentsOf(copy);
	const providers: string[] = [];
	for (const component of components) {
		const provider = String(component.provider ?? '');
		if (provider.length > 0 && !providers.includes(provider)) providers.push(provider);
	}
	return {
		projectId: String(copy.project_id ?? ''),
		source: sourceIdOf(copy),
		componentCount: components.length,
		providers,
		removed: FORBIDDEN_PROVIDERS.filter((provider) => !providers.includes(provider)),
	};
}

// =============================================================================
// THE SANITIZER — a port of the node's own
// =============================================================================

/**
 * A reply that still OPENS with one of these labels is leaked scratchpad.
 *
 * `_OPENS_WITH_REASONING` in `nodes/src/nodes/discord/text_utils.py`, character
 * for character.
 */
const OPENS_WITH_REASONING = /^\s*(Thought|Action(?:\s+Input)?|Observation|Reasoning)\s*:/i;

/** `_FINAL_ANSWER` from the same file, with `g` so the LAST one can be found. */
const FINAL_ANSWER = /Final Answer\s*:\s*/gi;

/**
 * The first configured escalation marker present in a text.
 *
 * `find_marker` in `nodes/src/nodes/discord/text_utils.py`: configured order, not
 * order of appearance.
 *
 * @param text - The text to inspect.
 * @param markers - The effective escalation markers.
 * @returns The first marker found, or null.
 */
function findMarker(text: string, markers: string[]): string | null {
	if (text.length === 0) return null;
	for (const marker of markers ?? []) {
		if (marker.length > 0 && text.includes(marker)) return marker;
	}
	return null;
}

/**
 * Strip leaked agent scratchpad from a reply, exactly as the node would.
 *
 * A faithful port of `sanitize_reply` in
 * `nodes/src/nodes/discord/text_utils.py`, and it has to be faithful for one
 * reason: the replay copy has no `discord` node, so nothing is sanitizing its
 * answers. Scoring the RAW answer where the live bot would have posted a
 * sanitized one would measure a reply no user ever sees — and with
 * `sanitizeReplies` on (the app's default) the live bot sometimes posts NOTHING
 * at all, which is a different verdict again.
 *
 * - Keep only what follows the LAST `Final Answer:`, when that is non-empty.
 * - If the result then opens with a reasoning label it is scratchpad, not an
 *   answer: with an escalation marker present it becomes the node's short
 *   hand-off line carrying that marker, and otherwise it becomes '' — which is
 *   the node's `non_answer` No reply.
 *
 * @param raw - The pipeline's answer, as `client.send` returned it.
 * @param markers - `settings.behavior.escalationMarkers`.
 * @returns What the node would have posted, or '' when it would have posted
 *          nothing.
 */
export function sanitizeShownReply(raw: string, markers: string[]): string {
	let result = (raw ?? '').trim();
	if (result.length === 0) return result;

	const marks = [...result.matchAll(FINAL_ANSWER)];
	if (marks.length > 0) {
		const last = marks[marks.length - 1];
		const after = result.slice((last.index ?? 0) + last[0].length).trim();
		if (after.length > 0) result = after;
	}

	if (OPENS_WITH_REASONING.test(result)) {
		const marker = findMarker(result, markers);
		if (marker !== null) {
			return `Thanks for flagging this — I've looped in the team to take a look. ${marker}`;
		}
		return '';
	}
	return result;
}
