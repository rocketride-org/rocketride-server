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
// VECTOR - CONNECTIONS (pure): cards, the drawer, and what an empty list may say
// =============================================================================
//
// Pure functions from an endpoint (token-free) and its probe to what the
// Connections page shows. Nothing here reads or prints a credential: the only
// details shown are what the node's `dialect` publishes (backend, version,
// collection, metric, model, dimension, index, the write switch, support,
// caveats), the endpoint's own pipeline, roles and owner, and the NAMES of
// the pipeline's embedding and LLM nodes. Never a component's configuration.
//
// A card shows: the store node's name; "<store> · <collection> · <pipeline>";
// the role line "ingest ✓ · chat ✓ · tools ✓" ("–" for a source that is not
// running); a state badge (Checking, Running, Stopped, Unreachable, No access,
// Needs upgrade); and flags (Read-only, Experimental, Empty collection, Repair
// needed, Metadata column pending).
// =============================================================================

import { READ_ONLY_DETAIL } from 'shared/explorer';
import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import type { IDialectResult } from '../contract/types';
import { sharedTableSentence } from './confirm';
import { formatSize } from './fileType';
import { readDialect } from './results';
import type { IStatsView } from './results';
import { EXPERIMENTAL_BADGE, providerTitle, supportOf } from './support';
import { CAVEAT_SENTENCES, EMPTY, caveatSentence } from './wording';

// =============================================================================
// TYPES
// =============================================================================

/** A badge: a variant for colour and a label that carries the whole message. */
export interface IBadge {
	variant: 'success' | 'muted' | 'error' | 'warning';
	label: string;
}

/** A flag beside the badge, with its tooltip. */
export interface IFlag extends IBadge {
	tooltip: string;
}

/** What a card shows. */
export interface IVectorCardView {
	title: string;
	/** "<store> · <collection> · <pipeline>". */
	address: string;
	/** "ingest ✓ · chat ✓ · tools ✓". */
	roleLine: string;
	/** A sentence under the address, when there is one to say (read-only, stopped...). */
	line: string | null;
	badge: IBadge;
	flags: IFlag[];
	/** One line under the title: store · collection · pipeline, and the document count once the console has it. */
	description: string;
	/** True when the console can be opened. */
	openable: boolean;
	/** Why it cannot be opened, when it cannot. */
	blocked: string | null;
}

/** One row of the drawer. */
export interface IDetailRow {
	label: string;
	value: string;
}

