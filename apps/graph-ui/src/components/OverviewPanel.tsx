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
// GRAPH-UI - OVERVIEW (a connection's schema at a glance)
// =============================================================================
//
// The workbench's first tab: count tiles, the schema graph, the relationship types
// and a card per label, all painted from the schema the last load returned
// (graph/overview.ts), so opening it sends nothing. Nothing here runs a query: the
// buttons hand a label, a type or a query text to the workbench, which decides what
// to open and run.
//
// The tab's header actions (Refresh schema, Explore, New query) belong to the workbench that hosts it; this page
// offers Refresh schema (and Explore on an empty graph) only inside its own not-ready states.
//
// Property keys are sampled and relationship endpoints are what the sample saw, so
// the page says "sampled" and "observed patterns". Counts are as the engine gave
// them: "about N" for an estimate, "not reported" when it gave none.
// =============================================================================

import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { Banner, Button } from 'shell';
import type { IExplorerEndpoint } from 'shared/explorer';
import { connectionChips } from '../graph/connections';
import { useConnectionStyle, useGraphEndpoints, useSchemaView } from '../env';
import type { IGraphDialect } from '../graph/dialect';
import { buildOverview } from '../graph/overview';
import type { IOverviewLabel, IOverviewType } from '../graph/overview';
import SchemaGraph from './SchemaGraph';

/** Props. */
export interface IOverviewPanelProps {
	endpoint: IExplorerEndpoint;
	dialect: IGraphDialect | null;
	/** Open the 25-row preview of a label or relationship type in a new tab. */
	onPreview(kind: 'label' | 'type', name: string): void;
	/** Open a new query tab with this text, not run. */
	onNewQuery(cypher: string, title: string): void;
	/** Open (or show) the Explore tab and run its sample. */
	onExplore(): void;
	onRefreshSchema(): void;
}

/** Most label cards and type rows painted; the rest are counted, never silently dropped. */
const LIST_LIMIT = 200;

/** Most properties a card lists before "and N more". */
const PROPERTY_LIMIT = 8;

const styles = {
	page: { height: '100%', overflow: 'auto', boxSizing: 'border-box', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 } as CSSProperties,
	header: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } as CSSProperties,
	title: { margin: 0, fontSize: 16, fontWeight: 600 } as CSSProperties,
	subtitle: { margin: '4px 0 0', fontSize: 12, color: 'var(--rr-text-secondary)' } as CSSProperties,
	actions: { display: 'flex', gap: 8, flexWrap: 'wrap' } as CSSProperties,
	tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8 } as CSSProperties,
	tile: { border: '1px solid var(--rr-border)', borderRadius: 6, padding: '8px 12px', background: 'var(--rr-bg-paper)' } as CSSProperties,
	tileValue: { fontSize: 18, fontWeight: 600 } as CSSProperties,
	tileLabel: { fontSize: 12, color: 'var(--rr-text-secondary)' } as CSSProperties,
	chips: { display: 'flex', gap: 6, flexWrap: 'wrap' } as CSSProperties,
	chip: { fontSize: 11.5, color: 'var(--rr-text-secondary)', border: '1px solid var(--rr-border)', borderRadius: 10, padding: '2px 8px' } as CSSProperties,
	section: { display: 'flex', flexDirection: 'column', gap: 8 } as CSSProperties,
	h2: { margin: 0, fontSize: 13, fontWeight: 600 } as CSSProperties,
	hint: { fontSize: 12, color: 'var(--rr-text-secondary)', margin: 0 } as CSSProperties,
	table: { borderCollapse: 'collapse', width: '100%', fontSize: 12.5 } as CSSProperties,
	th: { textAlign: 'left', fontWeight: 600, fontSize: 11.5, color: 'var(--rr-text-secondary)', padding: '4px 8px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	td: { padding: '6px 8px', borderBottom: '1px solid var(--rr-border)', verticalAlign: 'top' } as CSSProperties,
	cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 8 } as CSSProperties,
	card: { border: '1px solid var(--rr-border)', borderRadius: 6, padding: 12, background: 'var(--rr-bg-paper)', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } as CSSProperties,
	cardHead: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } as CSSProperties,
	cardName: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 } as CSSProperties,
	cardCount: { fontSize: 12, color: 'var(--rr-text-secondary)', whiteSpace: 'nowrap' } as CSSProperties,
	props: { margin: 0, padding: 0, listStyle: 'none', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 } as CSSProperties,
	propType: { color: 'var(--rr-text-secondary)', marginLeft: 8 } as CSSProperties,
	mono: { fontFamily: 'var(--rr-font-mono, monospace)' } as CSSProperties,
	pre: { margin: 0, fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } as CSSProperties,
};

