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
// GRAPH - CONNECTIONS: card and drawer content, and what an empty list may claim
// =============================================================================
//
// Pure functions from an endpoint (token-free) and its probe to the text the
// connections page shows. Nothing here reads or prints a credential: the only
// identity shown is what the node's `dialect` answer publishes (engine, version,
// database or graph, whether `execute` is allowed) plus the endpoint's own
// pipeline, run kind and owner.
//
// WHAT AN EMPTY LIST CAN SAY
// A graph node that fails to START never appears in the task list at all, so an
// empty list is NOT evidence that a graph was never provisioned, and this app
// has no authorised status API that could prove it. A graph that does not exist
// is one such start-up failure: the Apache AGE node checks its graph when the
// pipeline starts and does not create it. And the probe (`dialect`) of a node
// that did start never reads the database, so nothing a listed node answers can
// say its graph is missing either. The page therefore never claims it:
//
//   none-running   no running supported graph node was found. Cause unknown:
//                  nothing started, still starting, or a node that failed to
//                  start (for example because its graph does not exist). The
//                  text gives troubleshooting steps and says what is unknown.
//   unreachable    nodes were found but none could be reached or used (stopped,
//                  unreachable, or no permission). They exist; the card says why.
//
// A node still being checked (`probing`, on every first load and every re-probe)
// is not yet unusable, so while any node is being checked the page says nothing
// about the list: its card says Checking. And a message never takes the cards
// away: with cards on screen it sits above them (each card's drawer holds the
// reason and Test connection), and it stands alone only when there is no card.
// =============================================================================

import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import { canWrite, engineText, parseDialect, readBoundaryText, supportsReadQuery, targetText } from './dialect';

// =============================================================================
// TYPES
// =============================================================================

/** A badge: a variant for colour and a label that carries the whole message. */
export interface IBadge {
	variant: 'success' | 'muted' | 'error' | 'warning';
	label: string;
}

/** One line of detail. */
export interface IDetailRow {
	label: string;
	value: string;
}

/** What a card and its drawer show for one endpoint. */
export interface IConnectionView {
	title: string;
	/** The card's second line. */
	address: string;
	badge: IBadge;
	/** Lines for the drawer's identity section. */
	details: IDetailRow[];
	/** Sentences that qualify what the app will do (upgrade needed, read boundary, writes). */
	notes: string[];
	/** True when the connection can be opened for browsing. */
	openable: boolean;
	/** Why it cannot be opened, when it cannot. */
	blocked: string | null;
}

/** The empty states of the connections page. */
export type EmptyKind = 'loading' | 'none-running' | 'unreachable' | 'error';

/** The text for an empty state. */
export interface IEmptyState {
	kind: EmptyKind;
	title: string;
	description: string;
	/** What this app cannot tell, stated outright. */
	unknown: string | null;
}

/** What the connections page shows: a message, the cards, or the message above the cards. */
export interface ILandingView {
	/** The page's message, or null when there is nothing to say. */
	message: IEmptyState | null;
	/** True when the card grid is on screen (whenever there is a card). */
	cards: boolean;
}

// =============================================================================
// CARDS
// =============================================================================

/** The badge each endpoint state wears (the label carries the message; colour never does alone). */
export const STATE_BADGE: Record<IExplorerEndpoint['state'], IBadge> = {
	probing: { variant: 'muted', label: 'Checking' },
	ready: { variant: 'success', label: 'Running' },
	stopped: { variant: 'muted', label: 'Stopped' },
	unreachable: { variant: 'error', label: 'Unreachable' },
	inaccessible: { variant: 'error', label: 'No access' },
};

/**
 * The owner line: whose run this is. A deployment is named as one (a developer's
 * run and a deployment of the same pipeline are different connections), and the
 * team shown is the TASK's owning team, never the currently selected one.
 *
 * @param endpoint - The endpoint.
 * @returns e.g. `your development run` or `team deployment (team 4f2a)`.
 */
export function ownerText(endpoint: IExplorerEndpoint): string {
	const who = endpoint.ownerKind === 'team' ? `team ${endpoint.ownerId}` : endpoint.teamId ? `user ${endpoint.ownerId} (team ${endpoint.teamId})` : `user ${endpoint.ownerId}`;
	return endpoint.runKind === 'deploy' ? `deployment, ${who}` : `development run, ${who}`;
}

