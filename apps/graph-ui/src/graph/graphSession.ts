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
// target, the found path, and the actions that may call the node - expand (all
// neighbours, or over one relationship type), connect, find path, and refresh of an
// inspected element. Collapse, dismiss and clearing the path are local.
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
//   - Selection and the inspector are keyed by KIND and id. Node and relationship ids
//     are separate namespaces (FalkorDB numbers both from 0), so the selected nodes
//     and the selected relationship are held apart, and an element leaving the canvas
//     releases only the inspector, selection and path that were about IT.
//   - The out-of-date state has one renderer: `stale` (markStale announces it once and
//     leaves the notice alone); an action it refuses says so in a short sentence.
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
import { DATA_CHANGED_TEXT, STALE_CONNECT_RELATIONSHIPS_TEXT, STALE_CONNECT_TEXT, STALE_ELEMENT_TEXT, STALE_REFUSAL_TEXT, conflictText, identityConflicts } from './identity';
import type { IIdentityConflict } from './identity';
import { connectText, expandText, num } from './wording';
import { STOP_WAITING_NOTE } from './wording';
import { createPathSearch, noPathText } from '../cypher/pathSearch';
import type { IPathSearch, PathMethod } from '../cypher/pathSearch';
import { connectNodes as connectRecipe, expandByType as expandByTypeRecipe, expandNeighbors, inspectNode as inspectRecipe, isRefusal, neighboursQueryText, pathQueryText, relationshipQueryText, usesShortestPath } from '../cypher/recipes';
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

/** A found path, while it is shown. */
export interface IFoundPath {
	/** Node ids in path order (the canvas lays them out left to right in this order). */
	nodes: readonly GraphId[];
	/** Relationship ids in path order; `relationships[i]` joins `nodes[i]` and `nodes[i + 1]`. */
	relationships: readonly GraphId[];
	/** How it was found: one shortestPath call, or the depth search (depth 1 to its length, one call each). */
	method: PathMethod;
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
	/** The selected relationship (its own id space, apart from the nodes), or null. */
	selectedRelationship: GraphId | null;
	/** A found path in order, while it is shown; null otherwise. */
	path: IFoundPath | null;
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
	/** Select a node: `only` replaces the selection and inspects it (a click); `toggle` adds or removes it (Shift-click). */
	select(id: GraphId, mode: 'only' | 'toggle'): void;
	/**
	 * Select several nodes in one update (the legend's "every node of this label"): `only` replaces the selection with
	 * exactly these and inspects the first (or closes the inspector when there is none); `toggle` adds them all when any
	 * is not selected, else takes them all out. Ids that are not drawn are ignored.
	 */
	selectMany(ids: readonly GraphId[], mode: 'only' | 'toggle'): void;
	/** Select a relationship and inspect it; null clears it. */
	selectRelationship(id: GraphId | null): void;
	clearSelection(): void;
	inspect(target: IInspectTarget | null): void;
	refreshInspected(): Promise<void>;
	expand(id: GraphId): Promise<void>;
	collapse(id: GraphId): void;
	dismiss(id: GraphId): void;
	connect(): Promise<void>;
	findPath(): Promise<void>;
	/** Add a node's neighbours over one relationship type. */
	expandByType(id: GraphId, type: string): Promise<void>;
	/** The query "New query from here" (or a path's "Open as query") opens, or null when there is none. */
	queryTextFor(target: IInspectTarget | { kind: 'path' }): string | null;
	/** Stop showing the found path. */
	clearPath(): void;
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

const EMPTY: IGraphState = { model: EMPTY_MODEL, entities: null, selected: new Set(), focusedId: null, inspect: null, busy: null, notice: null, hint: null, highlight: new Set(), progress: null, stale: false, staleIds: new Set(), staleRelationshipIds: new Set(), selectedRelationship: null, path: null };

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
			say(STALE_REFUSAL_TEXT, 'warning');
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
	 * What follows the drawing when elements leave it: the inspector and the selected relationship let go of an element
	 * that is gone (looked up by its kind), and the path goes once a node of it that was drawn is gone.
	 */
	const follow = (model: IGraphModel): Partial<IGraphState> => {
		const drawn = (target: IInspectTarget): boolean => (target.kind === 'node' ? model.nodes.has(target.id) : model.relationships.has(target.id));
		const broken = state.path !== null && state.path.nodes.some((id) => state.model.nodes.has(id) && !model.nodes.has(id));
		return {
			inspect: state.inspect && drawn(state.inspect) ? state.inspect : null,
			selectedRelationship: state.selectedRelationship !== null && model.relationships.has(state.selectedRelationship) ? state.selectedRelationship : null,
			...(broken ? { path: null, highlight: new Set<GraphId>() } : {}),
		};
	};
	/** A relationship in words, as the canvas names it: `TYPE from A to B`. */
	const relationshipWords = (rel: GraphRelationship): string => {
		const end = (id: GraphId): string => {
			const node = state.model.nodes.get(id);
			return node ? captionFor(node) : id;
		};
		return `${rel.type} from ${end(rel.start)} to ${end(rel.end)}`;
	};

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

