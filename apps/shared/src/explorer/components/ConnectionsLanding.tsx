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
// EXPLORER — CONNECTIONS LANDING (every discovered endpoint, as cards)
// =============================================================================
//
// The Connections page every Explorer opens with: one card per discovered
// endpoint, a state on each, a record drawer to inspect and probe, and an empty
// state. The app injects what is its own — wording, icon, the card's second
// line, the drawer's probe and extra rows, and (for Graph) its own empty states
// for "no graph nodes", "not reachable" and "not provisioned".
//
// First discovery starts as soon as the shell connection is live; after that
// the store refreshes itself on task events and focus, and Refresh does it on
// demand.
// =============================================================================

import React, { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Banner, Button, ConnectionCard, ConnectionCardAdd, ContentHeader, EmptyState, commonStyles, useShellConnection } from 'shell';
import { useEndpointState } from '../react';
import type { IEndpointState, IEndpointStore } from '../connect/store';
import type { IExplorerClient, IExplorerEndpoint } from '../types';
import { ENDPOINT_STATE_BADGE } from './endpointState';
import { EndpointDrawer } from './EndpointDrawer';
import type { IEndpointDrawerProps } from './EndpointDrawer';

// =============================================================================
// TYPES
// =============================================================================

/** The words a landing page uses. */
export interface IConnectionsLandingCopy {
	/** Page title (`Connections`). */
	title: string;
	/** Page subtitle. */
	subtitle: string;
	/** Title of the first-discovery state. */
	loadingTitle: string;
	/** Description of the first-discovery state. */
	loadingDescription: string;
	/** Title of the default empty state. */
	emptyTitle: string;
	/** Description of the default empty state. */
	emptyDescription: string;
	/** Label of the add tile and header action (`New Connection`). */
	newLabel: string;
}

/** What the app injects into the record drawer. */
export type LandingDrawerProps<E extends IExplorerEndpoint> = Pick<IEndpointDrawerProps<E>, 'avatar' | 'copy' | 'probe' | 'details'>;

/** Props for the {@link ConnectionsLanding} component. */
export interface IConnectionsLandingProps<E extends IExplorerEndpoint> {
	/** The app's endpoint store. */
	store: IEndpointStore;
	/** Icon on cards and empty states. */
	icon: ReactNode;
	/** Open the workbench for a connection. */
	onOpen: (endpoint: E) => void;
	/** The page's wording. */
	copy: IConnectionsLandingCopy;
	/** The record drawer's wording, probe and extras. */
	drawer: LandingDrawerProps<E>;
	/** The card's second line (default `provider - pipeline`, with `(deployment)` for a deployment). */
	cardAddress?: (endpoint: E) => string;
	/**
	 * The app's own empty state for a case the default does not cover (Graph's
	 * "unreachable" and "not provisioned"). Return null to use the default.
	 */
	emptyState?: (context: { state: IEndpointState; refresh: () => void }) => ReactNode | null;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Root fills the shell client pane; the ContentHeader sits fixed at the top
	// and the content region below it scrolls.
	root: {
		...commonStyles.columnFill,
	} as CSSProperties,

	// Scrolling content column below the header (standard 20/24 gutters).
	content: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
		padding: '20px 24px 24px',
	} as CSSProperties,

	// Responsive card grid for the discovered endpoints.
	cardGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
		gap: 16,
	} as CSSProperties,
};

/**
 * The default second line of a card. A deployment is named as one, because a
 * developer's run and a deployment of the same pipeline are different
 * connections.
 *
 * @param endpoint - The endpoint.
 * @returns e.g. `db_postgres - Orders (deployment)`.
 */
