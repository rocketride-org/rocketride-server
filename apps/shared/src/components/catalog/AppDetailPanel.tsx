// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// APP DETAIL PANEL — Apple-style slide-in detail view
// =============================================================================

import React, { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { ChevronLeft, Check } from 'lucide-react';
import { getShellApi } from 'shell';
import type { AppManifestEntry } from 'shell';
import { iconOf, type ICatalogPalette } from './palette';
import { entryLabel, isAgentEntry } from './agentEntry';
import { agentApi, type AgentApi, type ApiRow } from './agentApi';
import EndpointInfoModal from '../../tools/pipelines/components/pipeline-actions/EndpointInfoModal';
import { mintEndpointKey } from '../../tools/pipelines/components/pipeline-actions/endpointKey';
import { publishedSourceEndpoint } from '../../tools/pipelines/components/pipeline-actions/sourceEndpoint';

// Shell runtime access flows through the single curated contract accessor.
const { ConnectionManager } = getShellApi();

// =============================================================================
// CONSTANTS
// =============================================================================


// Honor the OS "reduce motion" setting — same idiom as the sibling store components.
const REDUCE_MOTION =
	typeof window !== 'undefined' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const CTA_POP_KEYFRAMES =
	'@keyframes rr-cta-pop { 0% { transform: scale(0.88); } 55% { transform: scale(1.07); } 100% { transform: scale(1); } }';

// =============================================================================
// TYPES
// =============================================================================

interface AppDetailPanelProps {
	/** The colours the panel draws with. */
	t: ICatalogPalette;
	/** The app to display, or null to hide the panel. */
	app: AppManifestEntry | null;
	/** Whether the panel is visible. */
	open: boolean;
	/** Called when the user clicks Back or the backdrop. */
	onClose: () => void;
	/** Label for the primary action button. */
	ctaLabel: string;
	/** Called when the CTA button is clicked. */
	onCta: (app: AppManifestEntry) => void;
	/** Render full-screen (mobile) instead of the 60%-width slide-in. */
	isMobile?: boolean;
	/** True for a brief window right after the app was added — plays a one-shot success animation on the CTA. */
	justAdded?: boolean;
}

// =============================================================================
// STYLES
// =============================================================================

/**
 * The API section's styles, from the page's pinned tokens.
 *
 * @param t - The theme tokens the panel draws with.
 * @returns One style per part of the section.
 */
const apiStyles = (t: ICatalogPalette) => ({
	/** The section's heading — the Description heading's type. */
	heading: { margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: t.textSec, textTransform: 'uppercase', letterSpacing: 0.6 } as CSSProperties,
	/** The address line: its label, then the address. */
	addressLine: { display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 14, color: t.textSec } as CSSProperties,
	/** The agent's address — the README's inline code, selected whole by a click. */
	address: { fontFamily: t.fontMono, fontSize: 12, color: t.textPri, backgroundColor: t.bgSurface, border: `1px solid ${t.border}`, borderRadius: 3, padding: '1px 5px', overflowWrap: 'anywhere', userSelect: 'all' } as CSSProperties,
	/** One group (Sources): its title, its hint, its rows. */
	group: { marginTop: 22 } as CSSProperties,
	groupTitle: { fontSize: 14, fontWeight: 700, color: t.textPri } as CSSProperties,
	groupHint: { marginTop: 2, fontSize: 13, lineHeight: 1.5, color: t.textSec } as CSSProperties,
	/** The group's rows, framed as one surface. */
	rows: { marginTop: 10, border: `1px solid ${t.border}`, borderRadius: 6, backgroundColor: t.bgSurface, overflow: 'hidden' } as CSSProperties,
	row: { padding: '11px 14px' } as CSSProperties,
	rowDivider: { borderTop: `1px solid ${t.border}` } as CSSProperties,
	/** A row's first line — the name left, its interfaces right. */
	rowHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 } as CSSProperties,
	name: { minWidth: 0, fontSize: 14, fontWeight: 600, color: t.textPri, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	interfaces: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, flexShrink: 0, maxWidth: '60%' } as CSSProperties,
	/** One interface word (`chat`, `database`, `tool`). */
	chip: { padding: '2px 9px', borderRadius: 999, border: `1px solid ${t.borderStrong}`, backgroundColor: t.bg, fontSize: 11, fontWeight: 600, color: t.textSec } as CSSProperties,
	/** A parameter: its public name as a call spells it, its default, then its type and what it does. */
	paramName: { minWidth: 0, fontFamily: t.fontMono, fontSize: 13, fontWeight: 600, color: t.textPri, overflowWrap: 'anywhere' } as CSSProperties,
	paramDefault: { flexShrink: 0, fontSize: 12, color: t.textSec } as CSSProperties,
	paramInfo: { marginTop: 4, fontSize: 13, lineHeight: 1.5, color: t.textSec } as CSSProperties,
	paramType: { fontWeight: 600, color: t.textPri } as CSSProperties,
	/** Opens a source's endpoint dialog. */
	endpointButton: { marginTop: 8, padding: '4px 10px', borderRadius: 4, border: `1px solid ${t.borderStrong}`, backgroundColor: 'transparent', color: t.textPri, fontSize: 12, fontWeight: 600, cursor: 'pointer' } as CSSProperties,
	/** A row's second line — a source's address or a node's id, as a call spells it. */
	id: { marginTop: 4, fontFamily: t.fontMono, fontSize: 12, color: t.textSec, overflowWrap: 'anywhere', userSelect: 'all' } as CSSProperties,
});

