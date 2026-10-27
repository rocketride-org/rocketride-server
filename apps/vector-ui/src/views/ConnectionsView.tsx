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
// VECTOR-UI - CONNECTIONS VIEW (R1: the landing page, one card per vector store)
// =============================================================================
//
// One card per store node a running Tools source controls (read-only cards
// for pipelines without one). A card opens its drawer; the drawer opens the
// console. Nothing here holds or shows a credential or a node's configuration.
// =============================================================================

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Banner, Button, ContentHeader, DetailPanel, EmptyState, Section, StatusBadge } from 'shell';
import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import ConnectionDrawerDetails from '../components/ConnectionDrawerDetails';
import VectorConnectionCard from '../components/VectorConnectionCard';
import { useSampleChunks } from '../components/useSampleChunks';
import { useEndpointsState, useVectorEnv } from '../envContext';
import { getDocs } from '../docs';
import { consoleUri } from '../vector/addresses';
import { TONE_EDGE } from '../vector/colors';
import { DEFAULT_LIMITS, readDialect } from '../vector/results';
import type { WorkbenchTab } from '../vector/workbench';
import { drawerKeyAfter, drawerView, landingView, testResultText, vectorCardView } from '../vector/connections';
import type { ITestResult, IVectorCardView } from '../vector/connections';
import { VectorIcon } from '../icons';
import { styles } from '../styles';

/**
 * Open a connection's console (its default document).
 *
 * @param endpoint - The connection.
 */
export function openConsole(endpoint: IExplorerEndpoint): void {
	getDocs()?.openStaticDocument(consoleUri(endpoint.key), endpoint.nodeName || 'Vector store', { endpoint });
}

/** The roles and flags under a card. */
const CardMeta: React.FC<{ view: IVectorCardView }> = ({ view }) => (
	<div style={styles.cardMeta}>
		<span aria-label={`Sources: ${view.roleLine.replace(/✓/g, 'running').replace(/–/g, 'not running')}`}>{view.roleLine}</span>
		{view.flags.map((flag) => (
			<span key={flag.label} style={styles.chip(TONE_EDGE[flag.variant])} title={flag.tooltip}>
				{flag.label}
			</span>
		))}
		{view.line && <span style={{ flexBasis: '100%' }}>{view.line}</span>}
	</div>
);

/**
 * The landing view.
 *
 * @returns The view.
 */
export const ConnectionsView: React.FC = () => {
	const env = useVectorEnv();
	const { status, endpoints, probes, error } = useEndpointsState();
	const [drawerKey, setDrawerKey] = useState<string | null>(null);

	// First discovery as soon as the shell connection is live.
	useEffect(() => {
		if (env.ready && status === 'idle') void env.refresh({ quiet: true });
	}, [env, status]);

	// A sign-out or a change of identity resets the store: the drawer closes with the connections it forgot.
	useEffect(() => {
		const next = drawerKeyAfter(drawerKey, endpoints);
		if (next !== drawerKey) setDrawerKey(next);
	}, [drawerKey, endpoints]);

	const refresh = (): void => {
		if (env.ready) void env.refresh();
	};
	const drawerEndpoint = endpoints.find((e) => e.key === drawerKey) ?? null;
	const landing = landingView(status, endpoints, error);
	const messageText = landing.message ? [landing.message.description, landing.message.unknown].filter(Boolean).join(' ') : '';

	return (
		<div style={styles.root}>
			<ContentHeader
				title="Connections"
				subtitle="Vector stores reachable through your running pipelines. Elasticsearch and OpenSearch stores are not listed."
				actions={
					<Button variant="ghost" onClick={refresh} disabled={!env.ready || status === 'loading'}>
						{status === 'loading' ? 'Refreshing…' : 'Refresh'}
					</Button>
				}
			/>
			<div style={styles.content}>
				{status === 'error' && endpoints.length > 0 && (
					<div style={{ marginBottom: 16 }}>
						<Banner variant="error">{`Refresh failed: ${error}. Showing what was found before.`}</Banner>
					</div>
				)}
				{landing.message && !landing.cards && (
					<EmptyState
						icon={<VectorIcon />}
						title={landing.message.title}
						description={messageText}
						action={
							landing.message.kind === 'loading' ? undefined : (
								<Button variant="primary" onClick={refresh} disabled={!env.ready}>
									Refresh
								</Button>
							)
						}
					/>
				)}
				{landing.message && landing.cards && (
					<div style={{ marginBottom: 16 }}>
						<Banner variant={landing.message.kind === 'loading' ? 'info' : 'warning'}>{`${landing.message.title}. ${messageText}`}</Banner>
					</div>
				)}
				{landing.cards && (
					<div style={styles.cardGrid}>
						{endpoints.map((endpoint) => (
							<VectorConnectionCard key={endpoint.key} endpoint={endpoint} probe={probes[endpoint.key]} onOpen={(target) => setDrawerKey(target.key)} />
						))}
					</div>
				)}
			</div>
			<ConnectionDrawer
				key={drawerKey ?? ''}
				endpoint={drawerEndpoint}
				probe={drawerEndpoint ? probes[drawerEndpoint.key] : undefined}
				onTest={(endpoint) => env.probe(endpoint.key)}
				onOpen={(endpoint) => {
					setDrawerKey(null);
					env.openConsole(endpoint);
				}}
				onOpenTab={(endpoint, tab) => {
					// The console reads its tab from the connection's entry when it opens.
					const limits = (probes[endpoint.key]?.ok ? readDialect(probes[endpoint.key]?.info)?.limits : null) ?? DEFAULT_LIMITS;
					env.connection(endpoint, limits).tab.set(tab);
					setDrawerKey(null);
					env.openConsole(endpoint);
				}}
				onClose={() => setDrawerKey(null)}
			/>
		</div>
	);
};

