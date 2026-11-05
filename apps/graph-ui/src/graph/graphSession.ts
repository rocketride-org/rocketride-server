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
// GRAPH - THE GRAPH SESSION (everything the graph view does that reaches the node)
// =============================================================================
//
// A small state machine around the canvas model: selection, focus, the inspector's
// target, and the five actions that may call the node - expand, collapse (local),
// dismiss (local), connect, find path, and refresh of an inspected element.
//
// RULES IT KEEPS
//   - One request at a time. A second action while one runs is declined with a
//     sentence, not queued, so the canvas never shows the answer to a question the
//     user has already moved past. Stop waiting lets go of whatever runs.
//   - Late answers are dropped. Loading a new result (or `dispose`) starts a new
//     EPOCH; an answer that belongs to an earlier epoch is ignored, whatever it
//     carries, so a slow expansion cannot paint over the query the user ran next.
//   - Ids are LIVE HANDLES. An expansion or a refresh that comes back without the
//     element it asked about says the element is no longer found; the canvas never
//     substitutes another element, and nothing here persists an id. A database can
//     hand an id out again after a delete, so an answer is merged only when every
//     element it shares an id with is the same KIND of element (identity.ts); if not,
//     nothing from the answer is added and the drawn copies are marked out of date.
//     A write that ran on the connection after the graph was drawn marks the whole
//     drawing out of date (`markStale`): its ids can no longer be trusted, so
//     Expand, Connect and Find path decline until the query is run again.
//   - Budgets always apply (model.ts): 1,000 nodes, 2,000 relationships, 100 new
//     neighbours per expansion, and every cut is said out loud.
//   - Generated queries never run by themselves: each action here is the direct
//     result of a user gesture, and every query goes through read_query.
//
// The session knows nothing about transport: it is given `invoke`, which sends one
// recipe through read_query and resolves with the envelope or throws.
// =============================================================================

import { MAX_NEW_NEIGHBORS, MAX_NODES, MAX_RELATIONSHIPS, PATH_MAX_DEPTH } from './budgets';
import { captionOf } from './captions';
import type { IFailureNotice } from './failures';
import { EMPTY_MODEL, collapseNode, connectNodes as connectModel, dismissNodes, expandNode, mergePath, modelFromResult, relationshipsOf, revealMore } from './model';
import type { IGraphModel } from './model';
import { collectEntities } from './results';
import type { IEntities } from './results';
import type { GraphId, GraphNode, GraphRelationship, ReadQueryResult } from './types';
import { DATA_CHANGED_TEXT, STALE_CONNECT_RELATIONSHIPS_TEXT, STALE_CONNECT_TEXT, STALE_ELEMENT_TEXT, conflictText, identityConflicts } from './identity';
import type { IIdentityConflict } from './identity';
import { connectText, expandText, num } from './wording';
import { STOP_WAITING_NOTE } from './wording';
import { createPathSearch, noPathText } from '../cypher/pathSearch';
import type { IPathSearch } from '../cypher/pathSearch';
import { connectNodes as connectRecipe, expandNeighbors, inspectNode as inspectRecipe, isRefusal } from '../cypher/recipes';
import type { IEngine, IRecipe, RecipeResult } from '../cypher/recipes';

// =============================================================================
// TYPES
// =============================================================================

/** What the inspector is showing. */
export interface IInspectTarget {
	kind: 'node' | 'relationship';
	id: GraphId;
}

/** A line under the graph toolbar. */
export interface IGraphNotice {
	variant: 'info' | 'warning' | 'error';
	text: string;
	/** The node's own text, when the notice is a failure. */
	detail?: string;
}

/** Where new nodes should start (the layout reads it). */
export interface IExpandHint {
	centerId: GraphId;
	newIds: readonly GraphId[];
}

/** Everything the view renders. */
export interface IGraphState {
	model: IGraphModel;
	/** The distinct entities of the root result (for "show more"). */
	entities: IEntities | null;
	selected: ReadonlySet<GraphId>;
	focusedId: GraphId | null;
	inspect: IInspectTarget | null;
	/** What is running, if anything. */
	busy: null | 'expand' | 'connect' | 'path' | 'inspect';
	notice: IGraphNotice | null;
	hint: IExpandHint | null;
	/** Relationships to draw highlighted (a found path). */
	highlight: ReadonlySet<GraphId>;
	/** Progress text while a path search runs. */
	progress: string | null;
	/** True once a write ran on the connection after this graph was drawn: every drawn id is suspect. */
	stale: boolean;
	/** Drawn NODES the database has answered for with a different element under the same id. */
	staleIds: ReadonlySet<GraphId>;
	/**
	 * Drawn RELATIONSHIPS the database has answered for with a different relationship under the same id. Kept apart
	 * from the nodes: node and relationship ids are separate namespaces, and FalkorDB numbers both from 0.
	 */
	staleRelationshipIds: ReadonlySet<GraphId>;
}