	/**
	 * Expand a node: all its neighbours, or those over one relationship type. The relationships already drawn (of that
	 * type) are left out of the request, so a repeat asks for the next ones.
	 *
	 * @param id - The node.
	 * @param type - One relationship type, or null for every type.
	 */
	const grow = async (id: GraphId, type: string | null): Promise<void> => {
		const node = state.model.nodes.get(id);
		if (!node || !idle()) return;
		if (outOfDate([id])) return;
		const engine = engineOrSay();
		if (!engine) return;
		const drawn = relationshipsOf(state.model, id)
			.filter((rel) => type === null || rel.type === type)
			.map((rel) => rel.id);
		const recipe = type === null ? expandNeighbors(engine, id, MAX_NEW_NEIGHBORS, drawn) : expandByTypeRecipe(engine, id, type, MAX_NEW_NEIGHBORS, drawn);
		if (isRefusal(recipe)) {
			say(recipe.refusal, 'warning');
			return;
		}
		const mine = epoch;
		set({ busy: 'expand', notice: null });
		deps.announce(`Expanding ${captionFor(node)}${type === null ? '' : ` over ${type}`}.`);
		const answer = await ask(recipe, mine);
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
			say(`${captionFor(node)} has no ${type === null ? '' : `${type} `}relationships in the database. Nothing was added.`);
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
		const captionIn = (nodeId: GraphId): string => {
			const drawnNode = outcome.model.nodes.get(nodeId);
			return drawnNode ? captionFor(drawnNode) : nodeId;
		};
		// The centre is named as the user saw it when they asked; the added nodes as they are drawn now.
		const about = { center: captionFor(node), added: outcome.addedNodes.map(captionIn), ...(type === null ? {} : { type }) };
		say(expandText(outcome.addedNodes.length, outcome.skippedNeighbors, incomplete, outcome.budget, stuck ? answer.result.row_limit : null, about), stuck ? 'warning' : 'info');
	};

