// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * NewAppWebview — the New App wizard form.
 *
 * A single-page, stateless-by-design creation form: nothing exists until
 * Create is pressed (the host writes the scaffold in one pass), and closing
 * the panel discards everything. The host owns identity resolution — the
 * webview renders whatever developer id the host reports and sends back only
 * the app-name half, the display name, and the frame options.
 *
 * Architecture:
 *   NewAppProvider (Node.js) <-> postMessage <-> NewAppWebview (browser)
 */

import React, { useCallback, useState } from 'react';
import type { FrameOptions } from 'shared/modules/appdev/templates';
import { useMessaging } from '../hooks/useMessaging';
import type { NewAppHostToWebview, NewAppIdentity, NewAppWebviewToHost } from '../../types/newAppTypes';

// =============================================================================
// CONSTANTS
// =============================================================================

/** One-segment slug shape for the user-typed app-name half. */
const APP_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Wireframe geometry — the 320x200 preview canvas and its chrome regions. */
const WF = {
	x: 6,
	y: 6,
	w: 308,
	h: 188,
	railW: 64,
	footH: 22,
	tabW: 58,
	tabH: 16,
};

/** Wireframe fills — token-driven so the preview follows the editor theme. */
const WF_FILL = {
	content: 'var(--rr-bg-paper)',
	rail: 'var(--rr-bg-input)',
	line: 'var(--rr-border)',
	tab: 'var(--rr-border)',
	tabOn: 'var(--rr-brand)',
	outline: 'var(--rr-border)',
};

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	page: { display: 'flex', justifyContent: 'center', padding: '40px 16px', fontFamily: 'var(--rr-font-family, system-ui)', fontSize: 13, color: 'var(--rr-text-primary)' },
	panel: { width: 640, background: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border)', borderRadius: 6, overflow: 'hidden' },
	header: { padding: '16px 24px 14px', borderBottom: '1px solid var(--rr-border)' },
	headerTitle: { fontSize: 16, fontWeight: 600, margin: 0 },
	headerSub: { marginTop: 4, marginBottom: 0, fontSize: 12, color: 'var(--rr-text-secondary)' },
	body: { padding: '20px 24px' },
	section: { marginBottom: 22 },
	sectionLabel: { display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--rr-text-secondary)', marginBottom: 10 },
	frameRow: { display: 'flex', gap: 18, alignItems: 'stretch' },
	framePreview: { flex: 'none', width: 340, background: 'var(--rr-bg-default)', border: '1px solid var(--rr-border)', borderRadius: 5, padding: 12 },
	frameCaption: { marginTop: 8, textAlign: 'center', fontSize: 11.5, color: 'var(--rr-text-secondary)' },
	frameOptions: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14 },
	checkRow: { display: 'flex', alignItems: 'flex-start', gap: 8 },
	checkBox: { width: 15, height: 15, marginTop: 1, accentColor: 'var(--rr-brand)', cursor: 'pointer' },
	checkLabel: { cursor: 'pointer' },
	checkHint: { display: 'block', color: 'var(--rr-text-secondary)', fontSize: 11.5, marginTop: 2 },
	field: { marginBottom: 14 },
	fieldLabel: { display: 'block', marginBottom: 5 },
	input: { width: '100%', boxSizing: 'border-box', background: 'var(--rr-bg-input)', border: '1px solid var(--rr-border)', borderRadius: 3, color: 'var(--rr-text-primary)', fontSize: 13, padding: '6px 8px', outline: 'none' },
	inputInvalid: { borderColor: 'var(--rr-error, #be1100)' },
	fieldError: { color: 'var(--rr-error, #f48771)', fontSize: 11.5, marginTop: 4 },
	identity: { background: 'var(--rr-bg-default)', border: '1px solid var(--rr-border)', borderRadius: 5, padding: '12px 14px' },
	identityRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' },
	identityKey: { width: 110, color: 'var(--rr-text-secondary)', fontSize: 12, flex: 'none' },
	identityValue: { fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 12.5 },
	chip: { display: 'inline-block', background: 'var(--rr-bg-input)', border: '1px solid var(--rr-border)', borderRadius: 10, padding: '1px 10px 2px', fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 12, color: 'var(--rr-brand)' },
	chipSource: { color: 'var(--rr-text-secondary)', fontSize: 11 },
	linkage: { color: 'var(--rr-success, var(--rr-brand))' },
	footer: { display: 'flex', alignItems: 'center', gap: 8, padding: '14px 24px', borderTop: '1px solid var(--rr-border)', background: 'var(--rr-bg-default)' },
	footerNote: { flex: 1, color: 'var(--rr-text-secondary)', fontSize: 11, lineHeight: 1.4 },
	footerError: { flex: 1, color: 'var(--rr-error, #f48771)', fontSize: 11, lineHeight: 1.4 },
	button: { fontFamily: 'inherit', fontSize: 13, padding: '6px 16px', borderRadius: 3, border: '1px solid transparent', cursor: 'pointer' },
	buttonPrimary: { background: 'var(--rr-brand)', color: 'var(--rr-text-on-brand, #ffffff)' },
	buttonPrimaryDisabled: { background: 'var(--rr-bg-input)', color: 'var(--rr-text-secondary)', cursor: 'default' },
	buttonSecondary: { background: 'transparent', color: 'var(--rr-text-primary)', borderColor: 'var(--rr-border)' },
};