/** What the session needs from its caller. */
export interface IGraphSessionDeps {
	/** The engine and version, or null before the node is probed. */
	engine(): IEngine | null;
	/** Send one recipe through read_query. May throw. */
	invoke(recipe: IRecipe): Promise<ReadQueryResult>;
	/** Turn a thrown error into a notice (`ignore` drops it silently). */
	describe(error: unknown): IFailureNotice;
	/** Say something through the live region. */
	announce(text: string): void;
	/** Caption choice per label (property name, or the id/label specials). */
	captionChoice(label: string): string | undefined;
	/** Why nothing may be sent right now (the connection is being checked again, or stopped), or null. */
	paused?(): string | null;
}

/** The session. */
export interface IGraphSession {
	getState(): IGraphState;
	subscribe(listener: () => void): () => void;
	/** Show a new result (or nothing). Invalidates every answer still in flight. */
	load(result: ReadQueryResult | null): void;
	focus(id: GraphId | null): void;
	toggleSelect(id: GraphId): void;
	clearSelection(): void;
	inspect(target: IInspectTarget | null): void;
	refreshInspected(): Promise<void>;
	expand(id: GraphId): Promise<void>;
	collapse(id: GraphId): void;
	dismiss(id: GraphId): void;
	connect(): Promise<void>;
	findPath(): Promise<void>;
	/**
	 * Stop waiting for whatever is running (a path search, an expansion, Connect, a refresh). The node may still be
	 * working on it; its late answer is dropped.
	 */
	stopWaiting(): void;
	/** Draw more of the result, up to the canvas maximum. */
	showMore(): void;
	/** A statement that can change data ran on this connection: what is drawn may no longer match. */
	markStale(): void;
	/** End everything in flight (unmount, connection change). Subscribers keep their subscriptions. */
	dispose(): void;
}

const EMPTY: IGraphState = { model: EMPTY_MODEL, entities: null, selected: new Set(), focusedId: null, inspect: null, busy: null, notice: null, hint: null, highlight: new Set(), progress: null, stale: false, staleIds: new Set(), staleRelationshipIds: new Set() };

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a graph session.
 *
 * @param deps - Transport, description, announcements and caption choices.
 * @returns The session.
 */
