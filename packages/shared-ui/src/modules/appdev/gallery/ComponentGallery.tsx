// MIT License
//
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
// COMPONENT GALLERY — the stock component explorer
// =============================================================================

/**
 * The in-product explorer for the stock shared-ui component library: a
 * grouped component list on the left, and a detail pane on the right showing
 * the selected entry's blurb, a LIVE demo of the real component, its knob
 * controls, a copyable usage snippet (rebuilt from the knob values when the
 * entry provides a builder), and the prop contract.
 *
 * Demos render in the current shell theme — the token variables are declared
 * on `:root`, so a per-demo theme flip is not possible without a theme-file
 * change (plan decision D-H).
 *
 * The gallery's own chrome is dogfooded from the library it documents:
 * StatusBadge for the group chip, Banner for doc-only notes, Button for the
 * copy action, ToggleGroup / InputField inside the KnobsPanel, and
 * commonStyles for lists, tables, and text treatments.
 */

import React, { Suspense, useMemo, useState } from 'react';
import { Banner } from '../../../components/banner/Banner';
import { Button } from '../../../components/button/Button';
import { StatusBadge } from '../../../components/status-badge/StatusBadge';
import { commonStyles } from '../../../themes/styles';
import { KnobsPanel } from './KnobsPanel';
import { GALLERY_ENTRIES, GALLERY_GROUPS } from './registry';
import { GALLERY_TOKEN_USAGE } from './tokenUsage.generated';
import type { IGalleryDemoProps, IGalleryEntry, KnobValue, KnobValues } from './galleryTypes';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: {
		display: 'flex',
		height: '100%',
		minHeight: 0,
		background: 'var(--rr-bg-default)',
	},
	// ── Left: grouped component list ─────────────────────────────────────
	list: {
		width: 210,
		flexShrink: 0,
		borderRight: '1px solid var(--rr-border)',
		overflowY: 'auto',
		padding: '10px 8px 16px',
	},
	listGroupLabel: {
		...commonStyles.labelUppercase,
		fontSize: 10,
		display: 'block',
		padding: '12px 8px 5px',
	},
	// ── Right: detail pane ───────────────────────────────────────────────
	detail: {
		flex: 1,
		minWidth: 0,
		overflowY: 'auto',
		padding: '18px 22px 28px',
	},
	detailHeader: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
	},
	detailName: {
		fontSize: 18,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	},
	blurb: {
		...commonStyles.textMuted,
		fontSize: 12.5,
		margin: '8px 0 0',
		maxWidth: 720,
		lineHeight: 1.5,
	},
	sectionLabel: {
		...commonStyles.labelUppercase,
		display: 'block',
		margin: '20px 0 8px',
	},
	// Demo frame: alt-surface bezel around a default-background stage, so
	// components sit on the same background they get on a real page.
	demoBezel: {
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		background: 'var(--rr-bg-surface-alt)',
		padding: 10,
	},
	demoStage: {
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		background: 'var(--rr-bg-default)',
		padding: 18,
		overflow: 'auto',
	},
	demoLoading: {
		...commonStyles.textMuted,
		padding: 18,
	},
	// Snippet block + its copy button row
	snippetWrap: {
		position: 'relative',
		maxWidth: 860,
	},
	snippet: {
		...commonStyles.fontMono,
		fontSize: 11.5,
		lineHeight: 1.55,
		color: 'var(--rr-text-primary)',
		background: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		padding: '12px 14px',
		margin: 0,
		whiteSpace: 'pre',
		overflowX: 'auto',
	},
	snippetCopy: {
		position: 'absolute',
		top: 8,
		right: 8,
	},
	// Prop table on commonStyles.tableHeader / tableCell
	propTable: {
		width: '100%',
		maxWidth: 860,
		borderCollapse: 'collapse',
		fontSize: 12,
	},
	propName: {
		...commonStyles.fontMono,
		fontSize: 11.5,
		whiteSpace: 'nowrap',
	},
	propType: {
		...commonStyles.fontMono,
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	},
	propNote: {
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.45,
	},
	required: {
		color: 'var(--rr-color-error)',
		marginLeft: 2,
	},
	// Token chips: swatch square + mono token name, click-to-copy
	tokenRow: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: 6,
		maxWidth: 860,
	},
	tokenChip: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 6,
		padding: '3px 8px',
		border: '1px solid var(--rr-border)',
		borderRadius: 5,
		background: 'var(--rr-bg-surface-alt)',
		cursor: 'pointer',
	},
	tokenName: {
		...commonStyles.fontMono,
		fontSize: 11,
		color: 'var(--rr-text-primary)',
	},
	tokenSwatch: {
		width: 12,
		height: 12,
		borderRadius: 3,
		border: '1px solid var(--rr-border)',
		flexShrink: 0,
	},
	// commonStyles rows: mono style name + the tokens it contributes
	commonStyleRow: {
		display: 'flex',
		alignItems: 'baseline',
		gap: 12,
		padding: '6px 0',
		borderBottom: '1px solid color-mix(in srgb, var(--rr-border) 30%, transparent)',
		maxWidth: 860,
	},
	commonStyleName: {
		...commonStyles.fontMono,
		fontSize: 11.5,
		color: 'var(--rr-text-primary)',
		whiteSpace: 'nowrap',
		minWidth: 220,
	},
};