/**
 * Everything a card and drawer show for one endpoint.
 *
 * @param endpoint - The endpoint (token-free).
 * @param probe - Its probe result, when one exists.
 * @returns The view.
 */
export function connectionView(endpoint: IExplorerEndpoint, probe: IProbeResult | undefined): IConnectionView {
	const dialect = probe?.ok ? parseDialect(probe.info) : null;
	const details: IDetailRow[] = [
		{ label: 'Pipeline', value: endpoint.pipelineName || '(unnamed)' },
		{ label: 'Node', value: `${endpoint.nodeName || endpoint.nodeId} (${endpoint.provider})` },
		{ label: 'Run', value: ownerText(endpoint) },
	];
	const notes: string[] = [];
	let blocked: string | null = null;

	if (endpoint.state === 'stopped') blocked = 'The pipeline is stopped. Start it to browse this graph.';
	else if (endpoint.state === 'inaccessible') blocked = endpoint.stateDetail ?? 'You can see this task but you are not allowed to call its tools.';
	else if (endpoint.state === 'unreachable') blocked = endpoint.stateDetail ?? 'The node did not answer. It may still be starting or may have failed.';

	if (dialect) {
		details.push({ label: 'Engine', value: engineText(dialect) });
		const target = targetText(dialect);
		if (target) details.push({ label: 'Target', value: target });
		details.push({ label: 'Writes', value: canWrite(dialect) ? 'Allowed (execute is on for this node)' : 'Off (browsing only)' });
		notes.push(readBoundaryText(dialect));
		if (!supportsReadQuery(dialect)) {
			notes.push('This node does not support read_query yet. Upgrade the node to browse it with Graph Explorer.');
			blocked = blocked ?? 'This node needs an upgrade before it can be browsed.';
		}
	} else if (probe && !probe.ok && endpoint.state === 'ready') {
		blocked = blocked ?? probe.error?.message.split('\n')[0] ?? 'The node did not answer its identity probe.';
	}

	const badge = endpoint.state === 'ready' && dialect && !supportsReadQuery(dialect) ? { variant: 'warning' as const, label: 'Needs upgrade' } : STATE_BADGE[endpoint.state];
	return {
		title: endpoint.nodeName || endpoint.nodeId,
		address: `${endpoint.provider} · ${endpoint.pipelineName}${endpoint.runKind === 'deploy' ? ' (deployment)' : ''}`,
		badge,
		details,
		notes,
		openable: blocked === null && endpoint.state === 'ready',
		blocked,
	};
}

// =============================================================================
// SIDEBAR ROWS (the dev tool lists the connections in its sidebar)
// =============================================================================
//
// The same facts as a card, in the room of one row: the name, a state dot and,
// for a connection that is not plainly running, the badge label as a text
// suffix (colour never says it alone). The tooltip names the node, its address
// and its state, and the reason it cannot be browsed on its own line.

/** What one sidebar row shows. */
export interface IConnectionRow {
	/** The row's name. */
	label: string;
	/** The muted suffix after the name, or null for a running connection. */
	status: string | null;
	/** The dot's colour family (the card badge's variant). */
	variant: IBadge['variant'];
	/** The row's `title`. */
	tooltip: string;
	/** The row's accessible name (name and state). */
	ariaLabel: string;
}

/**
 * The state a sidebar row says after its name: the card's badge label, or nothing for a connection that is running.
 *
 * @param endpoint - The endpoint (token-free).
 * @param probe - Its probe result, when one exists.
 * @returns The suffix text, or null.
 */
export function rowStatusText(endpoint: IExplorerEndpoint, probe: IProbeResult | undefined): string | null {
	const badge = connectionView(endpoint, probe).badge;
	return badge.variant === 'success' ? null : badge.label;
}

/**
 * Everything a sidebar row shows for one endpoint.
 *
 * @param endpoint - The endpoint (token-free).
 * @param probe - Its probe result, when one exists.
 * @returns The row.
 */
export function connectionRow(endpoint: IExplorerEndpoint, probe: IProbeResult | undefined): IConnectionRow {
	const view = connectionView(endpoint, probe);
	const summary = `${view.title} \u2014 ${view.address} \u00b7 ${view.badge.label}`;
	return {
		label: view.title,
		status: rowStatusText(endpoint, probe),
		variant: view.badge.variant,
		tooltip: view.blocked ? `${summary}\n${view.blocked}` : summary,
		ariaLabel: `${view.title}, ${view.badge.label}`,
	};
}