export function createGraphSession(deps: IGraphSessionDeps): IGraphSession {
	let state: IGraphState = EMPTY;
	let epoch = 0;
	let search: IPathSearch | null = null;
	const listeners = new Set<() => void>();

	const set = (patch: Partial<IGraphState>): void => {
		state = { ...state, ...patch };
		listeners.forEach((l) => l());
	};
	const say = (text: string, variant: IGraphNotice['variant'] = 'info', detail?: string): void => {
		set({ notice: { variant, text, ...(detail ? { detail } : {}) } });
		deps.announce(text);
	};
	const fail = (notice: IFailureNotice): void => {
		if (notice.ignore) return;
		set({ notice: { variant: notice.variant === 'info' ? 'warning' : notice.variant, text: notice.headline, ...(notice.detail ? { detail: notice.detail } : {}) } });
		deps.announce(notice.headline);
	};
	const captionFor = (node: GraphNode): string => captionOf(node, deps.captionChoice(node.labels[0] ?? ''));

	/** Whether an action may start now; says why when it may not. */
	const idle = (): boolean => {
		if (state.busy === null) return true;
		say('Another request is still running. Wait for it, or stop waiting for it, before starting this.', 'warning');
		return false;
	};
	const engineOrSay = (): IEngine | null => {
		const why = deps.paused?.() ?? null;
		if (why !== null) {
			say(`Nothing was sent. ${why}`, 'warning');
			return null;
		}
		const engine = deps.engine();
		if (!engine) say('This connection has not been checked yet, so the app does not know which engine to write queries for.', 'warning');
		return engine;
	};

	/** Whether an action on these drawn elements must not go to the node (and says why). */
	const outOfDate = (ids: readonly GraphId[]): boolean => {
		if (state.stale) {
			say(DATA_CHANGED_TEXT, 'warning');
			return true;
		}
		if (ids.some((id) => state.staleIds.has(id))) {
			say(STALE_ELEMENT_TEXT, 'warning');
			return true;
		}
		return false;
	};
	/** Refuse to merge an answer that is not about the drawn elements: mark them (each kind in its own set), say so, add nothing. */
	const reject = (conflicts: readonly IIdentityConflict[]): void => {
		const nodes = conflicts.filter((c) => c.kind === 'node').map((c) => c.id);
		const relationships = conflicts.filter((c) => c.kind === 'relationship').map((c) => c.id);
		set({ staleIds: new Set([...state.staleIds, ...nodes]), staleRelationshipIds: new Set([...state.staleRelationshipIds, ...relationships]), hint: null });
		say(conflictText(conflicts), 'warning');
	};
	/** Nodes left the canvas: they are no longer worth marking. */
	const forget = (ids: readonly GraphId[]): ReadonlySet<GraphId> => new Set([...state.staleIds].filter((id) => !ids.includes(id)));
	/** The marked relationships that are still drawn (a relationship leaves the canvas with either of its ends). */
	const stillDrawn = (model: IGraphModel): ReadonlySet<GraphId> => new Set([...state.staleRelationshipIds].filter((id) => model.relationships.has(id)));

	/**
	 * Run a recipe for the current epoch.
	 *
	 * @param recipe - What to send.
	 * @param mine - The epoch the caller started in.
	 * @returns The envelope, or null when the answer must not be used (stale, or it failed and was reported).
	 */
	const ask = async (recipe: RecipeResult, mine: number): Promise<{ recipe: IRecipe; result: ReadQueryResult } | null> => {
		if (isRefusal(recipe)) {
			say(recipe.refusal, 'warning');
			return null;
		}
		try {
			const result = await deps.invoke(recipe);
			if (epoch !== mine) return null;
			return { recipe, result };
		} catch (error) {
			if (epoch !== mine) return null;
			fail(deps.describe(error));
			return null;
		}
	};

	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		load(result) {
			epoch += 1;
			search?.stop();
			search = null;
			if (!result) {
				state = { ...EMPTY };
				listeners.forEach((l) => l());
				return;
			}
			const entities = collectEntities(result.rows);
			const model = modelFromResult(entities);
			const first = model.nodes.keys().next().value as GraphId | undefined;
			state = { ...EMPTY, model, entities, focusedId: first ?? null };
			listeners.forEach((l) => l());
		},

		focus: (id) => set({ focusedId: id }),

		toggleSelect(id) {
			const next = new Set(state.selected);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			set({ selected: next });
			const node = state.model.nodes.get(id);
			if (node) deps.announce(`${captionFor(node)} ${next.has(id) ? 'selected' : 'deselected'}. ${next.size} ${next.size === 1 ? 'node' : 'nodes'} selected.`);
		},

		clearSelection() {
			if (state.selected.size === 0) return;
			set({ selected: new Set(), highlight: new Set() });
			deps.announce('Selection cleared.');
		},

		inspect: (target) => set({ inspect: target }),

		async refreshInspected() {
			const target = state.inspect;
			if (!target || target.kind !== 'node' || !idle()) return;
			if (outOfDate([target.id])) return;
			const engine = engineOrSay();
			if (!engine) return;
			const mine = epoch;
			set({ busy: 'inspect' });
			const answer = await ask(inspectRecipe(engine, target.id), mine);
			if (epoch !== mine) return;
			set({ busy: null });
			if (!answer) return;
			const fresh = collectEntities(answer.result.rows).nodes.get(target.id);
			if (!fresh) {
				say('This element was not found any more. Element ids are live handles: it may have been deleted, or the id may no longer point at it. The drawn copy is out of date.', 'warning');
				return;
			}
			const conflicts = identityConflicts(state.model, [fresh], []);
			if (conflicts.length > 0) {
				reject(conflicts);
				return;
			}
			if (state.model.nodes.has(target.id)) {
				const nodes = new Map(state.model.nodes);
				nodes.set(target.id, fresh);
				set({ model: { ...state.model, nodes } });
			}
			say('Refreshed from the database.');
		},

		async expand(id) {
			const node = state.model.nodes.get(id);
			if (!node || !idle()) return;
			if (outOfDate([id])) return;
			const engine = engineOrSay();
			if (!engine) return;
			const mine = epoch;
			set({ busy: 'expand', notice: null });
			deps.announce(`Expanding ${captionFor(node)}.`);
			// The relationships already drawn are left out of the request, so a repeat asks for the next ones.
			const drawn = relationshipsOf(state.model, id).map((rel) => rel.id);
			const answer = await ask(expandNeighbors(engine, id, MAX_NEW_NEIGHBORS, drawn), mine);
			if (epoch !== mine) return;
			set({ busy: null });
			if (!answer) return;
			const entities = collectEntities(answer.result.rows);
			// The recipe matches the node on its own, so an answer without it means the id no longer finds it.
			if (!entities.nodes.has(id)) {
				say(`${captionFor(node)} is no longer found: element ids are live handles. Nothing was added.`, 'warning');
				return;
			}
			if (entities.relationships.size === 0 && drawn.length === 0) {
				say(`${captionFor(node)} has no relationships in the database. Nothing was added.`);
				return;
			}
			const conflicts = identityConflicts(state.model, entities.nodes.values(), entities.relationships.values());
			if (conflicts.length > 0) {
				reject(conflicts);
				return;
			}
			const outcome = expandNode(state.model, id, entities, MAX_NEW_NEIGHBORS);
			const incomplete = answer.result.truncated || answer.result.rows.length >= answer.recipe.limit;
			// A cut answer with nothing new in it: the same request returns the same rows (drawn relationships AGE could
			// not leave out filled the node's row cap), so "expand again" would never help.
			const stuck = incomplete && outcome.addedNodes.length === 0 && outcome.addedRelationships.length === 0 && outcome.skippedNeighbors === 0 && outcome.budget === null;
			set({ model: outcome.model, hint: { centerId: id, newIds: outcome.addedNodes } });
			say(expandText(outcome.addedNodes.length, outcome.skippedNeighbors, incomplete, outcome.budget, stuck ? answer.result.row_limit : null), stuck ? 'warning' : 'info');
		},

		collapse(id) {
			const result = collapseNode(state.model, id);
			if (result.model === state.model) {
				say('Nothing to collapse: this node has not been expanded.');
				return;
			}
			const selected = new Set([...state.selected].filter((s) => !result.removed.includes(s)));
			set({ model: result.model, selected, staleIds: forget(result.removed), staleRelationshipIds: stillDrawn(result.model), inspect: state.inspect && result.removed.includes(state.inspect.id) ? null : state.inspect, hint: null });
			say(`Collapsed. ${num(result.removed.length)} ${result.removed.length === 1 ? 'node' : 'nodes'} removed from the graph.`);
		},

		dismiss(id) {
			const node = state.model.nodes.get(id);
			if (!node) return;
			const model = dismissNodes(state.model, [id]);
			const selected = new Set(state.selected);
			selected.delete(id);
			const first = model.nodes.keys().next().value as GraphId | undefined;
			set({ model, selected, staleIds: forget([id]), staleRelationshipIds: stillDrawn(model), inspect: state.inspect?.id === id ? null : state.inspect, focusedId: state.focusedId === id ? first ?? null : state.focusedId, hint: null });
			say(`${captionFor(node)} dismissed from the graph. It is still in the results table.`);
		},

		async connect() {
			if (!idle()) return;
			if (outOfDate([])) return;
			if (state.staleIds.size > 0) {
				say(STALE_CONNECT_TEXT, 'warning');
				return;
			}
			if (state.staleRelationshipIds.size > 0) {
				say(STALE_CONNECT_RELATIONSHIPS_TEXT, 'warning');
				return;
			}
			const engine = engineOrSay();
			if (!engine) return;
			const mine = epoch;
			set({ busy: 'connect', notice: null });
			const answer = await ask(connectRecipe(engine, [...state.model.nodes.keys()], MAX_RELATIONSHIPS), mine);
			if (epoch !== mine) return;
			set({ busy: null });
			if (!answer) return;
			const incoming = collectEntities(answer.result.rows);
			const conflicts = identityConflicts(state.model, incoming.nodes.values(), incoming.relationships.values());
			if (conflicts.length > 0) {
				reject(conflicts);
				return;
			}
			const outcome = connectModel(state.model, incoming);
			set({ model: outcome.model });
			// The node clamps what was asked for to its own row cap: a cut answer must never read as "nothing more".
			const cut = answer.result.truncated || answer.result.rows.length >= answer.recipe.limit;
			say(connectText(outcome.addedRelationships.length, outcome.budget, cut, answer.result.row_limit), cut && outcome.budget === null ? 'warning' : 'info');
		},

		async findPath() {
			if (!idle()) return;
			if (state.selected.size !== 2) {
				say('Select exactly two nodes to find a path between them. Space selects the focused node.', 'warning');
				return;
			}
			const engine = engineOrSay();
			if (!engine) return;
			const [from, to] = [...state.selected];
			if (outOfDate([from, to])) return;
			const mine = epoch;
			const current = createPathSearch({
				engine,
				run: (recipe) => deps.invoke(recipe),
				onDepth: (depth) => {
					if (epoch === mine) set({ progress: `Looking for a path of ${depth} ${depth === 1 ? 'relationship' : 'relationships'}…` });
				},
			});
			search = current;
			set({ busy: 'path', notice: null, highlight: new Set(), progress: 'Starting…' });
			const outcome = await current.start(from, to);
			if (epoch !== mine || search !== current) return;
			search = null;
			set({ busy: null, progress: null });
			switch (outcome.status) {
				case 'found': {
					const conflicts = identityConflicts(state.model, outcome.path.nodes, outcome.path.relationships);
					if (conflicts.length > 0) {
						reject(conflicts);
						break;
					}
					const merged = mergePath(state.model, outcome.path);
					set({ model: merged.model, highlight: new Set(outcome.path.relationships.map((r: GraphRelationship) => r.id)), hint: merged.addedNodes.length > 0 ? { centerId: from, newIds: merged.addedNodes } : null });
					say(`Found a path of ${outcome.depth} ${outcome.depth === 1 ? 'relationship' : 'relationships'} (the first, so a shortest one). Relationships keep their stored direction.${merged.budget ? ' Part of it could not be drawn: the canvas budget was reached.' : ''}`);
					break;
				}
				case 'none':
					say(noPathText(PATH_MAX_DEPTH), 'info');
					break;
				case 'deadline':
					say(`The search ran out of time at depth ${outcome.depthReached}. No path was found within that; deeper paths were not searched.`, 'warning');
					break;
				case 'stopped':
					say(`Stopped waiting. ${STOP_WAITING_NOTE}`, 'warning');
					break;
				case 'refused':
					say(outcome.message, 'warning');
					break;
				case 'error': {
					const notice = deps.describe(new Error(outcome.message));
					fail(notice);
					break;
				}
			}
		},

		stopWaiting() {
			if (state.busy === null) return;
			if (state.busy === 'path' && search) {
				// The search ends at once and says so itself (see findPath, case 'stopped').
				search.stop();
				return;
			}
			// Expand, Connect and Refresh: a new epoch drops their late answer, whatever it carries.
			epoch += 1;
			set({ busy: null, hint: null });
			say(`Stopped waiting. ${STOP_WAITING_NOTE}`, 'warning');
		},

		showMore() {
			if (!state.entities) return;
			const model = revealMore(state.model, state.entities, MAX_NODES);
			const added = model.nodes.size - state.model.nodes.size;
			set({ model });
			say(added > 0 ? `Showing ${num(added)} more nodes (${num(model.nodes.size)} of ${num(model.resultNodes)}).` : 'The canvas already shows as many nodes as it can hold.');
		},

		markStale() {
			if (state.stale || (state.model.nodes.size === 0 && state.entities === null)) return;
			// Whatever is in flight was asked about ids that may have changed meaning: drop it.
			epoch += 1;
			search?.stop();
			search = null;
			set({ stale: true, busy: null, progress: null, highlight: new Set() });
			say(DATA_CHANGED_TEXT, 'warning');
		},

		dispose() {
			// Ends everything in flight. Subscribers are NOT dropped: they own their subscriptions (React unsubscribes on
			// its own), and clearing them here once left a component that kept using the session deaf to its changes:
			// the inspector's Escape updated the state, nothing re-rendered, and the dialog stayed open.
			epoch += 1;
			search?.stop();
			search = null;
		},
	};
}
