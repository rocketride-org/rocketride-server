// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// PIPE PICKER — one node of one pipe, for every pipe-bound front end (plan 3.6)
// =============================================================================
//
// The landing view of a front end opened without `pipe=` (chat, dropper) and
// the pipeline path of sql-ui's connection dialog. Two steps:
//
//   1. PIPES   the caller's own-org publications (@me, then @team in team
//              order), filtered by the search box; the same box searches
//              the store (@public), paged with "More results". The store is
//              never listed. An address typed by hand goes straight to step 2.
//   2. NODES   `interfaces(address)` for the picked pipe: the nodes of the
//              requested interface (the catalog classType: chat, dropper,
//              database), or "this pipe has no <interface> interface".
//
// Choosing a node writes `pipe=` (and `node=` where the front end binds a
// node) into the URL, so the page is shareable and survives a reload, then
// hands the choice to the front end. No running task is ever read.
//
// The tiles wear the catalog picker's visual grammar (52px initial chip,
// name + one muted line, two-line description, the action Button bottom
// right) so the app catalog and the pipe picker read as one product.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button, EmptyState, InputField, Section, useShellConnection } from 'shell';
import type { RocketRideClient } from 'rocketride';
import { STORE_PAGE_LIMIT, applyStorePage, fetchOwnPipes, interfaceNodes, looksLikeAddress, matchesTerm, rungLabel, searchStorePipes, storePageRequest, writePipeLinkToLocation } from './pipePickerLogic';
import type { IInterfaceNode, IInterfacesAnswer, IPipeChoice, IPipeEntry, IPipePage, IStoreSearchState } from './pipePickerLogic';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Honor the OS "reduce motion" setting. */
const REDUCE_MOTION = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Quiet time after the last keystroke before the store is searched. */
const SEARCH_DEBOUNCE_MS = 300;

// =============================================================================
// TYPES
// =============================================================================

/** The client surface the picker uses: the catalog verb and `interfaces()`. */
export type IPipePickerClient = Pick<RocketRideClient, 'call' | 'interfaces'>;

/** Props for the {@link PipePicker} component. */
export interface IPipePickerProps {
	/** The interface to bind: the catalog classType (`chat`, `dropper`, `database`). */
	interfaceType: string;
	/** The interface in words, for the empty answer ("this pipe has no chat interface"). */
	interfaceLabel: string;
	/** Called with the chosen node, after the URL was written. */
	onChoose: (choice: IPipeChoice) => void;
	/** Write `pipe=` into the URL on choose (default true). */
	writeLink?: boolean;
	/** Also write `node=` (front ends that bind a node, sql). */
	linkNode?: boolean;
	/** The node tile's action (default 'Open'). */
	chooseLabel?: string;
	/** Heading (default 'Choose a pipeline'); an empty string hides the header text. */
	title?: string;
	/** Line under the heading. */
	subtitle?: string;
	/** The node already chosen, drawn as selected. */
	selected?: { address: string; nodeId: string } | null;
	/** The client to use (default: the shell connection's). */
	client?: IPipePickerClient | null;
	/** Extra styles merged onto the root (padding belongs to the host). */
	style?: CSSProperties;
}

/** One async read's state. */
interface ILoad<T> {
	value: T;
	loading: boolean;
	error: string | null;
}

/** The pipe being described in step 2. */
interface IPicked {
	pipe: string;
	name: string;
}

// =============================================================================
// STYLES
// =============================================================================