/** The line under the sidebar rows. */
export interface IListLine {
	/** Muted text, or the error colour. */
	tone: 'muted' | 'error';
	text: string;
	/** What the line cannot say in its room (its tooltip), or null. */
	detail: string | null;
}

/**
 * The line under the sidebar rows, from the same empty states as the full app's landing. Nothing while discovery has
 * not started (it waits for the activation and a known identity, so "discovering" would not be true), and nothing
 * while the rows say it all (each row says why it cannot be used).
 *
 * @param status - The discovery lifecycle.
 * @param endpoints - The discovered endpoints.
 * @param error - The discovery failure text, when it failed.
 * @returns The line, or null.
 */
export function sidebarListLine(status: 'idle' | 'loading' | 'ready' | 'error', endpoints: readonly IExplorerEndpoint[], error: string | null): IListLine | null {
	if (status === 'idle') return null;
	if (status === 'error' && endpoints.length > 0) return { tone: 'error', text: `Refresh failed: ${error ?? 'the list of running pipelines could not be read'}. Showing what was found before.`, detail: null };
	const empty = emptyState(status, endpoints, error);
	if (!empty) return null;
	switch (empty.kind) {
		case 'loading':
			return { tone: 'muted', text: `${empty.title}\u2026`, detail: null };
		case 'error':
			return { tone: 'error', text: `${empty.title}: ${empty.description}`, detail: empty.unknown };
		case 'none-running':
			return { tone: 'muted', text: 'No running graph node found. Start a pipeline with a graph node, then refresh.', detail: [empty.description, empty.unknown].filter(Boolean).join(' ') };
		default:
			return null;
	}
}

// =============================================================================
// TEST CONNECTION
// =============================================================================

/** What the drawer says after Test connection. */
export interface ITestResult {
	variant: 'info' | 'warning' | 'error';
	text: string;
}

/**
 * The drawer's sentence for a Test connection result. The store answers null when it sent nothing (the pipeline is
 * not running, so there is no task to ask, or a check of this connection is already running): that is "not tested",
 * never "the node did not answer".
 *
 * @param result - What the probe returned, or null when none was sent.
 * @returns The sentence and its banner variant.
 */
export function testResultText(result: IProbeResult | null): ITestResult {
	if (result === null) return { variant: 'warning', text: 'Not tested: the pipeline is not running, or a check of this connection is already in progress.' };
	if (result.ok) return { variant: 'info', text: 'The node answered.' };
	return { variant: 'error', text: 'The node did not answer its identity probe. The details are on its card.' };
}

/**
 * The card the connection drawer shows after the endpoint list changed. The store keeps a node that stopped listed
 * (as stopped), so a key disappears only when the store was reset: a sign-out or a change of user, organization or
 * team. The drawer then closes, so the previous identity's Test result cannot reappear when discovery under the new
 * identity lists the same key.
 *
 * @param drawerKey - The key the drawer shows, or null when it is closed.
 * @param endpoints - Every endpoint the store lists.
 * @returns The same key while it is listed, otherwise null.
 */
export function drawerKeyAfter(drawerKey: string | null, endpoints: readonly IExplorerEndpoint[]): string | null {
	return drawerKey !== null && endpoints.some((e) => e.key === drawerKey) ? drawerKey : null;
}

// =============================================================================
// THE INLINE DETAILS PANEL OF A DEV-TOOL CONNECTION DOCUMENT
// =============================================================================
//
// As a dev tool a connection document shows the details in its own layout (no
// drawer: rocket-ui keeps hidden documents mounted, and a modal drawer left
// open there would hold the keyboard and the page scroll for the whole realm).
// Details toggles them. Test connection opens them and asks for a test, again
// each time it is pressed while they are open. A panel opened by Details tests
// nothing by itself, and closing forgets the requests.

/** Whether a document's details panel is open, and the last Test connection request (0: none). */
export interface IDetailsPanelState {
	open: boolean;
	testRequest: number;
}

/** What a document does to its details panel. */
export type DetailsPanelAction = 'toggle' | 'test' | 'close';

/** A closed panel with no request. */
export const DETAILS_CLOSED: IDetailsPanelState = { open: false, testRequest: 0 };

/**
 * The details panel after an action.
 *
 * @param state - The panel now.
 * @param action - Details (toggle), Test connection (test), or close.
 * @returns The panel after it.
 */