// =============================================================================
// HELPERS
// =============================================================================

/** Builds the default knob values for an entry (spec defaults). */
function defaultKnobValues(entry: IGalleryEntry): KnobValues {
	const values: KnobValues = {};
	(entry.knobs ?? []).forEach((knob) => { values[knob.id] = knob.defaultValue; });
	return values;
}

/** Group chip label per gallery group. */
const GROUP_CHIP: Record<IGalleryEntry['group'], string> = {
	chrome: 'Host chrome',
	sidebar: 'Sidebar content',
	content: 'Content component',
};

/** Tokens that are not colors (no swatch): fonts, sizes, radii, shadows. */
const NON_COLOR_TOKEN = /-font|-size|-radius|-shadow|-spacing/;

// =============================================================================
// TOKEN CHIP
// =============================================================================

/** Props for the {@link TokenChip} component. */
interface ITokenChipProps {
	/** The design token name (e.g. '--rr-bg-widget'). */
	token: string;
}

/**
 * One clickable token chip: a live swatch (colour tokens resolve through the
 * current theme via `var()`) beside the mono token name. Clicking copies
 * `var(<token>)` and flashes the name as feedback.
 */
const TokenChip: React.FC<ITokenChipProps> = ({ token }) => {
	const [copied, setCopied] = useState(false);

	/** Copies the ready-to-paste var() expression. */
	const copyToken = (): void => {
		void navigator.clipboard.writeText(`var(${token})`).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		});
	};

	return (
		<span style={styles.tokenChip} onClick={copyToken} title={`Copy var(${token})`}>
			{!NON_COLOR_TOKEN.test(token) && (
				<span style={{ ...styles.tokenSwatch, background: `var(${token})` }} />
			)}
			<span style={styles.tokenName}>{copied ? 'copied' : token}</span>
		</span>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the component gallery.
 *
 * Steps: hold the selected entry id and a per-entry knob-value store (values
 * survive switching entries within the mounted gallery); lazily wrap heavy
 * demos in React.lazy exactly once per entry; render the grouped list and
 * the selected entry's detail pane.
 */
export const ComponentGallery: React.FC = () => {
	// ── Selection — default to the first registered entry ────────────────
	const [selectedId, setSelectedId] = useState<string>(GALLERY_ENTRIES[0].id);

	// ── Per-entry knob values, created on first visit of each entry ──────
	const [knobStore, setKnobStore] = useState<Record<string, KnobValues>>({});

	// ── Copy feedback state ──────────────────────────────────────────────
	const [copied, setCopied] = useState(false);

	// ── Lazy-demo cache — one React.lazy wrapper per heavy entry ─────────
	const lazyCache = useMemo(() => new Map<string, React.LazyExoticComponent<React.ComponentType<IGalleryDemoProps>>>(), []);

	const entry = GALLERY_ENTRIES.find((candidate) => candidate.id === selectedId) ?? GALLERY_ENTRIES[0];
	const knobValues = knobStore[entry.id] ?? defaultKnobValues(entry);

	/** Applies one knob edit to the selected entry's value set. */
	const setKnob = (id: string, value: KnobValue): void => {
		setKnobStore((prev) => ({ ...prev, [entry.id]: { ...(prev[entry.id] ?? defaultKnobValues(entry)), [id]: value } }));
	};

	/** Selects an entry and resets the transient copy feedback. */
	const selectEntry = (id: string): void => {
		setSelectedId(id);
		setCopied(false);
	};

	/** Resolves the demo component: direct, cached-lazy, or none (doc-only). */
	const resolveDemo = (): React.ComponentType<IGalleryDemoProps> | null => {
		if (entry.demo) return entry.demo;
		if (!entry.lazyDemo) return null;
		let lazy = lazyCache.get(entry.id);
		if (!lazy) {
			lazy = React.lazy(entry.lazyDemo);
			lazyCache.set(entry.id, lazy);
		}
		return lazy;
	};

	// ── Snippet — static string or builder over the live knob values ─────
	const code = typeof entry.code === 'function' ? entry.code(knobValues) : entry.code;

	/** Copies the snippet and shows the transient "Copied" label. */
	const copySnippet = (): void => {
		void navigator.clipboard.writeText(code).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};

	const Demo = resolveDemo();

	// ── Token usage (generated map) — union of direct + commonStyles ─────
	const tokenUsage = GALLERY_TOKEN_USAGE[entry.id];
	const allTokens = useMemo(() => {
		if (!tokenUsage) return [];
		const union = new Set(tokenUsage.direct);
		Object.values(tokenUsage.commonStyles).forEach((tokens) => tokens.forEach((token) => union.add(token)));
		return [...union].sort();
	}, [tokenUsage]);

	return (
		<div style={styles.wrap}>
			{/* LEFT: grouped component list */}
			<div style={styles.list}>
				{GALLERY_GROUPS.map((group) => (
					<React.Fragment key={group.id}>
						<span style={styles.listGroupLabel}>{group.label}</span>
						{GALLERY_ENTRIES.filter((candidate) => candidate.group === group.id).map((candidate) => (
							<div
								key={candidate.id}
								style={commonStyles.listRow(candidate.id === entry.id)}
								onClick={() => selectEntry(candidate.id)}
							>
								{candidate.name}
							</div>
						))}
					</React.Fragment>
				))}
			</div>

			{/* RIGHT: detail pane for the selected entry */}
			<div style={styles.detail}>
				<div style={styles.detailHeader}>
					<span style={styles.detailName}>{entry.name}</span>
					<StatusBadge variant="muted">{GROUP_CHIP[entry.group]}</StatusBadge>
				</div>
				<p style={styles.blurb}>{entry.blurb}</p>

				{/* DEMO — live component on a default-background stage */}
				{Demo ? (
					<>
						<span style={styles.sectionLabel}>Live demo</span>
						<div style={styles.demoBezel}>
							<div style={styles.demoStage}>
								<Suspense fallback={<div style={styles.demoLoading}>Loading demo...</div>}>
									<Demo knobs={knobValues} />
								</Suspense>
							</div>
						</div>
					</>
				) : (
					entry.docNote && (
						<div style={{ marginTop: 16, maxWidth: 860 }}>
							<Banner variant="info">{entry.docNote}</Banner>
						</div>
					)
				)}

				{/* KNOBS — only when the entry declares them */}
				{Demo && entry.knobs && entry.knobs.length > 0 && (
					<>
						<span style={styles.sectionLabel}>Knobs</span>
						<KnobsPanel knobs={entry.knobs} values={knobValues} onChange={setKnob} />
					</>
				)}

				{/* USAGE — copyable snippet, live-rebuilt from knob values */}
				<span style={styles.sectionLabel}>Usage</span>
				<div style={styles.snippetWrap}>
					<pre style={styles.snippet}>{code}</pre>
					<div style={styles.snippetCopy}>
						<Button variant="secondary" small onClick={copySnippet}>{copied ? 'Copied' : 'Copy'}</Button>
					</div>
				</div>

				{/* PROPS — the component's contract */}
				{entry.props && entry.props.length > 0 && (
					<>
						<span style={styles.sectionLabel}>Props</span>
						<table style={styles.propTable}>
							<thead>
								<tr>
									<th style={commonStyles.tableHeader}>Prop</th>
									<th style={commonStyles.tableHeader}>Type</th>
									<th style={commonStyles.tableHeader}>Dir</th>
									<th style={commonStyles.tableHeader}>Description</th>
								</tr>
							</thead>
							<tbody>
								{entry.props.map((prop) => (
									<tr key={prop.name}>
										<td style={{ ...commonStyles.tableCell, ...styles.propName }}>
											{prop.name}
											{prop.required && <span style={styles.required} title="Required">*</span>}
										</td>
										<td style={{ ...commonStyles.tableCell, ...styles.propType }}>{prop.type}</td>
										<td style={commonStyles.tableCell}>
											<StatusBadge variant={prop.dir === 'out' ? 'info' : 'muted'}>{prop.dir.toUpperCase()}</StatusBadge>
										</td>
										<td style={{ ...commonStyles.tableCell, ...styles.propNote }}>{prop.note}</td>
									</tr>
								))}
							</tbody>
						</table>
					</>
				)}

				{/* COMMON STYLES — the commonStyles members the component uses,
				    each with the tokens it contributes (generated map) */}
				{tokenUsage && Object.keys(tokenUsage.commonStyles).length > 0 && (
					<>
						<span style={styles.sectionLabel}>commonStyles used</span>
						{Object.entries(tokenUsage.commonStyles).map(([styleName, tokens]) => (
							<div key={styleName} style={styles.commonStyleRow}>
								<span style={styles.commonStyleName}>commonStyles.{styleName}</span>
								<span style={styles.tokenRow}>
									{tokens.map((token) => <TokenChip key={token} token={token} />)}
								</span>
							</div>
						))}
					</>
				)}

				{/* TOKENS — every design token the component themes against
				    (direct + inherited); click a chip to copy var(...) */}
				{allTokens.length > 0 && (
					<>
						<span style={styles.sectionLabel}>Tokens</span>
						<div style={styles.tokenRow}>
							{allTokens.map((token) => <TokenChip key={token} token={token} />)}
						</div>
					</>
				)}
			</div>
		</div>
	);
};