/** One label's card. */
const LabelCard: React.FC<{ label: IOverviewLabel; onPreview: IOverviewPanelProps['onPreview']; onNewQuery: IOverviewPanelProps['onNewQuery'] }> = ({ label, onPreview, onNewQuery }) => (
	<div style={styles.card}>
		<div style={styles.cardHead}>
			<span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: label.fill, flex: 'none' }} />
			<span style={styles.cardName} title={label.title}>{label.name}</span>
			<span style={styles.cardCount}>{label.count}</span>
		</div>
		{label.properties.length === 0 ? (
			<p style={styles.hint}>No property keys were sampled.</p>
		) : (
			<ul style={styles.props} aria-label={`${label.name} properties, sampled`}>
				{label.properties.slice(0, PROPERTY_LIMIT).map((p) => (
					<li key={p.name}>
						<span style={styles.mono}>{p.name}</span>
						{p.types && <span style={styles.propType}>{p.types}</span>}
					</li>
				))}
				{label.properties.length > PROPERTY_LIMIT && <li style={styles.hint}>{`and ${label.properties.length - PROPERTY_LIMIT} more`}</li>}
			</ul>
		)}
		<div style={styles.actions}>
			<Button variant="secondary" small disabled={label.cypher === null} title={label.refusal ?? 'Open a preview in a new query tab'} onClick={() => onPreview('label', label.name)}>Preview</Button>
			<Button variant="ghost" small disabled={label.cypher === null} title={label.refusal ?? 'Open a new query tab with a starter query'} onClick={() => label.cypher !== null && onNewQuery(label.cypher, label.name)}>New query</Button>
		</div>
	</div>
);

/** One row of the relationship table. */
const TypeRow: React.FC<{ row: IOverviewType; onPreview: IOverviewPanelProps['onPreview'] }> = ({ row, onPreview }) => (
	<tr>
		<td style={{ ...styles.td, ...styles.mono }}>{row.type}</td>
		<td style={styles.td}>
			{row.patterns.length === 0 ? '—' : row.patterns.map((p) => <div key={`${p.start}|${p.end}`}>{`${p.start} → ${p.end}${p.observed ? '' : ' (inferred)'}`}</div>)}
		</td>
		<td style={styles.td}>{row.count}</td>
		<td style={styles.td}>{row.properties || '—'}</td>
		<td style={styles.td}><Button variant="ghost" small title="Open a preview in a new query tab" onClick={() => onPreview('type', row.type)}>Preview</Button></td>
	</tr>
);

/**
 * The Overview.
 *
 * @param props - See {@link IOverviewPanelProps}.
 * @returns The page.
 */