// =============================================================================
// WIREFRAME PREVIEW
// =============================================================================

/** One rectangle of the wireframe preview. */
interface WireRect {
	x: number;
	y: number;
	w: number;
	h: number;
	rx?: number;
	fill: string;
	stroke?: string;
}

/**
 * Computes the wireframe rectangles for the current frame options —
 * the base content surface, then rail / footer / tab strip / text
 * placeholders carved from it, mirroring the AppLayout regions.
 *
 * @param frame - The composable frame options.
 * @returns Rectangles to render, back-to-front.
 */
function buildWireframe(frame: FrameOptions): WireRect[] {
	const rects: WireRect[] = [];
	const { x, y, w, h, railW, footH, tabW, tabH } = WF;

	// step: base content surface
	rects.push({ x, y, w, h, rx: 4, fill: WF_FILL.content });

	// step: compute the content region, carving out rail and footer
	let cx = x;
	let cw = w;
	let ch = h;
	if (frame.sidebar) {
		cx += railW;
		cw -= railW;
	}
	if (frame.statusFooter) ch -= footH;

	// step: sidebar rail with nav item placeholders
	if (frame.sidebar) {
		rects.push({ x, y, w: railW, h: ch, fill: WF_FILL.rail });
		for (let i = 0; i < 4; i++) {
			rects.push({ x: x + 12, y: y + 16 + i * 22, w: railW - 24, h: 8, rx: 3, fill: WF_FILL.line });
		}
	}

	// step: status footer with left/right status placeholders
	if (frame.statusFooter) {
		rects.push({ x, y: y + h - footH, w, h: footH, fill: WF_FILL.rail });
		rects.push({ x: x + 12, y: y + h - footH + 8, w: 70, h: 6, rx: 3, fill: WF_FILL.line });
		rects.push({ x: x + w - 62, y: y + h - footH + 8, w: 50, h: 6, rx: 3, fill: WF_FILL.line });
	}

	// step: document tab strip at the top of the content region
	let cy = y;
	if (frame.docTabs) {
		const tx = cx + 12;
		rects.push({ x: tx, y: cy + 10, w: tabW, h: tabH, rx: 3, fill: WF_FILL.tabOn });
		rects.push({ x: tx + tabW + 6, y: cy + 10, w: tabW, h: tabH, rx: 3, fill: WF_FILL.tab });
		rects.push({ x: tx + (tabW + 6) * 2, y: cy + 10, w: tabW, h: tabH, rx: 3, fill: WF_FILL.tab });
		cy += 30;
	}

	// step: text placeholders filling the remaining content region
	const lineWidths = [0.8, 0.6, 0.72, 0.5];
	lineWidths.forEach((f, i) => {
		rects.push({ x: cx + 14, y: cy + 20 + i * 20, w: (cw - 28) * f, h: 8, rx: 3, fill: WF_FILL.line });
	});

	// step: outer frame outline on top of everything
	rects.push({ x, y, w, h, rx: 4, fill: 'none', stroke: WF_FILL.outline });

	return rects;
}

/**
 * The live wireframe preview — redrawn from the frame options, with a
 * caption naming the resulting composition.
 */