export function detailsPanelAfter(state: IDetailsPanelState, action: DetailsPanelAction): IDetailsPanelState {
	switch (action) {
		case 'toggle':
			return state.open ? DETAILS_CLOSED : { open: true, testRequest: 0 };
		case 'test':
			return { open: true, testRequest: (state.open ? state.testRequest : 0) + 1 };
		default:
			return DETAILS_CLOSED;
	}
}

// =============================================================================
// AN OPEN DOCUMENT WHOSE CONNECTION IS CHECKED AGAIN
// =============================================================================
//
// The store checks a connection again whenever any task restarts (from ANY
// pipeline), whenever the shell reconnects, and on Test connection. While it does,
// the endpoint is `probing` and its probe is gone, so the connection is briefly not
// openable. A document that has already opened its run surface keeps it: unmounting
// would drop the results, the graph and its expansions, the inspector, the row limit
// and the batch in flight. The surface stays and running pauses, with the reason.

/** What a connection document shows. */
export interface ISurfaceGate {
	/** True when the editor, results and graph are on screen. */
	mounted: boolean;
	/** Why running is paused while the surface stays, or null when it can run. */
	paused: string | null;
}

/** Said while a connection that was open is being checked again. */
export const RECHECKING_TEXT = 'Checking this connection again. Running is paused until the node answers; what is on screen stays.';

/**
 * Whether a connection document shows its run surface, and whether running is paused.
 *
 * @param view - The connection's view (or the write console's own `openable`/`blocked`).
 * @param opened - True once the surface has been on screen in this document.
 * @returns The gate.
 */
export function surfaceGate(view: Pick<IConnectionView, 'openable' | 'blocked'>, opened: boolean): ISurfaceGate {
	if (view.openable) return { mounted: true, paused: null };
	if (!opened) return { mounted: false, paused: null };
	return { mounted: true, paused: view.blocked ?? RECHECKING_TEXT };
}

// =============================================================================
// EMPTY STATES
// =============================================================================

/**
 * Which empty state applies, and what it may claim.
 *
 * @param status - The discovery lifecycle.
 * @param endpoints - The discovered endpoints.
 * @param error - The discovery failure text, when it failed.
 * @returns The empty state, or null when there is something to show.
 */
export function emptyState(status: 'idle' | 'loading' | 'ready' | 'error', endpoints: readonly IExplorerEndpoint[], error: string | null): IEmptyState | null {
	if (status === 'idle' || (status === 'loading' && endpoints.length === 0)) {
		return { kind: 'loading', title: 'Discovering graph nodes', description: 'Scanning your running pipelines for Apache AGE, Neo4j and FalkorDB graph nodes...', unknown: null };
	}
	if (status === 'error' && endpoints.length === 0) {
		return { kind: 'error', title: 'Discovery failed', description: error ?? 'The list of running pipelines could not be read.', unknown: 'Nothing is known about which graph nodes are running.' };
	}
	if (endpoints.length === 0) {
		return {
			kind: 'none-running',
			title: 'No running graph node found',
			description: 'Start a pipeline that has a tools source wired to a graph node (rocketride_graph, graph_neo4j or graph_falkordb), then refresh. A pipeline that is still starting does not appear yet.',
			unknown: 'A graph node that fails to start does not appear in this list at all (for example a node pointed at a graph that does not exist), and neither does a node whose run was not allowed to use its database, so an empty list does not tell whether a graph exists or why a node is missing. Check the pipeline’s log for a start-up error.',
		};
	}
	// A node still being checked may yet be usable: its card says Checking, and the page claims nothing.
	if (endpoints.some((e) => e.state === 'probing')) return null;
	if (endpoints.every((e) => e.state !== 'ready')) {
		return { kind: 'unreachable', title: 'Graph nodes found, but none can be used', description: 'Each card says why: the pipeline is stopped, the node did not answer, or you may not call its tools.', unknown: null };
	}
	return null;
}

/**
 * What the connections page shows. The cards stay on screen whenever there are any (a message sits above them), so a
 * card's reason and Test connection are always reachable; the message stands alone only when there is no card.
 *
 * @param status - The discovery lifecycle.
 * @param endpoints - The discovered endpoints.
 * @param error - The discovery failure text, when it failed.
 * @returns The message and whether the card grid shows.
 */
export function landingView(status: 'idle' | 'loading' | 'ready' | 'error', endpoints: readonly IExplorerEndpoint[], error: string | null): ILandingView {
	return { message: emptyState(status, endpoints, error), cards: endpoints.length > 0 };
}