export const OverviewPanel: React.FC<IOverviewPanelProps> = ({ endpoint, dialect, onPreview, onNewQuery, onExplore, onRefreshSchema }) => {
	const view = useSchemaView(endpoint.key);
	const { ready, style } = useConnectionStyle(endpoint.key);
	const probe = useGraphEndpoints().probes[endpoint.key];
	// The schema's age is said in minutes, so a new minute is a new model.
	const minute = Math.floor(Date.now() / 60000);
	const model = useMemo(() => buildOverview({ view, dialect, style, ready, chipLabels: connectionChips(endpoint, probe, view).map((chip) => chip.label), endpoint: { nodeName: endpoint.nodeName, pipelineName: endpoint.pipelineName }, now: minute * 60000 }), [view, dialect, style, ready, endpoint, probe, minute]);

	return (
		<div style={styles.page} aria-label="Overview">
			<div style={styles.header}>
				<div>
					<h2 style={styles.title}>{endpoint.nodeName}</h2>
					{model.subtitle && <p style={styles.subtitle}>{model.subtitle}</p>}
				</div>
			</div>

			{model.state !== 'ready' ? (
				<Banner variant={model.state === 'unavailable' ? 'error' : 'info'}>
					<div style={{ fontWeight: 600 }}>{model.headline}</div>
					<div>{model.notice}</div>
					{model.detail && <pre style={styles.pre}>{model.detail}</pre>}
					<div style={{ ...styles.actions, marginTop: 8 }}>
						<Button variant="secondary" small onClick={onRefreshSchema}>Refresh schema</Button>
						{model.state === 'empty' && <Button variant="secondary" small title="Run a sample of the graph in the Explore tab" onClick={onExplore}>Explore</Button>}
					</div>
				</Banner>
			) : (
				<>
					{model.notice && <Banner variant="warning">{model.notice}</Banner>}
					{model.size && <p style={styles.hint}>{`Size: ${model.size}`}</p>}
					<div style={styles.tiles}>
						{model.tiles.map((tile) => (
							<div key={tile.id} style={styles.tile}>
								<div style={styles.tileValue}>{tile.value}</div>
								<div style={styles.tileLabel}>{tile.label}</div>
								{tile.note && <div style={styles.tileLabel}>{tile.note}</div>}
							</div>
						))}
					</div>
					{model.chips.length > 0 && (
						<div style={styles.chips}>
							{model.chips.map((chip) => (
								<span key={chip} style={styles.chip}>{chip}</span>
							))}
						</div>
					)}

					{model.graph && (
						<section style={styles.section} aria-label="Schema graph">
							<h3 style={styles.h2}>Schema graph</h3>
							{model.graph.kind === 'drawn' ? (
								<>
									<p style={styles.hint}>
										Observed patterns, from a sample of the data.
										{model.graph.undrawn > 0 && ` ${model.graph.undrawn} ${model.graph.undrawn === 1 ? 'pattern' : 'patterns'} with a label the schema does not list ${model.graph.undrawn === 1 ? 'is' : 'are'} in the table only.`}
									</p>
									<SchemaGraph graph={model.graph} />
								</>
							) : (
								<p style={styles.hint}>{`This graph has ${model.graph.labels.toLocaleString('en-US')} labels, too many to draw. The cards below list the labels.`}</p>
							)}
						</section>
					)}

					<section style={styles.section} aria-label="Relationship types">
						<h3 style={styles.h2}>Relationship types</h3>
						{model.types.length === 0 ? (
							<p style={styles.hint}>No relationship types were reported.</p>
						) : (
							<table style={styles.table}>
								<thead>
									<tr>
										<th style={styles.th} scope="col">Type</th>
										<th style={styles.th} scope="col">Pattern</th>
										<th style={styles.th} scope="col">Count</th>
										<th style={styles.th} scope="col">Properties (sampled)</th>
										<th style={styles.th} scope="col"><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Actions</span></th>
									</tr>
								</thead>
								<tbody>
									{model.types.slice(0, LIST_LIMIT).map((row) => (
										<TypeRow key={row.type} row={row} onPreview={onPreview} />
									))}
								</tbody>
							</table>
						)}
						{model.types.length > LIST_LIMIT && <p style={styles.hint}>{`and ${model.types.length - LIST_LIMIT} more types; write a query to browse them.`}</p>}
					</section>

					<section style={styles.section} aria-label="Node labels">
						<h3 style={styles.h2}>Node labels</h3>
						{model.labels.length === 0 ? (
							<p style={styles.hint}>No labels were reported.</p>
						) : (
							<div style={styles.cards}>
								{model.labels.slice(0, LIST_LIMIT).map((label) => (
									<LabelCard key={label.name} label={label} onPreview={onPreview} onNewQuery={onNewQuery} />
								))}
							</div>
						)}
						{model.labels.length > LIST_LIMIT && <p style={styles.hint}>{`and ${model.labels.length - LIST_LIMIT} more labels; write a query to browse them.`}</p>}
					</section>
				</>
			)}
		</div>
	);
};

export default OverviewPanel;