const S = {
	/** Root column; the HOST supplies padding and background. */
	root: {
		display: 'flex',
		flexDirection: 'column' as const,
		gap: 20,
		width: '100%',
		boxSizing: 'border-box' as const,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** Header row: title/subtitle left, search or Back right. */
	headerRow: {
		display: 'flex',
		width: '100%',
		alignItems: 'flex-end',
		justifyContent: 'space-between',
		gap: 16,
		flexWrap: 'wrap' as const,
	} as CSSProperties,

	title: {
		margin: 0,
		fontSize: 20,
		fontWeight: 800,
		color: 'var(--rr-text-primary)',
		letterSpacing: -0.3,
	} as CSSProperties,

	subtitle: {
		margin: '4px 0 0',
		fontSize: 14,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** The header's text column: may shrink below its content's width. */
	headerText: {
		minWidth: 0,
	} as CSSProperties,

	/** The search field's width on the header row. */
	search: {
		width: 260,
		maxWidth: '100%',
	} as CSSProperties,

	/** Tile grid. */
	grid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
		gap: 16,
		width: '100%',
	} as CSSProperties,

	/** One tile: the catalog card's surface. */
	card: {
		display: 'flex',
		flexDirection: 'column' as const,
		gap: 12,
		padding: 16,
		borderRadius: 12,
		boxSizing: 'border-box' as const,
		borderWidth: 1,
		borderStyle: 'solid',
		transition: REDUCE_MOTION ? 'none' : 'background-color 0.12s ease',
	} as CSSProperties,

	/** A tile's state colours: the current choice, hovered, or at rest. */
	cardState: (selected: boolean, hover: boolean): CSSProperties => ({
		backgroundColor: selected ? 'var(--rr-bg-list-active)' : hover ? 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))' : 'var(--rr-bg-paper)',
		borderColor: selected ? 'var(--rr-brand)' : 'var(--rr-border)',
	}),

	/** The tile's name/line column beside the chip. */
	cardText: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	cardTop: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		minWidth: 0,
	} as CSSProperties,

	/** Borderless initial chip; the surface tint frames it. */
	iconChip: {
		width: 40,
		height: 40,
		flexShrink: 0,
		borderRadius: 10,
		backgroundColor: 'var(--rr-bg-surface-alt)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-brand)',
		fontSize: 18,
		fontWeight: 800,
	} as CSSProperties,

	name: {
		fontSize: 15,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		whiteSpace: 'nowrap' as const,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	} as CSSProperties,

	line: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 2,
		whiteSpace: 'nowrap' as const,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	} as CSSProperties,

	description: {
		fontSize: 13,
		lineHeight: 1.45,
		color: 'var(--rr-text-secondary)',
		display: '-webkit-box',
		WebkitLineClamp: 2,
		WebkitBoxOrient: 'vertical' as const,
		overflow: 'hidden',
	} as CSSProperties,

	/** Bottom row: the action Button, right-aligned. */
	cardBottom: {
		display: 'flex',
		justifyContent: 'flex-end',
		marginTop: 'auto',
	} as CSSProperties,

	/** "More results" under the store grid. */
	more: {
		display: 'flex',
		justifyContent: 'center',
		marginTop: 12,
	} as CSSProperties,

	/** The by-address row: the field grows, the Button keeps its width. */
	addressRow: {
		display: 'flex',
		gap: 8,
		alignItems: 'center',
	} as CSSProperties,

	addressInput: {
		flex: 1,
		minWidth: 0,
		fontFamily: 'var(--rr-font-mono, monospace)',
	} as CSSProperties,

	addressError: {
		marginTop: 6,
		fontSize: 12,
		color: 'var(--rr-color-error)',
	} as CSSProperties,
};

// =============================================================================
// TILE
// =============================================================================

/** Props for one tile. */
interface ITileProps {
	/** The tile's name. */
	name: string;
	/** The muted line under the name. */
	line: string;
	/** Two-line description (omitted when empty). */
	description?: string;
	/** The action's label. */
	action: string;
	/** The action's tooltip. */
	actionTitle: string;
	/** Drawn as the current choice. */
	selected?: boolean;
	/** The action. */
	onAction: () => void;
}

/**
 * One tile. A custom tile: the shell's `Card` is a header + body group, not
 * the catalog's icon tile, and the catalog picker's tile is not exported.
 *
 * @param props - {@link ITileProps}.
 */