/** What the drawer shows. */
export interface IDrawerView {
	/** About the collection: its name, size, embedding model, dimension, metric and index. */
	collection: IDetailRow[];
	/** About the connection: the sources, pipeline, node, run, backend, nodes and write switch. */
	connection: IDetailRow[];
	/** Both lists, collection first. */
	rows: IDetailRow[];
	notes: string[];
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

/** What the connections page shows. */
export interface ILandingView {
	message: IEmptyState | null;
	cards: boolean;
}

// =============================================================================
// CARDS
// =============================================================================

/** The badge each endpoint state wears. */
export const STATE_BADGE: Record<IExplorerEndpoint['state'], IBadge> = {
	probing: { variant: 'muted', label: 'Checking' },
	ready: { variant: 'success', label: 'Running' },
	stopped: { variant: 'muted', label: 'Stopped' },
	unreachable: { variant: 'error', label: 'Unreachable' },
	inaccessible: { variant: 'error', label: 'No access' },
};

/** The roles of a Vector connection, in the order the role line names them. */
export const ROLE_ORDER = ['ingest', 'chat', 'tools'] as const;

/** What the drawer says about a pipeline whose sources could not be grouped. */
export const NOT_GROUPED_NOTE = 'Other sources not found: save the pipeline with a project id so its sources are grouped.';

/** What an older store node says. */
const UPGRADE_TEXT = "This store node does not answer the Vector Explorer tools. Update the pipeline's engine and nodes to a version that supports Vector Explorer.";

/**
 * The role line: which of the pipeline's three sources are running.
 *
 * @param endpoint - The endpoint.
 * @returns e.g. 'ingest ✓ · chat ✓ · tools –'.
 */
export function roleLine(endpoint: IExplorerEndpoint): string {
	return ROLE_ORDER.map((role) => `${role} ${endpoint.roles[role] ? '✓' : '–'}`).join(' · ');
}

/**
 * Whether a probe failed because the node is older than the Vector Explorer tools.
 *
 * @param probe - The probe.
 * @returns True for "no handler for dialect" and a node that answered but not as a vector store.
 */
function needsUpgrade(probe: IProbeResult | undefined): boolean {
	if (!probe) return false;
	if (probe.ok) return readDialect(probe.info) === null;
	return probe.error?.kind === 'upgrade' || /No handler found for tool "?dialect"?/i.test(probe.error?.message ?? '');
}

/**
 * The owner line: whose run this is.
 *
 * @param endpoint - The endpoint.
 * @returns e.g. 'development run, user u1'.
 */
export function ownerText(endpoint: IExplorerEndpoint): string {
	const who = endpoint.ownerKind === 'team' ? `team ${endpoint.ownerId}` : endpoint.teamId ? `user ${endpoint.ownerId} (team ${endpoint.teamId})` : `user ${endpoint.ownerId}`;
	return endpoint.runKind === 'deploy' ? `deployment, ${who}` : `development run, ${who}`;
}

/**
 * Whether the console's last stats found the collection holding something: a store found empty and filled since keeps
 * the dialect's "no collection" until it is probed again, and the stats are the fresher answer.
 *
 * @param stats - The stats, or null.
 * @returns True when they count documents or chunks.
 */
function statsShowContent(stats: IStatsView | null): boolean {
	return stats !== null && stats.collectionExists && ((stats.documents ?? 0) > 0 || (stats.chunks ?? 0) > 0);
}

/**
 * The flags of a card (each carries its whole message).
 *
 * @param endpoint - The endpoint.
 * @param dialect - The node's dialect, or null.
 * @param stats - The connection's last stats answer, when its console has one.
 * @returns The flags.
 */
function flagsOf(endpoint: IExplorerEndpoint, dialect: IDialectResult | null, stats: IStatsView | null): IFlag[] {
	const flags: IFlag[] = [];
	if (endpoint.readOnly === true) flags.push({ variant: 'muted', label: 'Read-only', tooltip: `${EMPTY.readOnly}.` });
	if (supportOf(endpoint.provider, dialect) === 'experimental') flags.push({ variant: 'warning', ...EXPERIMENTAL_BADGE });
	if (dialect?.health.collection_exists === false && !statsShowContent(stats)) flags.push({ variant: 'muted', label: 'Empty collection', tooltip: 'The collection does not exist yet; add a document to create it.' });
	if (dialect?.health.control_record === false) flags.push({ variant: 'error', label: 'Repair needed', tooltip: 'This collection has no control record, so its embedding model and dimension are not recorded.' });
	if (dialect?.health.meta_column === false || dialect?.caveats.includes('meta_column_pending')) flags.push({ variant: 'warning', label: 'Metadata column pending', tooltip: CAVEAT_SENTENCES.meta_column_pending });
	return flags;
}

/**
 * Everything a card shows for one endpoint.
 *
 * @param endpoint - The endpoint (token-free).
 * @param probe - Its probe result, when one exists.
 * @param stats - The connection's last stats answer, when its console has one: it overrides a dialect that still says
 *   the collection does not exist.
 * @returns The view.
 */
export function vectorCardView(endpoint: IExplorerEndpoint, probe: IProbeResult | undefined, stats: IStatsView | null = null): IVectorCardView {
	const dialect = probe?.ok ? readDialect(probe.info) : null;
	const collection = dialect?.collection ?? null;
	const deploy = endpoint.runKind === 'deploy' ? ' (deployment)' : '';
	let blocked: string | null = null;
	if (endpoint.state === 'stopped') blocked = endpoint.stateDetail ?? 'The pipeline is stopped. Start it to open this store.';
	else if (endpoint.state === 'inaccessible') blocked = endpoint.stateDetail ?? 'You can see this task but you are not allowed to call its tools.';
	else if (endpoint.state === 'unreachable') blocked = needsUpgrade(probe) ? UPGRADE_TEXT : (endpoint.stateDetail ?? 'The store node did not answer. It may still be starting or may have failed.');
	else if (endpoint.state === 'ready' && needsUpgrade(probe)) blocked = UPGRADE_TEXT;
	const upgrade = needsUpgrade(probe) && (endpoint.state === 'ready' || endpoint.state === 'unreachable');
	const badge: IBadge = upgrade ? { variant: 'warning', label: 'Needs upgrade' } : STATE_BADGE[endpoint.state];
	let line: string | null = null;
	if (endpoint.readOnly === true) line = EMPTY.readOnly;
	if (endpoint.state === 'stopped' && endpoint.stateDetail && endpoint.stateDetail !== READ_ONLY_DETAIL) line = endpoint.stateDetail;
	const address = [providerTitle(endpoint.provider), collection, `${endpoint.pipelineName}${deploy}`].filter((part) => part !== null && part !== '').join(' · ');
	return {
		title: endpoint.nodeName || endpoint.nodeId,
		address,
		description: stats !== null && stats.documents !== null ? `${address} · ${stats.documents.toLocaleString('en-US')} ${stats.documents === 1 ? 'document' : 'documents'}` : address,
		roleLine: roleLine(endpoint),
		line,
		badge,
		flags: flagsOf(endpoint, dialect, stats),
		openable: blocked === null && endpoint.state === 'ready' && dialect !== null,
		blocked,
	};
}

// =============================================================================
// DEV-TOOL SIDEBAR ROWS (the parity spec S3-S6: Rod's list, one row per store)
// =============================================================================

/** What one dev-tool sidebar row shows. */
export interface IConnectionRow {
	/** The row's name (the store node's). */
	label: string;
	/** The muted suffix after the name, or null for a running connection that can be written. */
	status: string | null;
	/** The dot's colour family (the card badge's variant). */
	variant: IBadge['variant'];
	/** The row's `title`: the address, the state, the sources and why it cannot be opened. */
	tooltip: string;
	/** The row's accessible name (name and state). */
	ariaLabel: string;
}

/**
 * The state a sidebar row says after its name: the card's badge label for a connection that is not running (or needs
 * an upgrade), "Read-only" for a running read-only one, nothing for a running one.
 *
 * @param endpoint - The endpoint (token-free).
 * @param probe - Its probe result, when one exists.
 * @returns The suffix text, or null.
 */
export function rowStatusText(endpoint: IExplorerEndpoint, probe: IProbeResult | undefined): string | null {
	const badge = vectorCardView(endpoint, probe).badge;
	if (badge.variant !== 'success') return badge.label;
	return endpoint.readOnly === true ? 'Read-only' : null;
}

/**
 * Everything a dev-tool sidebar row shows for one endpoint.
 *
 * @param endpoint - The endpoint (token-free).
 * @param probe - Its probe result, when one exists.
 * @returns The row.
 */
export function connectionRow(endpoint: IExplorerEndpoint, probe: IProbeResult | undefined): IConnectionRow {
	const view = vectorCardView(endpoint, probe);
	const status = rowStatusText(endpoint, probe);
	const lines = [`${view.title} \u2014 ${view.address} \u00b7 ${view.badge.label}`, `Sources: ${view.roleLine}`];
	if (view.blocked) lines.push(view.blocked);
	return {
		label: view.title,
		status,
		variant: view.badge.variant,
		tooltip: lines.join('\n'),
		ariaLabel: status !== null && status !== view.badge.label ? `${view.title}, ${view.badge.label}, ${status}` : `${view.title}, ${view.badge.label}`,
	};
}

/** The line under the dev-tool sidebar's rows. */
export interface IListLine {
	/** Muted text, or the error colour. */
	tone: 'muted' | 'error';
	text: string;
	/** What the line cannot say in its room (its tooltip), or null. */
	detail: string | null;
}

/**
 * The line under the dev-tool sidebar's rows, from the same empty states as the full app's landing. Nothing while
 * discovery has not started (it waits for the activation and a known identity, so "discovering" would not be true),
 * and nothing while the rows say it all.
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
			return { tone: 'muted', text: empty.title, detail: [empty.description, empty.unknown].filter(Boolean).join(' ') };
		case 'unreachable':
			return { tone: 'muted', text: empty.title, detail: empty.description };
		default:
			return null;
	}
}

// =============================================================================
// DRAWER
// =============================================================================

/**
 * The display name of the first pipeline component whose provider matches.
 *
 * @param endpoint - The endpoint.
 * @param prefix - Provider prefix ('embedding_', 'llm_').
 * @returns The component's name (or id), or null.
 */
function componentName(endpoint: IExplorerEndpoint, prefix: string): string | null {
	const found = (endpoint.components ?? []).find((c) => typeof c.provider === 'string' && c.provider.startsWith(prefix));
	return found ? (found.name ?? found.id ?? null) : null;
}

/**
 * What the drawer shows: roles, backend and version, collection, metric, model,
 * dimension, index, the embedding and LLM node names, the write switch, support,
 * and the notes (caveats, the shared table, who can add documents, grouping).
 *
 * Model, dimension and index come from the dialect, else from the console's last stats answer: a store
 * found empty has none of them in its dialect until it is probed again.
 *
 * @param endpoint - The endpoint (token-free).
 * @param probe - Its probe, when one exists.
 * @param stats - The connection's last stats answer, when its console has one.
 * @returns The view.
 */
export function drawerView(endpoint: IExplorerEndpoint, probe: IProbeResult | undefined, stats: IStatsView | null = null): IDrawerView {
	const dialect = probe?.ok ? readDialect(probe.info) : null;
	const collection: IDetailRow[] = [];
	const connection: IDetailRow[] = [];
	if (dialect) {
		collection.push({ label: 'Collection', value: dialect.collection ?? '—' });
		if (stats !== null && stats.documents !== null) collection.push({ label: 'Documents', value: stats.documents.toLocaleString('en-US') });
		if (stats !== null && stats.chunks !== null) collection.push({ label: 'Chunks', value: stats.chunks.toLocaleString('en-US') });
		const model = dialect.model ?? stats?.model ?? null;
		const dimension = dialect.dimension ?? stats?.dimension ?? null;
		const index = dialect.index ?? stats?.index ?? null;
		collection.push({ label: 'Model', value: model ?? '—' });
		collection.push({ label: 'Dimension', value: dimension === null ? '—' : String(dimension) });
		collection.push({ label: 'Metric', value: dialect.metric ?? stats?.metric ?? '—' });
		const params = index?.params ? Object.entries(index.params).map(([k, v]) => `${k} ${String(v)}`) : [];
		collection.push({ label: 'Index', value: index ? `${index.type}${params.length ? ` (${params.join(', ')})` : ''}` : '—' });
		if (typeof dialect.size_bytes === 'number') collection.push({ label: 'Size', value: formatSize(dialect.size_bytes) });
	}
	for (const role of ROLE_ORDER) {
		const binding = endpoint.roles[role];
		connection.push({ label: role[0].toUpperCase() + role.slice(1), value: binding ? binding.source : 'not running' });
	}
	connection.push({ label: 'Pipeline', value: endpoint.pipelineName || '(unnamed)' });
	connection.push({ label: 'Node', value: `${endpoint.nodeName || endpoint.nodeId} (${providerTitle(endpoint.provider)})` });
	connection.push({ label: 'Run', value: ownerText(endpoint) });
	if (dialect) connection.push({ label: 'Backend', value: [dialect.backend, dialect.backend_version].filter(Boolean).join(' ') });
	connection.push({ label: 'Embedding node', value: componentName(endpoint, 'embedding_') ?? '—' });
	connection.push({ label: 'LLM node', value: componentName(endpoint, 'llm_') ?? '—' });
	if (dialect) {
		connection.push({ label: 'Removing documents', value: dialect.allow_writes ? 'On (allow_writes)' : 'Off (allow_writes)' });
		connection.push({ label: 'Support', value: dialect.support === 'supported' ? 'Supported' : 'Experimental' });
	}
	const rows = [...collection, ...connection];

	const notes: string[] = [];
	if (endpoint.readOnly === true) notes.push(`${EMPTY.readOnly}.`);
	for (const caveat of dialect?.caveats ?? []) {
		const sentence = caveatSentence(caveat);
		if (sentence && caveat !== 'shared_org_table') notes.push(sentence);
	}
	if (endpoint.provider === 'rocketride_vector' || dialect?.provider === 'rocketride_vector') notes.push(sharedTableSentence(dialect?.collection ?? 'its table'));
	if (endpoint.roles.ingest) notes.push('Anyone with the data permission on the ingest task can add documents.');
	const bound = ROLE_ORDER.filter((role) => endpoint.roles[role]).length;
	if (endpoint.projectId === '' && bound <= 1) notes.push(NOT_GROUPED_NOTE);
	return { collection, connection, rows, notes };
}

// =============================================================================
// COLLECTION TAB
// =============================================================================

/** One block of the Collection tab. */
export interface ICollectionSection {
	label: string;
	rows: IDetailRow[];
}

/**
 * The Collection tab's facts, read-only: what the store node reports about the embedding, the index, the storage and
 * the writes. A fact the node does not report reads "—"; the console's last stats fill what the dialect lacks, as in
 * the drawer. Nothing here is estimated.
 *
 * @param probe - The connection's probe, when one exists.
 * @param stats - The connection's last stats answer, when its console has one.
 * @returns The sections; none while the store has not answered its dialect.
 */
export function collectionView(probe: IProbeResult | undefined, stats: IStatsView | null = null): ICollectionSection[] {
	const dialect = probe?.ok ? readDialect(probe.info) : null;
	if (!dialect) return [];
	const index = dialect.index ?? stats?.index ?? null;
	const params = index?.params ? Object.entries(index.params).map(([k, v]) => `${k} ${String(v)}`) : [];
	const dimension = dialect.dimension ?? stats?.dimension ?? null;
	const score = dialect.score;
	const range = score.range ? `${score.range[0]} to ${score.range[1]}` : 'not reported';
	const chunks = stats?.chunks ?? null;
	return [
		{
			label: 'Embedding',
			rows: [
				{ label: 'Model', value: dialect.model ?? stats?.model ?? '—' },
				{ label: 'Dimensions', value: dimension === null ? '—' : String(dimension) },
			],
		},
		{
			label: 'Index',
			rows: [
				{ label: 'Metric', value: dialect.metric ?? stats?.metric ?? '—' },
				{ label: 'Index', value: index ? `${index.type}${params.length ? ` (${params.join(', ')})` : ''}` : '—' },
				{ label: 'Backend', value: [dialect.backend, dialect.backend_version].filter(Boolean).join(' ') || '—' },
				{ label: 'Score', value: `${score.formula === 'unknown' ? 'formula not reported' : score.formula}; range ${range}; ${score.higher_is_better ? 'higher is closer' : 'lower is closer'}` },
				{ label: 'Score threshold', value: score.threshold === null ? 'none set on the node' : String(score.threshold) },
			],
		},
		{
			label: 'Storage and writes',
			rows: [
				{ label: 'Size', value: typeof dialect.size_bytes === 'number' ? formatSize(dialect.size_bytes) : 'not reported by this store' },
				{ label: 'Chunks', value: chunks === null ? '—' : chunks.toLocaleString('en-US') },
				{ label: 'Removing documents', value: dialect.allow_writes ? 'On (allow_writes)' : 'Off (allow_writes)' },
				{ label: 'Delete mode', value: dialect.capabilities.soft_delete ? 'Moves to the Trash (soft delete)' : 'Permanent only' },
				{ label: 'Write batch', value: `${dialect.limits.write_ids_max.toLocaleString('en-US')} documents per call` },
			],
		},
	];
}

// =============================================================================
// TEST CONNECTION, DRAWER KEY
// =============================================================================

/** What the drawer says after Test connection. */
export interface ITestResult {
	variant: 'info' | 'warning' | 'error';
	text: string;
}

/**
 * The drawer's sentence for a Test connection result (null: nothing was sent).
 *
 * @param result - What the probe returned, or null.
 * @returns The sentence and its banner variant.
 */
export function testResultText(result: IProbeResult | null): ITestResult {
	if (result === null) return { variant: 'warning', text: 'Not tested: the pipeline is not running, or a check of this connection is already in progress.' };
	if (result.ok) return { variant: 'info', text: 'The store node answered.' };
	return { variant: 'error', text: 'The store node did not answer its identity probe. The details are on its card.' };
}

/**
 * The card the drawer shows after the endpoint list changed: a key disappears
 * only when the store was reset (sign-out, another user, organization or team),
 * and the drawer then closes.
 *
 * @param drawerKey - The key the drawer shows, or null.
 * @param endpoints - Every endpoint listed.
 * @returns The same key while it is listed, otherwise null.
 */
export function drawerKeyAfter(drawerKey: string | null, endpoints: readonly IExplorerEndpoint[]): string | null {
	return drawerKey !== null && endpoints.some((e) => e.key === drawerKey) ? drawerKey : null;
}

// =============================================================================
// EMPTY STATES
// =============================================================================

/**
 * Which empty state applies, and what it may claim.
 *
 * @param status - The discovery lifecycle.
 * @param endpoints - The discovered endpoints.
 * @param error - The discovery failure text.
 * @returns The empty state, or null when there is something to show.
 */
export function emptyState(status: 'idle' | 'loading' | 'ready' | 'error', endpoints: readonly IExplorerEndpoint[], error: string | null): IEmptyState | null {
	if (status === 'idle' || (status === 'loading' && endpoints.length === 0)) {
		return { kind: 'loading', title: 'Discovering vector stores', description: 'Scanning your running pipelines for vector store nodes...', unknown: null };
	}
	if (status === 'error' && endpoints.length === 0) {
		return { kind: 'error', title: 'Discovery failed', description: error ?? 'The list of running pipelines could not be read.', unknown: 'Nothing is known about which vector stores are running.' };
	}
	if (endpoints.length === 0) {
		return {
			kind: 'none-running',
			title: 'No running vector store found',
			description: 'No running pipeline has a vector store. Start one of the Vector Explorer templates (templates/<store>.pipe) and save it as a project, then refresh.',
			unknown: 'A store node that fails to start does not appear here at all, so an empty list does not say why; check the pipeline’s log for a start-up error. Elasticsearch and OpenSearch stores are not listed: they do not answer the Vector Explorer tools.',
		};
	}
	if (endpoints.some((e) => e.state === 'probing')) return null;
	if (endpoints.every((e) => e.state !== 'ready')) {
		return { kind: 'unreachable', title: 'Vector stores found, but none can be used', description: 'Each card says why: the pipeline is stopped, the store node did not answer, or you may not call its tools.', unknown: null };
	}
	return null;
}

/**
 * What the connections page shows: the cards whenever there are any (a message above them).
 *
 * @param status - The discovery lifecycle.
 * @param endpoints - The discovered endpoints.
 * @param error - The discovery failure text.
 * @returns The message and whether the card grid shows.
 */
export function landingView(status: 'idle' | 'loading' | 'ready' | 'error', endpoints: readonly IExplorerEndpoint[], error: string | null): ILandingView {
	return { message: emptyState(status, endpoints, error), cards: endpoints.length > 0 };
}
