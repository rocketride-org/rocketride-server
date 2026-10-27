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
// SQL-UI — DIAGRAM VIEW (reverse-engineered ER canvas on xyflow)
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow } from '@xyflow/react';
import type { Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Banner, Button, EmptyState } from 'shell';
import type { SqlEndpoint } from '../connect';
import { refreshSchema, useSchema } from '../schema/schemaStore';
import { useSqlEnv } from '../sqlEnv';
import type { ErNode } from '../canvas/erModel';
import { buildErModel } from '../canvas/erModel';
import { layoutErNodes } from '../canvas/useErLayout';
import TableNode from '../canvas/TableNode';
import { DatabaseIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link DiagramView} component. */
export interface DiagramViewProps {
	/** The connection whose schema the diagram shows. */
	endpoint: SqlEndpoint;
	/**
	 * Fired with a table's name when its node is clicked. The workbench passes
	 * its own navigation in: this view does not reach for the page context.
	 * Without it (the standalone diagram document) a node click does nothing.
	 */
	onOpenTable?: (table: string) => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// The TabPanel body is a BLOCK scroll container, so `flex: 1` has no effect
	// here: React Flow needs a definite height, and without this one the canvas
	// is 0px tall and the page is blank.
	root: {
		height: '100%',
		minHeight: 0,
		minWidth: 0,
		position: 'relative',
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,

	// The toolbar sits above the canvas rather than floating over it: a
	// fitted layout put the first table's header under it (live L1), and
	// this xyflow version pads a fit on every side alike.
	toolbar: {
		alignSelf: 'flex-start',
		margin: '12px 12px 0',
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		padding: '6px 8px',
		boxShadow: '0 1px 4px rgba(0,0,0,.08)',
	} as CSSProperties,

	// The canvas takes what the toolbar leaves: a definite height, which
	// React Flow needs (without it the canvas is 0 px tall).
	canvas: {
		flex: 1,
		minHeight: 0,
		position: 'relative',
	} as CSSProperties,

	toolbarInfo: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		paddingLeft: 4,
	} as CSSProperties,

	bannerWrap: {
		position: 'absolute',
		top: 12,
		left: '50%',
		transform: 'translateX(-50%)',
		zIndex: 5,
		width: 'min(560px, 80%)',
	} as CSSProperties,

	emptyWrap: {
		flex: 1,
		height: '100%',
		minHeight: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	} as CSSProperties,
};

/** Custom node type registration (static — never rebuilt per render). */
const NODE_TYPES = { table: TableNode };

// =============================================================================
// INNER CANVAS
// =============================================================================

/**
 * The canvas body (inside ReactFlowProvider): builds the model from the
 * schema snapshot, runs the elk layout, and renders the flow with the stock
 * Background / MiniMap / Controls plus the floating toolbar.
 */