/** A subscription that never fires (no console opened for the connection yet). */
const NO_SUBSCRIBE = (): (() => void) => () => undefined;

/** Props of the drawer. */
interface IConnectionDrawerProps {
	endpoint: IExplorerEndpoint | null;
	probe: IProbeResult | undefined;
	onTest(endpoint: IExplorerEndpoint): Promise<IProbeResult | null>;
	onOpen(endpoint: IExplorerEndpoint): void;
	/** Open the console on a tab (the quick actions). */
	onOpenTab(endpoint: IExplorerEndpoint, tab: WorkbenchTab): void;
	onClose(): void;
}

/**
 * The drawer of one card: what the store node says about itself, Test connection, Open console.
 *
 * @param props - The endpoint, its probe and the actions.
 * @returns The drawer, or nothing while closed.
 */
const ConnectionDrawer: React.FC<IConnectionDrawerProps> = ({ endpoint, ...rest }) => (endpoint ? <OpenDrawer endpoint={endpoint} {...rest} /> : null);

/** Props of an open drawer. */
interface IOpenDrawerProps extends Omit<IConnectionDrawerProps, 'endpoint'> {
	endpoint: IExplorerEndpoint;
}

/**
 * The drawer of a card while it is open.
 *
 * @param props - The endpoint, its probe and the actions.
 * @returns The drawer.
 */
const OpenDrawer: React.FC<IOpenDrawerProps> = ({ endpoint, probe, onTest, onOpen, onOpenTab, onClose }) => {
	const [testing, setTesting] = useState(false);
	// Keyed on the card it shows, so a result never carries over to another connection.
	const [tested, setTested] = useState<ITestResult | null>(null);
	// The connection's last stats, once its console has them: they fill what the dialect read at discovery lacks.
	const entry = useVectorEnv().existingConnection(endpoint.key);
	const stats = useSyncExternalStore(
		entry?.controller.subscribe ?? NO_SUBSCRIBE,
		() => entry?.controller.getState().stats.view ?? null,
		() => null
	);
	const fields = useSyncExternalStore(entry?.fields.subscribe ?? NO_SUBSCRIBE, () => entry?.fields.get() ?? null, () => null);
	const sample = useSampleChunks(endpoint, probe, stats);
	const view = vectorCardView(endpoint, probe, stats);
	const test = async (): Promise<void> => {
		setTesting(true);
		try {
			setTested(testResultText(await onTest(endpoint)));
		} finally {
			setTesting(false);
		}
	};
	return (
		<DetailPanel
			open
			onClose={onClose}
			avatar={<VectorIcon />}
			title={view.title}
			subtitle={view.address}
			footer={
				<>
					<Button variant="ghost" disabled={testing} onClick={() => void test()}>
						{testing ? 'Testing…' : 'Test connection'}
					</Button>
					<Button variant="primary" disabled={!view.openable} onClick={() => onOpen(endpoint)}>
						Open console
					</Button>
				</>
			}
		>
			<Section label="Status">
				<StatusBadge variant={view.badge.variant}>{view.badge.label}</StatusBadge>
				<CardMeta view={view} />
				{view.blocked && (
					<div style={{ marginTop: 12 }}>
						<Banner variant={endpoint.state === 'ready' ? 'warning' : 'info'}>{view.blocked}</Banner>
					</div>
				)}
				{tested && (
					<div style={{ marginTop: 12 }}>
						<Banner variant={tested.variant}>{tested.text}</Banner>
					</div>
				)}
			</Section>
			<ConnectionDrawerDetails drawer={drawerView(endpoint, probe, stats)} fields={fields} sample={sample} {...(view.openable ? { onOpenTab: (tab: WorkbenchTab) => onOpenTab(endpoint, tab) } : {})} />
		</DetailPanel>
	);
};

export default ConnectionsView;