const FramePreview: React.FC<{ frame: FrameOptions }> = ({ frame }) => {
	// step: caption the composition from the enabled options
	const parts: string[] = [];
	if (frame.sidebar) parts.push('Sidebar');
	if (frame.statusFooter) parts.push('Status footer');
	if (frame.docTabs) parts.push('Tabs/Documents');
	const caption = parts.length ? `Full screen + ${parts.join(' + ')}` : 'Full screen';

	return (
		<div style={styles.framePreview}>
			<svg viewBox="0 0 320 200" style={{ width: '100%', height: 'auto', display: 'block' }}>
				{buildWireframe(frame).map((r, i) => (
					<rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={r.rx} fill={r.fill} stroke={r.stroke} strokeWidth={r.stroke ? 1.5 : undefined} />
				))}
			</svg>
			<div style={styles.frameCaption}>{caption}</div>
		</div>
	);
};

// =============================================================================
// CHECK ROW
// =============================================================================

/** One frame-option checkbox with label and hint. */
const CheckRow: React.FC<{ id: string; label: string; hint: string; checked: boolean; onChange: (checked: boolean) => void }> = ({ id, label, hint, checked, onChange }) => (
	<div style={styles.checkRow}>
		<input type="checkbox" id={id} style={styles.checkBox} checked={checked} onChange={(e) => onChange(e.target.checked)} />
		<label htmlFor={id} style={styles.checkLabel}>
			{label}
			<span style={styles.checkHint}>{hint}</span>
		</label>
	</div>
);

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Derives a default display name from the app-name slug, e.g.
 * 'brand-studio' becomes 'Brand Studio'. Same derivation the pre-wizard
 * native flow used for its InputBox default.
 *
 * @param slug - The app-name slug.
 * @returns The title-cased display name.
 */