// =============================================================================
// API GROUP
// =============================================================================

/** Props for one group of an agent's API. */
interface ApiGroupProps {
	/** The section's styles. */
	s: ReturnType<typeof apiStyles>;
	/** The group's name. */
	title: string;
	/** One sentence on what its rows are for. */
	hint: string;
	rows: ApiRow[];
	/** What a call names for a row: a source's address, a node's id. */
	idOf: (row: ApiRow) => string;
	/** Opens a row's endpoint dialog; a row without an endpoint gets no button. */
	onEndpoint?: (row: ApiRow) => void;
}

/**
 * One group of an agent's API: each row its name, its interfaces and, under
 * them, what a call names (selected whole by a click). A node the author did
 * not name shows its id once, as its name.
 */
const ApiGroup: React.FC<ApiGroupProps> = ({ s, title, hint, rows, idOf, onEndpoint }) => (
	<div style={s.group}>
		<div style={s.groupTitle}>{title}</div>
		<div style={s.groupHint}>{hint}</div>
		<div style={s.rows}>
			{rows.map((row, index) => (
				<div key={`${row.address}/${row.nodeId}`} style={index === 0 ? s.row : { ...s.row, ...s.rowDivider }}>
					<div style={s.rowHead}>
						<span style={s.name} title={row.name}>{row.name}</span>
						{row.interfaces.length > 0 && (
							<span style={s.interfaces}>
								{row.interfaces.map((name) => <span key={name} style={s.chip}>{name}</span>)}
							</span>
						)}
					</div>
					{idOf(row) !== row.name && <div style={s.id}>{idOf(row)}</div>}
					{onEndpoint && publishedSourceEndpoint(row) && (
						<button type="button" style={s.endpointButton} onClick={() => onEndpoint(row)}>
							Endpoint Info
						</button>
					)}
				</div>
			))}
		</div>
	</div>
);

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Apple App Store-inspired detail panel that slides in from the right.
 * Shows hero header with icon, app name, pricing info, stats bar, and description;
 * an agent's panel ends with its API (its address, its sources, its other nodes).
 */