	const toggleSelect = (id: GraphId): void => {
		const next = new Set(state.selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		set({ selected: next });
		const node = state.model.nodes.get(id);
		if (node) deps.announce(`${captionFor(node)} ${next.has(id) ? 'selected' : 'deselected'}. ${next.size} ${next.size === 1 ? 'node' : 'nodes'} selected.`);
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

		toggleSelect,

		select(id, mode) {
			if (mode === 'toggle') {
				toggleSelect(id);
				return;
			}
			const node = state.model.nodes.get(id);
			if (!node) return;
			set({ selected: new Set([id]), selectedRelationship: null, inspect: { kind: 'node', id } });
			deps.announce(`${captionFor(node)} selected.`);
		},

		selectMany(ids, mode) {
			const drawn = [...new Set(ids)].filter((id) => state.model.nodes.has(id));
			const nodes = (n: number): string => `${num(n)} ${n === 1 ? 'node' : 'nodes'}`;
			if (mode === 'only') {
				set({ selected: new Set(drawn), selectedRelationship: null, inspect: drawn.length > 0 ? { kind: 'node', id: drawn[0] } : null });
				deps.announce(`${nodes(drawn.length)} selected.`);
				return;
			}
			if (drawn.length === 0) return;
			const next = new Set(state.selected);
			const add = drawn.some((id) => !next.has(id));
			for (const id of drawn) {
				if (add) next.add(id);
				else next.delete(id);
			}
			set({ selected: next });
			deps.announce(`${nodes(drawn.length)} ${add ? 'selected' : 'deselected'}. ${nodes(next.size)} selected.`);
		},

		selectRelationship(id) {
			if (id === null) {
				set({ selectedRelationship: null, inspect: state.inspect?.kind === 'relationship' ? null : state.inspect });
				return;
			}
			const rel = state.model.relationships.get(id);
			if (!rel) return;
			// A click selects that element only: the selected NODES are let go (they are another id space, never this one).
			set({ selected: new Set(), selectedRelationship: id, inspect: { kind: 'relationship', id } });
			deps.announce(`${relationshipWords(rel)} selected.`);
		},

		clearSelection() {
			if (state.selected.size === 0 && state.selectedRelationship === null) return;
			// The found path stays: it has its own Clear path.
			set({ selected: new Set(), selectedRelationship: null });
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

		expand: (id) => grow(id, null),

		expandByType: (id, type) => grow(id, type),

		collapse(id) {
			const result = collapseNode(state.model, id);
			if (result.model === state.model) {
				say('Nothing to collapse: this node has not been expanded.');
				return;
			}
			const selected = new Set([...state.selected].filter((s) => !result.removed.includes(s)));
			set({ ...follow(result.model), model: result.model, selected, staleIds: forget(result.removed), staleRelationshipIds: stillDrawn(result.model), hint: null });
			say(`Collapsed. ${num(result.removed.length)} ${result.removed.length === 1 ? 'node' : 'nodes'} removed from the graph.`);
		},

		dismiss(id) {
			const node = state.model.nodes.get(id);
			if (!node) return;
			const model = dismissNodes(state.model, [id]);
			const selected = new Set(state.selected);
			selected.delete(id);
			const first = model.nodes.keys().next().value as GraphId | undefined;
			set({ ...follow(model), model, selected, staleIds: forget([id]), staleRelationshipIds: stillDrawn(model), focusedId: state.focusedId === id ? first ?? null : state.focusedId, hint: null });
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
				// One shortestPath call first where the engine has it (never AGE); the depth search backs it up.
				single: usesShortestPath(engine),
				onSingle: () => {
					if (epoch === mine) set({ progress: 'Asking for a shortest path in one call…' });
				},
				onDepth: (depth) => {
					if (epoch === mine) set({ progress: `Looking for a path of ${depth} ${depth === 1 ? 'relationship' : 'relationships'}…` });
				},
			});
			search = current;
			set({ busy: 'path', notice: null, highlight: new Set(), path: null, progress: 'Starting…' });
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
					const nodes = outcome.path.nodes.map((n: GraphNode) => n.id);
					const relationships = outcome.path.relationships.map((r: GraphRelationship) => r.id);
					set({ model: merged.model, highlight: new Set(relationships), path: { nodes, relationships, method: outcome.method }, hint: merged.addedNodes.length > 0 ? { centerId: from, newIds: merged.addedNodes } : null });
					const [first, last] = [nodes[0], nodes[nodes.length - 1]].map((id) => {
						const drawn = merged.model.nodes.get(id);
						return drawn ? captionFor(drawn) : id;
					});
					// Both searches give a shortest path: the depth search stops at the first depth that answers.
					const how = outcome.method === 'shortest-path' ? 'found with one shortestPath call' : `found by trying depth 1 to ${outcome.depth}, one call each`;
					say(`Shortest path ${first} → ${last}: ${outcome.depth} ${outcome.depth === 1 ? 'relationship' : 'relationships'}, ${how}. Laid out left to right; other nodes dimmed. Relationships keep their stored direction.${merged.budget ? ' Part of it could not be drawn: the canvas budget was reached.' : ''}`);
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

		queryTextFor(target) {
			const engine = deps.engine();
			if (!engine) return null;
			if (target.kind === 'node') return state.model.nodes.has(target.id) ? neighboursQueryText(engine, target.id) : null;
			if (target.kind === 'relationship') return state.model.relationships.has(target.id) ? relationshipQueryText(engine, target.id) : null;
			const path = state.path;
			if (!path || path.nodes.length < 2) return null;
			return pathQueryText(engine, path.nodes[0], path.nodes[path.nodes.length - 1], path.method === 'shortest-path' ? { method: 'shortest-path' } : { method: 'depth', depth: path.relationships.length });
		},

		clearPath() {
			if (state.path === null) return;
			set({ path: null, highlight: new Set() });
			// Said as the notice too: the found-path sentence ("laid out left to right; other nodes dimmed") is no longer true.
			say('Path cleared.');
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
			// Every notice was about the drawing that is now out of date (a found path, an expansion): none of it stays.
			set({ stale: true, busy: null, progress: null, highlight: new Set(), path: null, notice: null });
			// Announced, not set as the notice: the out-of-date line is rendered from `stale`, once.
			deps.announce(DATA_CHANGED_TEXT);
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
