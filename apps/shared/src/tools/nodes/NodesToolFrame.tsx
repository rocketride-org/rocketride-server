// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// NODES TOOL — FRAME (one document per published node: the Node Designer)
// =============================================================================
//
// `tool:nodes/<nodeId>` shows one node the developer publishes: what the
// catalogue knows of it, then the same deploy/publish rail an app has
// (DeployView over createNodeRailHost). Opened from the Nodes sidebar, or
// from a `.rrnode` file in the workspace explorer.
// =============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { ConnectionManager } from 'shell';
import type { DevToolProps } from 'shell';
import { DeployView } from '../appdev/views/builder/panels/deploy/DeployView';
import type { DeploySubject } from '../appdev/views/builder/panels/deploy/DeployView';
import { createNodeRailHost, pickNodePackage } from './nodeRail';

/** A node: published to @me or a team, never to the public store. */
const NODE_SUBJECT: DeploySubject = {
	noun: 'node',
	publicAudience: false,
	intro: 'Upload immutable versions of this node, then publish each to an audience: @me or a team. A run gets the version published to its caller, and the canvas shows the node only where it is published.',
	deployHint: 'Choose the .rrnode to upload as the next immutable version. Binds nothing. Publish it to an audience afterwards.',
	deployCardHint: 'upload a .rrnode as the next version',
	liveFootnote: 'Publishing points an audience at an immutable version: first publish, update and rollback are all this one move. A run takes the version published to its caller, else to a team, when it starts.',
};

const styles: Record<string, CSSProperties> = {
	column: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto' },
	card: {
		display: 'flex',
		gap: 12,
		alignItems: 'center',
		margin: '16px 24px 0',
		padding: '12px 16px',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		fontFamily: 'var(--rr-font-family)',
	},
	icon: { width: 32, height: 32, flexShrink: 0 },
	title: { fontSize: 14, fontWeight: 600, color: 'var(--rr-text-primary)' },
	meta: { fontSize: 12, color: 'var(--rr-text-secondary)' },
	mono: { fontFamily: 'var(--rr-font-family-mono, monospace)' },
	empty: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-text-secondary)',
		fontSize: 13,
		fontFamily: 'var(--rr-font-family)',
	},
};

/** What the catalogue says about a node, when it is published to the caller. */
interface CatalogueEntry {
	title?: string;
	description?: string;
	icon?: string;
}

/** The catalogue entry of one node, kept current as the catalogue refreshes. */
function useCatalogueEntry(nodeId: string): CatalogueEntry | undefined {
	const cm = ConnectionManager.getInstance();
	const read = (): CatalogueEntry | undefined => {
		const { services, icons } = cm.getCachedServices();
		const service = services[nodeId] as CatalogueEntry | undefined;
		if (!service) return undefined;
		// The service names its icon by a key into the catalogue's icon table (SVG text)
		const svg = service.icon ? icons?.[service.icon] : undefined;
		return { ...service, icon: svg ? `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` : undefined };
	};
	const [entry, setEntry] = useState(read);
	useEffect(() => {
		setEntry(read());
		return cm.on('shell:servicesUpdated', () => setEntry(read()));
		// eslint-disable-next-line react-hooks/exhaustive-deps -- read closes over nodeId only
	}, [nodeId]);
	return entry;
}

/** One node's document: its catalogue card, then its versions and audiences. */
const NodeDesigner: React.FC<{ nodeId: string }> = ({ nodeId }) => {
	const host = useMemo(() => createNodeRailHost({ bus: ConnectionManager.getInstance(), nodeId, pickPackage: pickNodePackage }), [nodeId]);
	const entry = useCatalogueEntry(nodeId);
	const app = useMemo(() => ({ id: nodeId, moduleId: nodeId.replace('.', '__'), name: entry?.title || nodeId, status: 'draft' as const }), [nodeId, entry?.title]);
	return (
		<div style={styles.column}>
			<div style={styles.card}>
				{entry?.icon ? <img style={styles.icon} src={entry.icon} alt="" /> : null}
				<div>
					<div style={styles.title}>{entry?.title || nodeId}</div>
					<div style={styles.meta}>
						<span style={styles.mono}>{nodeId}</span>
						{entry ? ` · ${entry.description || 'In your catalogue'}` : ' · Not published to you yet: publish a version to @me to see it on the canvas'}
					</div>
				</div>
			</div>
			<DeployView host={host} app={app} subject={NODE_SUBJECT} />
		</div>
	);
};

/** The nodes tool's frame: one document per node id. */
export const NodesToolFrame: React.FC<DevToolProps> = ({ docKey }) => {
	if (docKey) return <NodeDesigner nodeId={docKey} />;
	return <div style={styles.empty}>Open a node from the Nodes sidebar, or upload a .rrnode.</div>;
};