const DiagramCanvas: React.FC<DiagramViewProps> = ({ endpoint, onOpenTable }) => {
	const env = useSqlEnv();
	const snapshot = useSchema(endpoint.key);
	const { fitView } = useReactFlow();

	const [nodes, setNodes, onNodesChange] = useNodesState<ErNode>([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
	const [laidOut, setLaidOut] = useState(false);

	// Rebuild run guard: the async layout of a superseded run (newer snapshot
	// or unmount) must not overwrite the current nodes; the pending fit frame
	// is cancelled alongside it.
	const runIdRef = useRef(0);
	const rafRef = useRef(0);

	/**
	 * Rebuild the model from the snapshot and auto-layout it.
	 */
	const rebuild = useCallback(async (): Promise<void> => {
		if (!snapshot.schema) return;
		// Capture this run's id — a later rebuild bumps the ref and this run's
		// results are discarded when they land.
		const runId = ++runIdRef.current;
		const model = buildErModel(snapshot.schema);
		const positioned = await layoutErNodes(model.nodes, model.edges);
		if (runId !== runIdRef.current) return;
		setNodes(positioned);
		setEdges(model.edges);
		setLaidOut(true);
		// Fit after the nodes have painted at their new positions.
		rafRef.current = requestAnimationFrame(() => fitView({ padding: 0.15 }));
	}, [snapshot.schema, setNodes, setEdges, fitView]);

	/**
	 * Re-run the elk layout on the CURRENT nodes (toolbar Auto-layout): same
	 * run guard + fit-frame ownership as rebuild(), so a layout superseded by
	 * a newer rebuild/layout (or unmount) is discarded and the pending fit
	 * frame stays cancellable through rafRef.
	 */
	const autoLayout = useCallback(async (): Promise<void> => {
		const runId = ++runIdRef.current;
		const positioned = await layoutErNodes(nodes, edges);
		if (runId !== runIdRef.current) return;
		setNodes(positioned);
		rafRef.current = requestAnimationFrame(() => fitView({ padding: 0.15 }));
	}, [nodes, edges, setNodes, fitView]);

	// Build once per snapshot refresh (refreshedAt bumps on every reflection).
	useEffect(() => {
		setLaidOut(false);
		void rebuild();
		return () => {
			// Supersede any in-flight rebuild and cancel the pending fit frame.
			runIdRef.current += 1;
			cancelAnimationFrame(rafRef.current);
		};
	}, [snapshot.refreshedAt, rebuild]);

	// ── Framing states ───────────────────────────────────────────────────────

	if (snapshot.status === 'error') {
		return (
			<div style={styles.emptyWrap}>
				<EmptyState
					icon={<DatabaseIcon />}
					title="Could not read the schema"
					description={snapshot.error ?? 'The database did not return its tables.'}
					action={<Button variant="primary" onClick={() => { if (env.ready) void refreshSchema(env.getSession(endpoint), { fresh: true }); }}>Retry</Button>}
				/>
			</div>
		);
	}

	if (snapshot.status !== 'ready' || !laidOut) {
		return (
			<div style={styles.emptyWrap}>
				<EmptyState
					icon={<DatabaseIcon />}
					title="Reading the schema…"
					description={`Reading tables, keys and relations from ${endpoint.nodeName}, then laying them out.`}
				/>
			</div>
		);
	}

	return (
		<>
			{/* Floating toolbar (pipeline-canvas convention). */}
			<div style={styles.toolbar}>
				<Button variant="ghost" small onClick={() => { void autoLayout(); }}>
					Auto-layout
				</Button>
				<Button variant="ghost" small onClick={() => fitView({ padding: 0.15 })}>Fit</Button>
				<span style={styles.toolbarInfo}>
					{nodes.length} tables - {edges.length} relations - click a table to open its data
				</span>
			</div>

			{snapshot.schema?.error && (
				<div style={styles.bannerWrap}><Banner variant="warning">{snapshot.schema.error}</Banner></div>
			)}

			<div style={styles.canvas}>
				<ReactFlow
					nodes={nodes}
					edges={edges}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					onNodeClick={onOpenTable ? (_event, node) => onOpenTable(node.id) : undefined}
					nodeTypes={NODE_TYPES}
					fitView
					minZoom={0.15}
					proOptions={{ hideAttribution: true }}
					nodesConnectable={false}
					deleteKeyCode={null}
				>
					<Background gap={18} size={1} />
					{/* Theme tints: tables a readable blue on the paper, and a faint
					    mask outside the view (the list-selection blue painted a
					    solid block). */}
					<MiniMap
						pannable
						zoomable
						nodeColor="color-mix(in srgb, var(--rr-color-info) 30%, var(--rr-bg-paper))"
						nodeStrokeColor="var(--rr-border)"
						maskColor="color-mix(in srgb, var(--rr-text-primary) 8%, transparent)"
						bgColor="var(--rr-bg-paper)"
					/>
					<Controls showInteractive={false} />
				</ReactFlow>
			</div>
		</>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The ER diagram document for one connection: the reverse-engineered schema
 * as table nodes with per-column FK edges, elk auto-layout, and the stock
 * xyflow minimap/controls.
 */
export const DiagramView: React.FC<DiagramViewProps> = ({ endpoint, onOpenTable }) => {
	const env = useSqlEnv();

	// First open reverse-engineers automatically: one fresh re-read of the
	// database (not the task-start reflection), so the diagram always draws
	// the live schema. There is deliberately no toolbar button for it — the
	// header's Refresh Schema re-runs the reflection later if needed.
	const engineeredRef = useRef(false);
	useEffect(() => {
		if (!env.ready || engineeredRef.current) return;
		engineeredRef.current = true;
		void refreshSchema(env.getSession(endpoint), { fresh: true });
	}, [env, endpoint]);

	return (
		<div style={styles.root}>
			<ReactFlowProvider>
				<DiagramCanvas endpoint={endpoint} onOpenTable={onOpenTable} />
			</ReactFlowProvider>
		</div>
	);
};

export default DiagramView;