function deriveDisplayName(slug: string): string {
	return slug.replace(/(^|-)(\w)/g, (_, __, c: string) => ` ${c.toUpperCase()}`).trim();
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The New App wizard form: frame preview + options, name fields, and the
 * computed identity summary. Sends newapp:create with the collected values;
 * the host validates again at submit time and closes the panel on success.
 */
const NewAppWebview: React.FC = () => {
	// ── State ────────────────────────────────────────────────────────────
	/** Live identity from the host; null until newapp:init arrives. */
	const [identity, setIdentity] = useState<NewAppIdentity | null>(null);

	/** The three composable frame options (all off = full screen). */
	const [frame, setFrame] = useState<FrameOptions>({ sidebar: false, statusFooter: false, docTabs: false });

	/** The user-typed app-name slug. */
	const [appName, setAppName] = useState('');

	/** The display name (auto-derived until manually edited). */
	const [displayName, setDisplayName] = useState('');

	/** True once the user edits the display name directly. */
	const [displayTouched, setDisplayTouched] = useState(false);

	/** True while a create request is in flight. */
	const [creating, setCreating] = useState(false);

	/** Error from a failed create, shown in the footer. */
	const [error, setError] = useState<string | null>(null);

	// ── Incoming messages ────────────────────────────────────────────────
	const handleMessage = useCallback((message: NewAppHostToWebview) => {
		switch (message.type) {
			case 'newapp:init':
			case 'newapp:identityUpdate':
				setIdentity(message.identity);
				break;

			case 'newapp:error':
				// Create failed — surface the error and re-enable the form
				setError(message.error);
				setCreating(false);
				break;
		}
	}, []);

	const { sendMessage } = useMessaging<NewAppWebviewToHost, NewAppHostToWebview>({ onMessage: handleMessage });

	// ── Derivations ──────────────────────────────────────────────────────
	// step: validate the slug and check for a live folder collision
	const nameValid = APP_NAME_RE.test(appName);
	const folderName = `${appName}-ui`;
	const collision = nameValid && (identity?.existingFolders ?? []).includes(folderName);
	const workspaceOpen = identity?.workspaceOpen ?? false;
	const canCreate = nameValid && !collision && displayName.trim() !== '' && workspaceOpen && !creating;

	// step: compute the identity summary values
	const developerId = identity?.developerId ?? 'local';
	const shownName = nameValid ? appName : '<name>';
	const linkageName = `${developerId}.${shownName}`;
	const location = `apps/${shownName}-ui/`;

	// ── Callbacks ────────────────────────────────────────────────────────

	/** Updates the slug, auto-deriving the display name while untouched. */
	const onAppNameChange = useCallback(
		(value: string) => {
			setAppName(value);
			if (!displayTouched) setDisplayName(deriveDisplayName(value));
		},
		[displayTouched]
	);

	/** Sends the create request and locks the form until the host answers. */
	const onCreate = useCallback(() => {
		setError(null);
		setCreating(true);
		sendMessage({ type: 'newapp:create', appName, displayName: displayName.trim(), frame });
	}, [sendMessage, appName, displayName, frame]);

	/** Asks the host to close the wizard without creating anything. */
	const onCancel = useCallback(() => {
		sendMessage({ type: 'newapp:cancel' });
	}, [sendMessage]);

	// ── Render ───────────────────────────────────────────────────────────

	if (!identity) return null;

	// step: pick the footer note for the current state
	const note = !workspaceOpen ? 'Open a workspace folder first — the app is scaffolded into it.' : identity.source === 'default' ? 'No organization developer id — using the "local" default.' : 'Developer ID is read from the organization account profile.';

	return (
		<div style={styles.page}>
			<div style={styles.panel}>
				<div style={styles.header}>
					<h1 style={styles.headerTitle}>Create New App</h1>
					<p style={styles.headerSub}>Scaffold a new RocketRide app into the workspace apps directory.</p>
				</div>

				<div style={styles.body}>
					{/* ── Application frame ─────────────────────────────── */}
					<div style={styles.section}>
						<span style={styles.sectionLabel}>Application Frame</span>
						<div style={styles.frameRow}>
							<FramePreview frame={frame} />
							<div style={styles.frameOptions}>
								<CheckRow id="optSidebar" label="Sidebar" hint="Standard navigation rail on the left." checked={frame.sidebar} onChange={(v) => setFrame((f) => ({ ...f, sidebar: v }))} />
								<CheckRow id="optFooter" label="Status footer" hint="Status bar across the bottom of the app." checked={frame.statusFooter} onChange={(v) => setFrame((f) => ({ ...f, statusFooter: v }))} />
								<CheckRow id="optTabs" label="Tabs / Documents" hint="Document tab strip (DocTabs) across the content area." checked={frame.docTabs} onChange={(v) => setFrame((f) => ({ ...f, docTabs: v }))} />
							</div>
						</div>
					</div>

					{/* ── Name ──────────────────────────────────────────── */}
					<div style={styles.section}>
						<span style={styles.sectionLabel}>Name</span>
						<div style={styles.field}>
							<label htmlFor="appName" style={styles.fieldLabel}>
								App name
							</label>
							<input id="appName" type="text" spellCheck={false} placeholder="lowercase letters, digits, hyphens" value={appName} onChange={(e) => onAppNameChange(e.target.value.trim())} style={{ ...styles.input, ...(appName !== '' && !nameValid ? styles.inputInvalid : {}) }} />
							{appName !== '' && !nameValid && <div style={styles.fieldError}>Must start with a letter; lowercase letters, digits, and hyphens only.</div>}
							{collision && <div style={styles.fieldError}>Folder "apps/{folderName}" already exists in the workspace.</div>}
						</div>
						<div style={styles.field}>
							<label htmlFor="displayName" style={styles.fieldLabel}>
								Display name
							</label>
							<input
								id="displayName"
								type="text"
								spellCheck={false}
								value={displayName}
								onChange={(e) => {
									setDisplayTouched(true);
									setDisplayName(e.target.value);
								}}
								style={styles.input}
							/>
						</div>
					</div>

					{/* ── Identity ──────────────────────────────────────── */}
					<div style={styles.section}>
						<span style={styles.sectionLabel}>Identity</span>
						<div style={styles.identity}>
							<div style={styles.identityRow}>
								<span style={styles.identityKey}>Developer ID</span>
								<span style={styles.chip}>{developerId}</span>
								<span style={styles.chipSource}>{identity.source === 'organization' ? 'from organization profile' : 'default (no organization developer id)'}</span>
							</div>
							<div style={styles.identityRow}>
								<span style={styles.identityKey}>Linkage name</span>
								<span style={{ ...styles.identityValue, ...styles.linkage }}>{linkageName}</span>
							</div>
							<div style={styles.identityRow}>
								<span style={styles.identityKey}>Location</span>
								<span style={styles.identityValue}>{location}</span>
							</div>
						</div>
					</div>
				</div>

				{/* ── Footer ────────────────────────────────────────────── */}
				<div style={styles.footer}>
					<div style={error ? styles.footerError : styles.footerNote}>{error ?? note}</div>
					<button type="button" style={{ ...styles.button, ...styles.buttonSecondary }} onClick={onCancel}>
						Cancel
					</button>
					<button type="button" style={{ ...styles.button, ...(canCreate ? styles.buttonPrimary : styles.buttonPrimaryDisabled) }} disabled={!canCreate} onClick={onCreate}>
						{creating ? 'Creating...' : 'Create App'}
					</button>
				</div>
			</div>
		</div>
	);
};

export default NewAppWebview;
