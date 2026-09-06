// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

// =============================================================================
// NODE CATALOG — the storefront for community nodes.
//
// Reads like the app store on purpose: a search bar, category filters, a grid
// of cards, a detail panel. What it says is different, because the thing being
// offered is different — an app is opened, a node is INSTALLED into your own
// workspace and then appears in the pipeline palette. Every string here leans
// on that distinction rather than leaving it implied.
//
// Host-agnostic: the surrounding app supplies the engine calls through
// INodeCatalogHost, so this renders the same wherever it is mounted.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';

import type { ICapsuleStage } from '../sidebar/capsuleInstall';
import { categoryLabel, priceLabel, type INodeCatalogEntry, type INodeCatalogHost } from './types';

// =============================================================================
// STYLES — the app store's vocabulary: surface cards, a hairline border, one
// accent. Values come from the shared theme tokens so both stores shift
// together when the theme does.
// =============================================================================

const S = {
	page: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--rr-bg-default)' } as CSSProperties,
	header: { padding: '20px 24px 12px', borderBottom: '1px solid var(--rr-border)', flexShrink: 0 } as CSSProperties,
	title: { fontSize: 22, fontWeight: 700, color: 'var(--rr-text-primary)', margin: 0 } as CSSProperties,
	subtitle: { fontSize: 13, color: 'var(--rr-text-secondary)', marginTop: 4 } as CSSProperties,
	controls: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' } as CSSProperties,
	search: {
		flex: '1 1 220px',
		minWidth: 160,
		padding: '7px 10px',
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		outline: 'none',
	} as CSSProperties,
	chip: (active: boolean): CSSProperties => ({
		padding: '5px 11px',
		fontSize: 12,
		borderRadius: 999,
		cursor: 'pointer',
		border: `1px solid ${active ? 'var(--rr-brand)' : 'var(--rr-border)'}`,
		color: active ? 'var(--rr-brand)' : 'var(--rr-text-secondary)',
		background: 'transparent',
		whiteSpace: 'nowrap',
	}),
	body: { flex: 1, overflow: 'auto', padding: 24 } as CSSProperties,
	grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 } as CSSProperties,
	card: {
		display: 'flex',
		flexDirection: 'column',
		gap: 10,
		padding: 14,
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 10,
		cursor: 'pointer',
	} as CSSProperties,
	cardHead: { display: 'flex', gap: 10, alignItems: 'flex-start' } as CSSProperties,
	iconChip: {
		width: 38,
		height: 38,
		flexShrink: 0,
		borderRadius: 8,
		background: 'var(--rr-bg-default)',
		border: '1px solid var(--rr-border)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		overflow: 'hidden',
	} as CSSProperties,
	cardTitle: { fontSize: 14, fontWeight: 600, color: 'var(--rr-text-primary)', lineHeight: 1.3 } as CSSProperties,
	cardMeta: { fontSize: 11, color: 'var(--rr-text-secondary)', marginTop: 2 } as CSSProperties,
	cardBody: { fontSize: 12, color: 'var(--rr-text-secondary)', lineHeight: 1.5, flex: 1 } as CSSProperties,
	cardFoot: { display: 'flex', alignItems: 'center', gap: 8 } as CSSProperties,
	price: { fontSize: 12, fontWeight: 600, color: 'var(--rr-text-primary)' } as CSSProperties,
	badge: (tone: 'ok' | 'muted'): CSSProperties => ({
		fontSize: 10,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.04em',
		padding: '2px 7px',
		borderRadius: 4,
		color: tone === 'ok' ? 'var(--rr-chart-green)' : 'var(--rr-text-secondary)',
		border: `1px solid ${tone === 'ok' ? 'var(--rr-chart-green)' : 'var(--rr-border)'}`,
	}),
	button: (disabled: boolean): CSSProperties => ({
		marginLeft: 'auto',
		padding: '5px 14px',
		fontSize: 12,
		fontWeight: 600,
		borderRadius: 6,
		cursor: disabled ? 'default' : 'pointer',
		border: 'none',
		color: disabled ? 'var(--rr-text-secondary)' : '#fff',
		background: disabled ? 'var(--rr-bg-default)' : 'var(--rr-brand)',
	}),
	empty: { padding: '40px 0', textAlign: 'center', color: 'var(--rr-text-secondary)', fontSize: 13 } as CSSProperties,
	stageList: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 } as CSSProperties,
	stageRow: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 } as CSSProperties,
};

/** One glyph per stage state, so progress reads without colour alone. */
const STAGE_MARK: Record<string, string> = { pending: '·', active: '…', done: '✓', failed: '✕', skipped: '–' };

// =============================================================================
// COMPONENT
// =============================================================================

export interface INodeCatalogViewProps {
	host: INodeCatalogHost;
}

/**
 * The catalog screen: search, filter, and install a published node.
 *
 * @param host - engine calls and the install action, supplied by the app.
 */