export function defaultCardAddress(endpoint: IExplorerEndpoint): string {
	const run = endpoint.runKind === 'deploy' ? ' (deployment)' : '';
	return `${endpoint.provider} - ${endpoint.pipelineName}${run}`;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Landing view: every tool node discovered in the caller's running pipelines,
 * as connection cards. Clicking a card opens its workbench (`onOpen`); the
 * card's Edit action and the add tile open the record drawer to inspect and
 * probe the endpoint first.
 *
 * @param props - {@link IConnectionsLandingProps}.
 * @returns The landing element.
 */
export function ConnectionsLanding<E extends IExplorerEndpoint>({ store, icon, onOpen, copy, drawer, cardAddress, emptyState }: IConnectionsLandingProps<E>): React.ReactElement {
	const { client, isConnected } = useShellConnection();
	const state = useEndpointState(store);
	const { status, endpoints, error } = state;

	// Drawer state: open flag + the endpoint preselected by a card click
	// (null = pick mode from the add tile / header action).
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [drawerEndpoint, setDrawerEndpoint] = useState<E | null>(null);

	// Kick off the first discovery as soon as the shell connection is live.
	useEffect(() => {
		if (client && isConnected && status === 'idle') void store.refresh(client);
	}, [client, isConnected, status, store]);

	/** Re-run discovery now. */
	const refresh = (): void => {
		if (client) void store.refresh(client);
	};

	/**
	 * Open the record drawer.
	 *
	 * @param endpoint - Preselected endpoint, or null for pick mode.
	 */
	const openDrawer = (endpoint: E | null): void => {
		setDrawerEndpoint(endpoint);
		setDrawerOpen(true);
	};

	// Discovery is still on its first pass (nothing cached to show yet).
	const firstLoad = status === 'idle' || (status === 'loading' && endpoints.length === 0);
	const typed = endpoints as E[];
	const custom = !firstLoad && typed.length === 0 ? emptyState?.({ state, refresh }) ?? null : null;

	return (
		<div style={styles.root}>
			<ContentHeader
				title={copy.title}
				subtitle={copy.subtitle}
				actions={
					<>
						<Button variant="ghost" onClick={refresh} disabled={!client || status === 'loading'}>
							{status === 'loading' ? 'Refreshing...' : 'Refresh'}
						</Button>
						<Button variant="primary" onClick={() => openDrawer(null)}>+ {copy.newLabel}</Button>
					</>
				}
			/>

			<div style={styles.content}>
				{/* Discovery failure — keep any previously discovered cards visible. */}
				{status === 'error' && (
					<div style={{ marginBottom: 16 }}>
						<Banner variant="error">Discovery failed: {error}</Banner>
					</div>
				)}

				{firstLoad ? (
					// First paint: framed progress state, never bare "Loading..." text.
					<EmptyState icon={icon} title={copy.loadingTitle} description={copy.loadingDescription} />
				) : typed.length === 0 ? (
					custom ?? (
						// Nothing reachable: explain what makes a connection appear.
						<EmptyState
							icon={icon}
							title={copy.emptyTitle}
							description={copy.emptyDescription}
							action={<Button variant="primary" onClick={refresh} disabled={!client}>Refresh</Button>}
						/>
					)
				) : (
					// The discovered endpoints as connection cards + the add tile.
					<div style={styles.cardGrid}>
						{typed.map((endpoint) => (
							<ConnectionCard
								key={endpoint.key}
								icon={icon}
								name={endpoint.nodeName}
								address={(cardAddress ?? defaultCardAddress)(endpoint)}
								status={ENDPOINT_STATE_BADGE[endpoint.state].variant}
								statusLabel={ENDPOINT_STATE_BADGE[endpoint.state].label}
								connected={endpoint.state === 'ready'}
								onClick={() => onOpen(endpoint)}
								onEdit={() => openDrawer(endpoint)}
							/>
						))}
						<ConnectionCardAdd label={copy.newLabel} onClick={() => openDrawer(null)} />
					</div>
				)}
			</div>

			{/* Record drawer: inspect + probe the selected endpoint. */}
			<EndpointDrawer<E>
				open={drawerOpen}
				client={client as IExplorerClient | null}
				endpoints={typed}
				endpoint={drawerEndpoint}
				onClose={() => setDrawerOpen(false)}
				onOpen={(endpoint) => {
					setDrawerOpen(false);
					onOpen(endpoint);
				}}
				avatar={drawer.avatar}
				copy={drawer.copy}
				probe={drawer.probe}
				details={drawer.details}
			/>
		</div>
	);
}

export default ConnectionsLanding;