export const AppDetailPanel: React.FC<AppDetailPanelProps> = ({
	app, t, open, onClose, ctaLabel, onCta, isMobile = false, justAdded = false,
}) => {
	const apiS = useMemo(() => apiStyles(t), [t]);
	const [readmeContent, setReadmeContent] = useState('');

	// One-shot "Added" success flash on the CTA: when justAdded flips true, show a
	// check + "Added" with a pop, then settle back into the resting label ("Open").
	const [showAdded, setShowAdded] = useState(false);
	useEffect(() => {
		if (!justAdded) return;
		setShowAdded(true);
		const id = window.setTimeout(() => setShowAdded(false), 1500);
		return () => window.clearTimeout(id);
	}, [justAdded, app?.id]);

	// Fetch readme markdown for the entry the open panel shows. The README
	// shown is always that entry's: the previous entry's text is cleared at
	// once, and its request is aborted so a late answer never lands on the
	// next entry. A closed panel fetches nothing: closing aborts the request
	// in flight and leaves the text in place for the slide-out.
	const readmePath = app?.readme;
	useEffect(() => {
		if (!open) return;
		setReadmeContent('');
		if (!readmePath || !readmePath.startsWith('/')) return;
		const controller = new AbortController();
		fetch(readmePath, { signal: controller.signal })
			.then(r => r.ok ? r.text() : '')
			.then((text) => { if (!controller.signal.aborted) setReadmeContent(text); })
			.catch(() => { if (!controller.signal.aborted) setReadmeContent(''); });
		return () => controller.abort();
	}, [readmePath, open]);

	// An agent's API, read with client.interfaces() for the entry the open
	// panel shows: one read on the server, no engine started. The answer is
	// kept with the address it was asked for, so an API is only ever shown for
	// the entry it belongs to. An app has none; neither has an agent whose read
	// failed (no rung serves the viewer) or listed no node. A closed panel
	// reads nothing and keeps what it shows for the slide-out.
	const agentAddress = app && isAgentEntry(app) && app.pipe ? app.pipe : null;
	const [fetchedApi, setFetchedApi] = useState<{ address: string; api: AgentApi | null } | null>(null);
	useEffect(() => {
		if (!open || !agentAddress) return;
		const client = ConnectionManager.getInstance().getClient();
		if (!client || !client.isAttached()) return;
		let alive = true;
		client
			.interfaces(agentAddress)
			.then((answer) => { if (alive) setFetchedApi({ address: agentAddress, api: agentApi(answer, agentAddress) }); })
			.catch(() => { if (alive) setFetchedApi({ address: agentAddress, api: null }); });
		return () => { alive = false; };
	}, [agentAddress, open]);
	const api = agentAddress && fetchedApi?.address === agentAddress ? fetchedApi.api : null;

	// The source whose endpoint dialog is open: the dialog rocket-ui and VS Code
	// show for a running source, fed here from the published source.
	const [endpointRow, setEndpointRow] = useState<ApiRow | null>(null);
	useEffect(() => { if (!open) setEndpointRow(null); }, [open, agentAddress]);
	// The parameters as the dialog's call examples pass them
	const exampleParams = useMemo(() => (api?.parameters ?? []).map((parameter) => ({ name: parameter.name, value: parameter.example })), [api]);
	const createEndpointKey = useCallback((address: string) => {
		const client = ConnectionManager.getInstance().getClient();
		if (!client) return Promise.reject(new Error('Not connected'));
		return mintEndpointKey(client, address);
	}, []);

	// Close on Escape while open — additive on both layouts, mirrors the Back button.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [open, onClose]);

	// Lock body scroll only for the full-screen mobile sheet. The desktop slide-in
	// keeps its prior behavior (background scrollable). Restore on close/unmount so a
	// route change with the sheet open never strands the page non-scrollable.
	useEffect(() => {
		if (!open || !isMobile) return;
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => { document.body.style.overflow = prevOverflow; };
	}, [open, isMobile]);

	// Base URL for resolving relative paths in the readme (e.g. ./assets/img.png)
	const readmeBase = readmePath ? readmePath.substring(0, readmePath.lastIndexOf('/') + 1) : '';

	if (!app) return null;

	const icon = iconOf(t, app);

	// Determine pricing label from app mode
	const mode = app.mode;
	const pricingLabel = mode === 'free' ? 'Free' : mode === 'paywall' ? 'Free · Premium Features' : 'Subscription';

	// Stats bar items
	const stats: { label: string; value: string }[] = [
		// An agent (a published pipeline) reads "Agent" whatever its categories say.
		{ label: 'CATEGORY',  value: entryLabel(app) ?? '—' },
		{ label: 'DEVELOPER', value: app.publisher || 'Unknown' },
	];

	// Panel container style
	const panelStyle: CSSProperties = {
		position: 'fixed', top: 0, right: 0, bottom: 0,
		width: isMobile ? '100%' : '60%',
		maxWidth: isMobile ? '100%' : 720,
		minWidth: isMobile ? 0 : 400,
		zIndex: 301,
		backgroundColor: t.bg,
		...(t.texture ? { backgroundImage: t.texture, backgroundRepeat: 'repeat', backgroundSize: '300px 300px' } : {}),
		overflowY: 'auto',
		fontFamily: t.font, color: t.textPri,
		transform: open ? 'translateX(0)' : 'translateX(100%)',
		transition: 'transform 0.34s cubic-bezier(0.4, 0, 0.2, 1)',
		boxShadow: open ? '-8px 0 40px rgba(0,0,0,0.20)' : 'none',
	};

	// Backdrop
	const backdropStyle: CSSProperties = {
		position: 'fixed', inset: 0, zIndex: 300,
		backgroundColor: 'rgba(0,0,0,0.30)',
		opacity: open ? 1 : 0,
		transition: 'opacity 0.3s ease',
		pointerEvents: open ? 'all' : 'none',
	};

	return (
		<>
			<style>{CTA_POP_KEYFRAMES}</style>

			{/* Backdrop */}
			<div style={backdropStyle} onClick={onClose} />

			{/* A source's endpoint dialog: the shared one, over the panel */}
			<EndpointInfoModal
				endpointInfo={endpointRow ? publishedSourceEndpoint(endpointRow) : null}
				isOpen={endpointRow !== null}
				onClose={() => setEndpointRow(null)}
				onOpenLink={(url) => { window.open(url, '_blank', 'noopener'); }}
				displayName={endpointRow?.name}
				host={window.location.origin}
				onCreateEndpointKey={createEndpointKey}
				params={exampleParams}
			/>

			{/* Panel */}
			<div style={panelStyle}>
				{/* Back button */}
				<button
					type="button"
					onClick={onClose}
					style={{
						display: 'flex', alignItems: 'center', gap: 6,
						margin: '20px 24px 0', padding: '7px 14px',
						borderRadius: 4, border: `1px solid ${t.borderStrong}`,
						backgroundColor: 'transparent', color: t.textSec,
						fontSize: 13, cursor: 'pointer', fontFamily: t.font,
					}}
				>
					<ChevronLeft size={14} /> Back
				</button>

				{/* Hero header */}
				<div style={{
					margin: '20px 24px', padding: '32px 28px',
					borderRadius: 6,
					background: `linear-gradient(135deg, ${t.bgSurface} 0%, ${t.bgSurfaceHover} 100%)`,
					border: `1px solid ${t.border}`,
					display: 'flex', alignItems: 'center', gap: 24,
				}}>
					{/* Large icon */}
					<div style={{
						width: 96, height: 96, borderRadius: 4, flexShrink: 0,
						backgroundColor: t.bgSurfaceHover,
						border: `1px solid ${t.border}`,
						display: 'flex', alignItems: 'center', justifyContent: 'center',
						overflow: 'hidden',
					}}>
						{icon
							? <img src={icon} alt={app.name} style={{ width: 96, height: 96, objectFit: 'cover' }} />
							: <span style={{ fontSize: 40, fontWeight: 800, color: t.accent }}>{app.name[0]}</span>}
					</div>

					{/* App info */}
					<div style={{ flex: 1 }}>
						<h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: t.textPri, letterSpacing: -0.5 }}>
							{app.name}
						</h1>
						<p style={{ margin: '4px 0 0', fontSize: 14, color: t.textSec }}>
							{app.description}
						</p>
						<p style={{ margin: '6px 0 0', fontSize: 12, color: t.textMuted }}>
							{pricingLabel}
						</p>

						{/* CTA button */}
						<button
							onClick={() => onCta(app)}
							style={{
								marginTop: 14, padding: '8px 28px', borderRadius: 4,
								border: 'none', backgroundColor: t.accent, color: '#fff',
								fontSize: 14, fontWeight: 600, cursor: 'pointer',
								fontFamily: t.font, letterSpacing: 0.2,
								display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
								transition: REDUCE_MOTION ? 'none' : 'background-color 0.25s ease, transform 0.2s ease',
								animation: showAdded && !REDUCE_MOTION ? 'rr-cta-pop 380ms cubic-bezier(0.22,1,0.36,1)' : undefined,
							}}
						>
							{showAdded
								? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Check size={15} /> Added</span>
								: ctaLabel}
						</button>
					</div>
				</div>

				{/* Stats bar */}
				<div style={{
					display: 'flex', justifyContent: 'center', gap: 48,
					padding: '16px 24px',
					borderTop: `1px solid ${t.border}`,
					borderBottom: `1px solid ${t.border}`,
				}}>
					{stats.map((stat) => (
						<div key={stat.label} style={{ textAlign: 'center' }}>
							<div style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, letterSpacing: 0.5, textTransform: 'uppercase' }}>
								{stat.label}
							</div>
							<div style={{ fontSize: 14, fontWeight: 600, color: t.textPri, marginTop: 4 }}>
								{stat.value}
							</div>
						</div>
					))}
				</div>

				{/* README when the entry has one, else its description; absent when it has neither */}
				{(readmeContent || app.description) && (
					<div style={{ padding: '28px 28px 48px' }}>
						<h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: t.textSec, textTransform: 'uppercase', letterSpacing: 0.6 }}>
							Description
						</h3>
						<div style={{ fontSize: 14, lineHeight: 1.8, color: t.textTri }}>
							<ReactMarkdown
								remarkPlugins={[remarkGfm]}
								rehypePlugins={[rehypeRaw, rehypeSanitize]}
								urlTransform={(url) => {
									if (url.startsWith('http') || url.startsWith('/')) return url;
									return readmeBase + url.replace(/^\.\//, '');
								}}
								components={{
									/* Images scale to fit the panel */
									img: ({ node: _node, ...props }) => (
										<img {...props} style={{ maxWidth: '100%', height: 'auto', borderRadius: 8 }} />
									),
									/* Tables get horizontal scroll and themed borders */
									table: ({ node: _node, ...props }) => (
										<div style={{ overflowX: 'auto', margin: '12px 0' }}>
											<table {...props} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }} />
										</div>
									),
									th: ({ node: _node, ...props }) => (
										<th {...props} style={{ textAlign: 'left', padding: '8px 12px', borderBottom: `2px solid ${t.border}`, fontWeight: 700, color: t.textPri }} />
									),
									td: ({ node: _node, ...props }) => (
										<td {...props} style={{ padding: '8px 12px', borderBottom: `1px solid ${t.border}`, verticalAlign: 'top' }} />
									),
									/* Inline code */
									code: ({ node: _node, children, ...props }) => (
										<code {...props} style={{ backgroundColor: t.bgSurface, border: `1px solid ${t.border}`, borderRadius: 3, padding: '1px 5px', fontSize: 12 }}>
											{children}
										</code>
									),
									/* Code blocks */
									pre: ({ node: _node, ...props }) => (
										<pre {...props} style={{ backgroundColor: t.bgSurface, border: `1px solid ${t.border}`, borderRadius: 8, padding: 16, overflowX: 'auto', fontSize: 12, lineHeight: 1.5 }} />
									),
									/* Links open in new tab */
									a: ({ node: _node, ...props }) => (
										<a {...props} target="_blank" rel="noopener noreferrer" style={{ color: t.accent, textDecoration: 'none' }} />
									),
									/* Blockquotes */
									blockquote: ({ node: _node, ...props }) => (
										<blockquote {...props} style={{ borderLeft: `3px solid ${t.accent}`, paddingLeft: 12, margin: '8px 0', color: t.textSec, fontStyle: 'italic' }} />
									),
								}}
							>
								{readmeContent || app.description}
							</ReactMarkdown>
						</div>
					</div>
				)}

				{/* An agent's API, after the README: its address, then what a run starts at and
				    what a call names. Raw elements: the picker draws with the host's palette, which the
				    shell's Section, LabelValue and Chip (drawn in the shell theme) do not follow. */}
				{api && (
					<div style={{ padding: readmeContent || app.description ? '0 28px 48px' : '28px 28px 48px' }}>
						<h3 style={apiS.heading}>API</h3>
						<div style={apiS.addressLine}>
							<span>Address</span>
							<span style={apiS.address}>{api.address}</span>
						</div>
						{api.sources.length > 0 && (
							<ApiGroup
								s={apiS}
								title="Sources"
								hint="Where a run starts. Each source answers at its own address."
								rows={api.sources}
								idOf={(row) => row.address}
								onEndpoint={setEndpointRow}
							/>
						)}
						{api.parameters.length > 0 && (
							<div style={apiS.group}>
								<div style={apiS.groupTitle}>Parameters</div>
								<div style={apiS.groupHint}>What a call may set in params. A call that omits one gets its default.</div>
								<div style={apiS.rows}>
									{api.parameters.map((parameter, index) => (
										<div key={parameter.name} style={index === 0 ? apiS.row : { ...apiS.row, ...apiS.rowDivider }}>
											<div style={apiS.rowHead}>
												<span style={apiS.paramName}>{parameter.name}</span>
												{parameter.default && <span style={apiS.paramDefault}>default {parameter.default}</span>}
											</div>
											<div style={apiS.paramInfo}>
												<span style={apiS.paramType}>{parameter.type}</span>
												{parameter.description && <> · {parameter.description}</>}
											</div>
										</div>
									))}
								</div>
							</div>
						)}
					</div>
				)}
			</div>
		</>
	);
};