export const NodeCatalogView: React.FC<INodeCatalogViewProps> = ({ host }) => {
	const [entries, setEntries] = useState<INodeCatalogEntry[]>([]);
	const [search, setSearch] = useState('');
	const [category, setCategory] = useState('');
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState<string | null>(null);
	const [stages, setStages] = useState<ICapsuleStage[]>([]);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			setEntries(await host.list());
			setError('');
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [host]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Category chips come from what is actually published, not a fixed list —
	// a catalog of user content cannot know its categories in advance.
	const categories = useMemo(() => {
		const seen = new Set<string>();
		for (const entry of entries) for (const c of entry.categories || []) seen.add(c);
		return Array.from(seen).sort();
	}, [entries]);

	const visible = useMemo(() => {
		const needle = search.trim().toLowerCase();
		return entries.filter((entry) => {
			if (category && !(entry.categories || []).includes(category)) return false;
			if (!needle) return true;
			return `${entry.title} ${entry.name} ${entry.description}`.toLowerCase().includes(needle);
		});
	}, [entries, search, category]);

	const install = useCallback(
		async (entry: INodeCatalogEntry) => {
			setBusy(entry.name);
			setStages([]);
			try {
				await host.install(entry);
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(null);
			}
		},
		[host, refresh],
	);

	return (
		<div style={S.page}>
			<div style={S.header}>
				<h1 style={S.title}>Node Catalog</h1>
				{/* Says what this is and what pressing the button does — an app is
				    opened, a node lands in your workspace and runs your pipelines. */}
				<div style={S.subtitle}>Nodes published by the community. Installing one adds it to your workspace and to the pipeline palette.</div>
				<div style={S.controls}>
					<input style={S.search} placeholder="Search nodes" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search nodes" />
					<button type="button" style={S.chip(category === '')} onClick={() => setCategory('')}>
						All
					</button>
					{categories.map((key) => (
						<button key={key} type="button" style={S.chip(category === key)} onClick={() => setCategory(key)}>
							{categoryLabel(key)}
						</button>
					))}
				</div>
			</div>

			<div style={S.body}>
				{error && <div style={{ ...S.empty, color: 'var(--rr-error)' }}>{error}</div>}
				{loading && <div style={S.empty}>Loading the catalog…</div>}
				{!loading && visible.length === 0 && (
					<div style={S.empty}>{entries.length === 0 ? 'No nodes have been published yet.' : 'No node matches that search.'}</div>
				)}

				<div style={S.grid}>
					{visible.map((entry) => {
						const installed = host.installed.includes(entry.name);
						const paid = entry.priceCents > 0;
						return (
							<div key={entry.name} style={S.card}>
								<div style={S.cardHead}>
									<div style={S.iconChip}>
										{entry.icon ? (
											<span style={{ width: 24, height: 24 }} dangerouslySetInnerHTML={{ __html: entry.icon }} />
										) : (
											<span style={{ fontSize: 13, color: 'var(--rr-text-secondary)' }}>{entry.title.slice(0, 2).toUpperCase()}</span>
										)}
									</div>
									<div style={{ minWidth: 0 }}>
										<div style={S.cardTitle}>{entry.title}</div>
										<div style={S.cardMeta}>
											{entry.author?.name || 'Unknown'}
											{entry.versionLabel ? ` · v${entry.versionLabel}` : ''}
										</div>
									</div>
								</div>

								<div style={S.cardBody}>{entry.description || 'No description.'}</div>

								<div style={S.cardFoot}>
									<span style={S.price}>{priceLabel(entry.priceCents)}</span>
									{installed && <span style={S.badge('ok')}>installed</span>}
									{(entry.categories || []).slice(0, 1).map((c) => (
										<span key={c} style={S.badge('muted')}>
											{categoryLabel(c)}
										</span>
									))}
									<button
										type="button"
										// Paid nodes are listed but not sold yet: the registry records
										// the asking price, and charging is not built.
										disabled={paid || installed || busy === entry.name}
										title={paid ? 'Paid nodes are not purchasable yet' : installed ? 'Already in your workspace' : `Install ${entry.title}`}
										style={S.button(paid || installed || busy === entry.name)}
										onClick={() => void install(entry)}
									>
										{busy === entry.name ? 'Installing…' : installed ? 'Installed' : paid ? 'Coming soon' : 'Install'}
									</button>
								</div>

								{/* The staged install, reported as it happens rather than a spinner. */}
								{busy === entry.name && stages.length > 0 && (
									<div style={S.stageList}>
										{stages.map((stage) => (
											<div key={stage.id} style={S.stageRow}>
												<span style={{ width: 12, color: stage.state === 'failed' ? 'var(--rr-error)' : 'var(--rr-text-secondary)' }}>
													{STAGE_MARK[stage.state] ?? '·'}
												</span>
												<span style={{ color: 'var(--rr-text-secondary)' }}>{stage.label}</span>
												{stage.detail && <span style={{ color: 'var(--rr-text-secondary)', opacity: 0.8 }}>— {stage.detail}</span>}
											</div>
										))}
									</div>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
};

export default NodeCatalogView;