const Tile: React.FC<ITileProps> = ({ name, line, description, action, actionTitle, selected, onAction }) => {
	const [hover, setHover] = useState(false);
	const cardStyle: CSSProperties = { ...S.card, ...S.cardState(Boolean(selected), hover) };
	return (
		<div data-pipe-tile-selected={selected ? 'true' : undefined} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={cardStyle}>
			<div style={S.cardTop}>
				<div style={S.iconChip}>{(name[0] ?? '?').toUpperCase()}</div>
				<div style={S.cardText}>
					<div style={S.name} title={name}>
						{name}
					</div>
					<div style={S.line} title={line}>
						{line}
					</div>
				</div>
			</div>
			{description ? <div style={S.description}>{description}</div> : null}
			<div style={S.cardBottom}>
				<Button variant={selected ? 'secondary' : 'primary'} small onClick={onAction} title={actionTitle}>
					{action}
				</Button>
			</div>
		</div>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The pipe picker: own-org publications and a store search, then the picked
 * pipe's nodes of one interface.
 *
 * @param props - {@link IPipePickerProps}.
 */
export const PipePicker: React.FC<IPipePickerProps> = ({ interfaceType, interfaceLabel, onChoose, writeLink = true, linkNode = false, chooseLabel = 'Open', title = 'Choose a pipeline', subtitle, selected, client: clientOverride, style }) => {
	const shell = useShellConnection();
	const client: IPipePickerClient | null = clientOverride !== undefined ? clientOverride : shell.isConnected ? shell.client : null;

	const [own, setOwn] = useState<ILoad<IPipeEntry[]>>({ value: [], loading: true, error: null });
	const [ownSeq, setOwnSeq] = useState(0);
	const [term, setTerm] = useState('');
	const [store, setStore] = useState<IStoreSearchState>({ generation: 0, value: [], loading: false, error: null, term: '', total: 0 });
	// The store search generation: advanced whenever a search starts or the
	// client changes, so a "More results" page of an earlier search is dropped.
	const storeGeneration = useRef(0);
	const [picked, setPicked] = useState<IPicked | null>(null);
	const [nodes, setNodes] = useState<ILoad<IInterfaceNode[]>>({ value: [], loading: false, error: null });
	const [nodesSeq, setNodesSeq] = useState(0);
	const [addressDraft, setAddressDraft] = useState('');
	const [addressError, setAddressError] = useState('');

	/** One catalog request on the current client. */
	const call = useCallback(
		(args: Record<string, unknown>) => {
			if (!client) return Promise.reject(new Error('Not connected to a server.'));
			return client.call<IPipePage>('rrext_public_catalog', args);
		},
		[client]
	);

	// -- Step 1: the caller's own publications --------------------------------
	// Re-read when the client changes (a reconnect, another account) and on Retry.
	useEffect(() => {
		if (!client) {
			setOwn({ value: [], loading: false, error: 'Not connected to a server.' });
			return;
		}
		let alive = true;
		setOwn((prev) => ({ ...prev, loading: true, error: null }));
		fetchOwnPipes(call)
			.then((value) => {
				if (alive) setOwn({ value, loading: false, error: null });
			})
			.catch((err: unknown) => {
				if (alive) setOwn({ value: [], loading: false, error: err instanceof Error ? err.message : String(err) });
			});
		return () => {
			alive = false;
		};
	}, [client, call, ownSeq]);

	// -- Step 1: the store search, debounced; a new term starts a new list ----
	// Runs on every term and client change, so the generation advances on both.
	useEffect(() => {
		const needle = term.trim();
		const generation = ++storeGeneration.current;
		if (!needle || !client) {
			setStore({ generation, value: [], loading: false, error: null, term: '', total: 0 });
			return;
		}
		let alive = true;
		const timer = setTimeout(() => {
			setStore({ generation, value: [], loading: true, error: null, term: needle, total: 0 });
			searchStorePipes(call, needle, 0, STORE_PAGE_LIMIT)
				.then(({ entries, total }) => {
					if (alive) setStore({ generation, value: entries, loading: false, error: null, term: needle, total });
				})
				.catch((err: unknown) => {
					if (alive) setStore({ generation, value: [], loading: false, error: err instanceof Error ? err.message : String(err), term: needle, total: 0 });
				});
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [term, client, call]);

	/** The next page of the current store search, applied only while that search is current. */
	const loadMore = useCallback(() => {
		// Owned by the generation that produced the shown rows; none while a newer search is pending
		const request = storePageRequest(store, storeGeneration.current);
		if (!request) return;
		const { generation, term: searched, offset } = request;
		setStore((prev) => (prev.generation === generation ? { ...prev, loading: true, error: null } : prev));
		searchStorePipes(call, searched, offset, STORE_PAGE_LIMIT)
			.then((page) => setStore((prev) => applyStorePage(prev, generation, storeGeneration.current, page)))
			.catch((err: unknown) => setStore((prev) => applyStorePage(prev, generation, storeGeneration.current, { error: err instanceof Error ? err.message : String(err) })));
	}, [call, store]);

	// -- Step 2: the picked pipe's interface ----------------------------------
	useEffect(() => {
		if (!picked || !client) return;
		let alive = true;
		setNodes({ value: [], loading: true, error: null });
		client
			.interfaces(picked.pipe)
			.then((answer) => {
				if (alive) setNodes({ value: interfaceNodes(answer as IInterfacesAnswer, interfaceType), loading: false, error: null });
			})
			.catch((err: unknown) => {
				if (alive) setNodes({ value: [], loading: false, error: err instanceof Error ? err.message : String(err) });
			});
		return () => {
			alive = false;
		};
	}, [picked, client, interfaceType, nodesSeq]);

	// -- Actions ---------------------------------------------------------------
	const pickAddress = useCallback(() => {
		const address = addressDraft.trim();
		if (!looksLikeAddress(address)) {
			setAddressError('An address is developerId.pipelineId or developerId.pipelineId.source');
			return;
		}
		setAddressError('');
		setPicked({ pipe: address, name: address });
	}, [addressDraft]);

	const choose = useCallback(
		(node: IInterfaceNode) => {
			if (!picked) return;
			if (writeLink) writePipeLinkToLocation(node.address, linkNode ? node.nodeId : undefined);
			onChoose({ address: node.address, nodeId: node.nodeId, nodeName: node.name, pipeName: picked.name });
		},
		[picked, writeLink, linkNode, onChoose]
	);

	const ownVisible = useMemo(() => own.value.filter((entry) => matchesTerm(entry, term)), [own.value, term]);
	const rootStyle = useMemo<CSSProperties>(() => ({ ...S.root, ...style }), [style]);

	// -- Render: step 2 ---------------------------------------------------------
	if (picked) {
		return (
			<div style={rootStyle}>
				<div style={S.headerRow}>
					<div style={S.headerText}>
						<h2 style={S.title}>{picked.name}</h2>
						<p style={S.subtitle}>{picked.pipe}</p>
					</div>
					<Button variant="ghost" small onClick={() => setPicked(null)}>
						Back to pipelines
					</Button>
				</div>
				{nodes.loading ? (
					<EmptyState title={`Reading ${picked.name}…`} />
				) : nodes.error !== null ? (
					<EmptyState title="Couldn't read this pipeline." description={nodes.error} action={<Button onClick={() => setNodesSeq((n) => n + 1)}>Retry</Button>} />
				) : nodes.value.length === 0 ? (
					<EmptyState title={`This pipe has no ${interfaceLabel} interface.`} description="Go back and pick another pipeline." />
				) : (
					<div style={S.grid}>
						{nodes.value.map((node) => (
							<Tile key={`${node.address}/${node.nodeId}`} name={node.name} line={node.name === node.nodeId ? node.address : `${node.nodeId} · ${node.address}`} action={chooseLabel} actionTitle={`${chooseLabel} ${node.name}`} selected={selected?.address === node.address && selected?.nodeId === node.nodeId} onAction={() => choose(node)} />
						))}
					</div>
				)}
			</div>
		);
	}

	// -- Render: step 1 ---------------------------------------------------------
	const searching = term.trim().length > 0;
	return (
		<div style={rootStyle}>
			{/* Header row: title + subtitle, the one search box */}
			<div style={S.headerRow}>
				<div style={S.headerText}>
					{title && <h2 style={S.title}>{title}</h2>}
					{title && subtitle && <p style={S.subtitle}>{subtitle}</p>}
				</div>
				<InputField type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search pipelines and the store" aria-label="Search pipelines and the store" style={S.search} />
			</div>

			{/* Your pipelines: the caller's own-org publications */}
			<Section label="Your pipelines">
				{own.loading ? (
					<EmptyState title="Loading your pipelines…" />
				) : own.error !== null ? (
					<EmptyState title="Couldn't load your pipelines." description={own.error} action={<Button onClick={() => setOwnSeq((n) => n + 1)}>Retry</Button>} />
				) : ownVisible.length === 0 ? (
					<EmptyState title={searching ? 'None of your pipelines match.' : 'No pipelines are published to you or your teams.'} description="Search the store above, or enter an address below." />
				) : (
					<div style={S.grid}>
						{ownVisible.map((entry) => (
							<Tile key={entry.pipe} name={entry.name} line={rungLabel(entry)} description={entry.description} action="Select" actionTitle={`Select ${entry.name}`} onAction={() => setPicked({ pipe: entry.pipe, name: entry.name })} />
						))}
					</div>
				)}
			</Section>

			{/* The store: a search, never a listing */}
			{searching && (
				<Section label="Store">
					{store.loading && store.value.length === 0 ? (
						<EmptyState title="Searching the store…" />
					) : store.error !== null && store.value.length === 0 ? (
						<EmptyState title="Couldn't search the store." description={store.error} />
					) : store.value.length === 0 ? (
						<EmptyState title="No store pipelines match." description="Try a different search." />
					) : (
						<>
							<div style={S.grid}>
								{store.value.map((entry) => (
									<Tile key={entry.pipe} name={entry.name} line={rungLabel(entry)} description={entry.description} action="Select" actionTitle={`Select ${entry.name}`} onAction={() => setPicked({ pipe: entry.pipe, name: entry.name })} />
								))}
							</div>
							{store.value.length < store.total && (
								<div style={S.more}>
									<Button variant="secondary" small onClick={loadMore} disabled={store.loading}>
										{store.loading ? 'Loading…' : 'More results'}
									</Button>
								</div>
							)}
						</>
					)}
				</Section>
			)}

			{/* By address: a pipe a link or a colleague named */}
			<Section label="By address">
				<div style={S.addressRow}>
					<InputField
						style={S.addressInput}
						value={addressDraft}
						placeholder="acme.docBrain"
						aria-label="Pipeline address"
						spellCheck={false}
						onChange={(e) => setAddressDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && addressDraft.trim()) pickAddress();
						}}
					/>
					<Button variant="secondary" onClick={pickAddress} disabled={!client || addressDraft.trim().length === 0}>
						Find
					</Button>
				</div>
				{addressError && <div style={S.addressError}>{addressError}</div>}
			</Section>
		</div>
	);
};

export default PipePicker;
