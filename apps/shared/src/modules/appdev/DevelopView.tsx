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
// DEVELOP VIEW — one workspace, pill-switched panes
// =============================================================================

/**
 * The DEVELOP view: `Preview | Code | Components | Events | Console | Errors`
 * as pill-switched panes of ONE workspace (the Status-screen idiom — pills
 * switch the lens, never the context: the dev session, watch state, and
 * accumulated feeds persist across pane switches). Components is the one
 * deliberate stretch of that idiom: a stateless reference pane (the stock
 * component gallery) rather than a lens on the session.
 *
 * Host differences ride the capability flags: the Code pill exists only
 * when `hasCodePane` (web); the native-files strip renders only when
 * `hasNativeFiles` (VSCode); Debug only when `canDebug`. The preview and
 * code surfaces themselves are HOST-PROVIDED slots — this view owns the
 * chrome (toolbar, DEV badge, pills) and the feed panes.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Hand, Monitor, RotateCw, Settings, Smartphone, Tablet } from 'lucide-react';
import { ToggleGroup } from 'shell';
import { ComponentGallery } from './gallery';
import { LogList, LOG_LIST_CAP } from './LogList';
import type { LogListRow } from './LogList';
import type { AppErrorRow, AppEventRow, ConsoleRow, DevelopPane, IAppBuilderHost, WatchStatus } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link DevelopView} component. */
export interface IDevelopViewProps {
	/** The host adapter (data + actions). */
	host: IAppBuilderHost;
	/** The live preview surface (host-owned iframe wrapper). */
	previewPane?: React.ReactNode;
	/** The Code pane surface (web host: file tree + Monaco). */
	codePane?: React.ReactNode;
}

// =============================================================================
// SCREEN LAYOUTS
// =============================================================================

/** Screen-layout presets for the preview viewport. */
type PreviewLayout = 'desktop' | 'tablet' | 'phone';

/** One selectable display resolution (portrait CSS viewport for devices). */
interface DevicePreset {
	/** Short human name shown in the hover menu. */
	name: string;
	width: number;
	height: number;
}

/**
 * The three screen layouts work IDENTICALLY: a frame with an exact CSS
 * viewport floats on the draw canvas, scaled by the zoom and draggable
 * when it overflows. The preview iframe gets these EXACT dimensions, so
 * the app's responsive breakpoints fire exactly as on the device. Each
 * class offers its top-5 common CSS viewports — hover the layout button
 * to pick one.
 */
const DEVICE_PRESETS: Record<PreviewLayout, DevicePreset[]> = {
	desktop: [
		{ name: 'HD', width: 1366, height: 768 },
		{ name: 'WXGA+', width: 1440, height: 900 },
		{ name: 'HD+', width: 1536, height: 864 },
		{ name: 'Full HD', width: 1920, height: 1080 },
		{ name: 'QHD', width: 2560, height: 1440 },
	],
	tablet: [
		{ name: 'iPad Mini 7', width: 744, height: 1133 },
		{ name: 'Galaxy Tab S10', width: 800, height: 1280 },
		{ name: 'iPad Air 11', width: 820, height: 1180 },
		{ name: 'iPad Pro 11', width: 834, height: 1210 },
		{ name: 'iPad Pro 13', width: 1032, height: 1376 },
	],
	phone: [
		{ name: 'Galaxy S25', width: 360, height: 780 },
		{ name: 'iPhone 16', width: 393, height: 852 },
		{ name: 'iPhone 17', width: 402, height: 874 },
		{ name: 'Pixel 9', width: 412, height: 923 },
		{ name: 'iPhone 17 Pro Max', width: 440, height: 956 },
	],
};

/** Default preset index per layout — the class-typical size. */
const DEFAULT_PRESET: Record<PreviewLayout, number> = { desktop: 2, tablet: 2, phone: 2 };

/**
 * Each frame's own footprint (bezel padding + glass borders), included in
 * the fit math so "fits" means the WHOLE frame.
 */
const FRAME_CHROME: Record<PreviewLayout, number> = { desktop: 2, tablet: 26, phone: 26 };

/** host.getPref/setPref key for the persisted preview preferences bag. */
const PREVIEW_PREFS_KEY = 'preview';

/** The persisted preview preferences — ONE bag, ONE write per change. */
interface PreviewPrefs {
	layout: PreviewLayout;
	orientation: 'portrait' | 'landscape';
	zoom: number;
	presetIdx: Record<PreviewLayout, number>;
	inheritAuth: boolean;
	/** Fit mode: the frame tracks the container size (10px margins). */
	fit: boolean;
}

/** Breathing room the fitted frame keeps from every container edge. */
const FIT_MARGIN = 10;

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
	},
	pillRow: {
		padding: '12px 14px 10px',
		borderBottom: '1px solid var(--rr-border)',
		flexShrink: 0,
	},
	toolbar: {
		minHeight: 39,
		background: 'var(--rr-bg-widget)',
		display: 'flex',
		alignItems: 'center',
		// Wrap instead of clip: docked narrow (a skinny editor column), the
		// clusters break onto extra rows rather than overflowing the pane
		// into a horizontal scrollbar.
		flexWrap: 'wrap',
		padding: '5px 10px 4px',
		gap: 8,
		rowGap: 4,
		flexShrink: 0,
		fontSize: 12,
		borderBottom: '1px solid var(--rr-border)',
	},
	// Dev/watch status, inline on the toolbar's left — the flex:1 slot keeps
	// the controls right-aligned even when the status is empty. Replaced the
	// floating DEV badge tile, which covered the preview's own top-right UI.
	devStatus: {
		flex: 1,
		// Shrinkable below content size, so the status text truncates before
		// it forces the control clusters to wrap.
		minWidth: 0,
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		overflow: 'hidden',
		whiteSpace: 'nowrap',
	},
	toolBtn: {
		padding: '4px 9px',
		background: 'transparent',
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		color: 'var(--rr-text-secondary)',
		fontSize: 11.5,
		cursor: 'pointer',
		whiteSpace: 'nowrap',
	},
	toolBtnOn: {
		borderColor: 'var(--rr-color-secondary)',
		color: 'var(--rr-color-secondary)',
	},
	inheritAuthBox: {
		accentColor: 'var(--rr-brand)',
		cursor: 'pointer',
		margin: 0,
	},
	layoutGroup: {
		display: 'flex',
		gap: 2,
	},
	// Thin vertical rule between the layout cluster and the zoom cluster.
	toolbarDivider: {
		width: 1,
		height: 18,
		background: 'var(--rr-border)',
		flexShrink: 0,
	},
	// Grayed-but-visible look for the zoom/hand controls while Fit owns the
	// frame geometry (disabled attributes carry the behavior).
	ctlDisabled: {
		opacity: 0.45,
		cursor: 'default',
	},
	// Anchor for the gear's dropdown, mirroring layoutBtnWrap.
	gearWrap: {
		position: 'relative',
		display: 'inline-flex',
	},
	// The gear dropdown — devtools-style overflow menu, right-aligned under
	// its button. Same visual grammar as resMenu.
	gearMenu: {
		position: 'absolute',
		top: '100%',
		right: 0,
		zIndex: 40,
		minWidth: 180,
		padding: '6px 0',
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
	},
	// One row of the gear menu (checkbox row and action rows alike).
	gearMenuRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		width: '100%',
		padding: '5px 12px',
		background: 'transparent',
		border: 'none',
		color: 'var(--rr-text-primary)',
		fontSize: 11.5,
		textAlign: 'left',
		whiteSpace: 'nowrap',
		cursor: 'pointer',
		userSelect: 'none',
	},
	// Full-viewport click-catcher that closes the gear menu on outside click.
	gearBackdrop: {
		position: 'fixed',
		inset: 0,
		zIndex: 39,
	},
	// Anchor for a layout button's hover resolution menu.
	layoutBtnWrap: {
		position: 'relative',
		display: 'inline-flex',
	},
	// The hover resolution menu — floats below its button, above the canvas.
	resMenu: {
		position: 'absolute',
		top: '100%',
		left: 0,
		zIndex: 40,
		minWidth: 170,
		padding: '4px 0',
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
	},
	resMenuItem: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		width: '100%',
		padding: '4px 10px 4px 6px',
		background: 'transparent',
		border: 'none',
		color: 'var(--rr-text-primary)',
		fontSize: 11.5,
		textAlign: 'left',
		whiteSpace: 'nowrap',
		cursor: 'pointer',
	},
	// Fixed-width dot column so labels align whether or not selected.
	resMenuDot: {
		width: 12,
		flexShrink: 0,
		textAlign: 'center',
		color: 'var(--rr-brand)',
	},
	// Hand-tool pan surface: sits above the app iframe, catches every drag.
	handOverlay: {
		position: 'absolute',
		inset: 0,
		zIndex: 20,
		cursor: 'grab',
		touchAction: 'none',
	},
	// Same visual grammar as toolBtn, sized for a 14px icon; the active
	// layout borrows toolBtnOn's accent.
	layoutBtn: {
		padding: '4px 7px',
		background: 'transparent',
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		color: 'var(--rr-text-secondary)',
		cursor: 'pointer',
		display: 'flex',
		alignItems: 'center',
	},
	// The gray canvas behind a device frame — also the pan surface: drags
	// on it (or the device bezel) move the frame; pointer capture keeps the
	// drag alive across the iframe. Overflow (zooming in past fit, panning)
	// clips via previewScreen's overflow:hidden.
	deviceCenter: {
		width: '100%',
		height: '100%',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		// Same field as the toolbar above — one continuous surface under
		// the rule, with the frame floating on it.
		background: 'var(--rr-bg-widget)',
		cursor: 'grab',
		touchAction: 'none',
	},
	// The device hardware: a dark bezel ring around the glass. Deliberately
	// theme-independent — hardware doesn't change color with the app theme.
	// Doubles as the visible drag handle for panning. transform (fit x zoom
	// scale + pan translate) is computed per layout/zoom in the component.
	deviceShell: {
		flexShrink: 0,
		position: 'relative',
		padding: 12,
		background: '#1c1c1e',
		borderRadius: 26,
		boxShadow: '0 2px 12px rgba(0,0,0,0.25)',
	},
	// Desktop hardware: no bezel ring — just the frame slot the outlined
	// glass sits in. Same DOM position as deviceShell.
	desktopShell: {
		flexShrink: 0,
		position: 'relative',
	},
	// Front-facing camera: a small lens centered in the top bezel ring
	// (portrait), on tablet and phone alike — both device classes have one.
	// Lit ring + glint so it reads against the near-black bezel even when
	// the frame is scaled far below actual size.
	cameraDot: {
		position: 'absolute',
		top: 2,
		left: '50%',
		width: 6,
		height: 6,
		marginLeft: -4,
		borderRadius: '50%',
		background: 'radial-gradient(circle at 35% 35%, #5b7a9d 0%, #101018 65%)',
		border: '1px solid #4a4a52',
	},
	// Landscape: the lens rides the rotation onto the left bezel edge —
	// where landscape-first tablets put it.
	cameraDotLandscape: {
		position: 'absolute',
		top: '50%',
		left: 2,
		width: 6,
		height: 6,
		marginTop: -4,
		borderRadius: '50%',
		background: 'radial-gradient(circle at 35% 35%, #5b7a9d 0%, #101018 65%)',
		border: '1px solid #4a4a52',
	},
	// Desktop has no camera — but the dot element must STAY in the tree
	// (see the stable-wrapper note in the render) so the glass never moves.
	cameraDotHidden: {
		display: 'none',
	},
	// Text-glyph steppers flanking the zoom slider (+/- 5% per click).
	zoomStepBtn: {
		padding: '2px 6px',
		background: 'transparent',
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		color: 'var(--rr-text-secondary)',
		fontSize: 12,
		lineHeight: 1,
		cursor: 'pointer',
	},
	// Desktop "glass": a plain outlined box. Same clipping requirements as
	// deviceFrame below (position anchor + stacking context + radius).
	// content-box so the width/height set inline ARE the app's viewport and
	// the frame chrome math stays exact (borders add outside).
	desktopFrame: {
		position: 'relative',
		boxSizing: 'content-box',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		overflow: 'hidden',
		background: 'var(--rr-bg-default)',
		isolation: 'isolate',
		boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
	},
	// The device "glass": exact device CSS dimensions (set inline), clipped
	// so the app's corners round with it. position:relative is load-bearing:
	// the host's iframe wrapper is absolutely positioned, and without an
	// anchor here it would resolve against the transformed bezel shell (a
	// transform creates a containing block) and paint over the bezel ring.
	// isolation forces a stacking context so the rounded clip applies to
	// the composited iframe under scale transforms. content-box: the set
	// width/height ARE the app's viewport; the border adds outside, keeping
	// the frame chrome math exact.
	deviceFrame: {
		position: 'relative',
		boxSizing: 'content-box',
		border: '1px solid var(--rr-border)',
		borderRadius: 14,
		overflow: 'hidden',
		background: 'var(--rr-bg-default)',
		isolation: 'isolate',
	},
	zoomControl: {
		display: 'flex',
		alignItems: 'center',
		minWidth: 0,
		gap: 6,
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		whiteSpace: 'nowrap',
		userSelect: 'none',
	},
	zoomSlider: {
		// Flexible: shrinks with the pane down to a still-usable thumb run
		// instead of holding a fixed width that forces overflow.
		flex: '1 1 60px',
		minWidth: 48,
		maxWidth: 90,
		margin: 0,
		accentColor: 'var(--rr-brand)',
		cursor: 'pointer',
	},
	// Fixed-width tabular readout so the toolbar doesn't jitter as the
	// percentage changes length while dragging.
	zoomValue: {
		minWidth: 36,
		textAlign: 'right',
		fontVariantNumeric: 'tabular-nums',
	},
	logToolbar: {
		display: 'flex',
		justifyContent: 'flex-end',
		gap: 6,
		padding: '8px 10px 0',
		flexShrink: 0,
	},
	paneHost: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
		position: 'relative',
	},
	previewSurface: {
		flex: 1,
		minHeight: 0,
		position: 'relative',
		display: 'flex',
		flexDirection: 'column',
		background: 'var(--rr-bg-widget)',
	},
	// The draw canvas: clips the floating frame; every layout runs it
	// edge-to-edge under the toolbar rule.
	previewScreen: {
		flex: 1,
		minHeight: 0,
		position: 'relative',
		overflow: 'hidden',
	},
	devBadgeBrand: {
		color: 'var(--rr-brand)',
		fontWeight: 700,
	},
	devBadgeOk: {
		color: 'var(--rr-color-success)',
	},
	devBadgeErr: {
		color: 'var(--rr-color-error)',
	},
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the DEVELOP workspace.
 *
 * @param props - See {@link IDevelopViewProps}.
 */
export const DevelopView: React.FC<IDevelopViewProps> = ({ host, previewPane, codePane }) => {
	const caps = host.capabilities;

	// ── Pane state — the active lens ─────────────────────────────────────
	const [pane, setPane] = useState<DevelopPane>('preview');
	const [previewTheme, setPreviewTheme] = useState<'light' | 'dark'>('light');
	// Persisted preview preferences: read ONCE at mount from host storage
	// (synchronous by then — VSCode delivers the bag with appdev:init) and
	// written back whole by the persist effect below.
	const storedPrefs = useMemo(
		() => (host.getPref?.(PREVIEW_PREFS_KEY) ?? null) as Partial<PreviewPrefs> | null,
		[host],
	);

	// Inherit Auth: hand the host's session to the preview (default) or make
	// the preview run its own OAuth cycle.
	const [inheritAuth, setInheritAuth] = useState(() => storedPrefs?.inheritAuth ?? true);
	// A persisted "off" must reach the host at mount — its own default is ON.
	useEffect(() => {
		if (!(storedPrefs?.inheritAuth ?? true)) host.setInheritAuth?.(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only sync of the persisted value
	}, []);

	// Preview zoom: ABSOLUTE scale of the floating frame (1 = actual CSS
	// pixels), applied as a transform — SCALE, not CSS zoom, because CSS
	// zoom does not reach into an iframe's document (it would magnify
	// pixels without reflowing the app). Entering a layout auto-fits this
	// (see the fit effect below).
	const [previewZoom, setPreviewZoom] = useState(() => storedPrefs?.zoom ?? 1);

	// Screen layout: which fixed-viewport frame floats on the draw canvas
	// (see DEVICE_PRESETS) — all three behave identically.
	const [layout, setLayout] = useState<PreviewLayout>(() =>
		storedPrefs?.layout && DEVICE_PRESETS[storedPrefs.layout] ? storedPrefs.layout : 'desktop');

	// Selected resolution preset per layout (hover menu on the buttons).
	const [presetIdx, setPresetIdx] = useState<Record<PreviewLayout, number>>(() => ({
		...DEFAULT_PRESET,
		...(storedPrefs?.presetIdx ?? {}),
	}));

	// Which layout button's resolution menu is open (hover).
	const [openMenu, setOpenMenu] = useState<PreviewLayout | null>(null);

	// Hand tool: while ON, a transparent overlay covers the whole canvas so
	// pan drags work ANYWHERE — including over the app, whose iframe
	// otherwise swallows the pointer. The app is non-interactive until the
	// tool is toggled off. Plain canvas/bezel drags keep working without it.
	// Deliberately not persisted — it is a transient mode, and restoring a
	// session into a non-interactive preview would read as a hang.
	const [handTool, setHandTool] = useState(false);

	// Fit mode: the frame continuously tracks the container size (FIT_MARGIN
	// around every edge) and the zoom/hand controls are disabled — Fit owns
	// the geometry. Old prefs bags predate the flag: a stored manual zoom
	// means the user was driving the zoom, so default fit OFF for them and
	// ON for everyone else.
	const [fitMode, setFitMode] = useState(() => storedPrefs?.fit ?? (storedPrefs?.zoom == null));

	// The gear (overflow options) dropdown.
	const [gearOpen, setGearOpen] = useState(false);

	// Live pane dimensions for the device fit math. Guard against 0×0: the
	// preview pane stays MOUNTED under display:none while other pills are
	// active, and hidden panels report zero dimensions — adopting those
	// would collapse the device frame to nothing; keep the last real size.
	const screenRef = useRef<HTMLDivElement | null>(null);
	const [screenSize, setScreenSize] = useState<{ width: number; height: number } | null>(null);
	useEffect(() => {
		const el = screenRef.current;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			if (rect && rect.width > 0 && rect.height > 0) {
				setScreenSize({ width: rect.width, height: rect.height });
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// ── Components pane — mounted on first visit, then kept mounted so the
	//    selected entry and knob values survive pill switches ──────────────
	const [galleryMounted, setGalleryMounted] = useState(false);

	// ── ONE merged log — console output, errors, and events interleaved in
	//    arrival order (persists across pane switches). Errors and events
	//    are console ROWS, not separate pages: red accents for errors,
	//    info accents for events.
	const [logRows, setLogRows] = useState<LogListRow[]>([]);
	const appendRow = React.useCallback((row: LogListRow): void => {
		setLogRows((prev) => {
			const next = [...prev, row];
			return next.length > LOG_LIST_CAP ? next.slice(next.length - LOG_LIST_CAP) : next;
		});
	}, []);
	useEffect(() => host.subscribeConsole?.((c: ConsoleRow) => appendRow({
		time: c.time,
		accent: c.level,
		accentColor: c.level === 'error' ? 'var(--rr-color-error)' : c.level === 'warn' ? 'var(--rr-color-warning)' : 'var(--rr-color-info)',
		detail: c.text,
	})), [host.subscribeConsole, appendRow]);
	useEffect(() => host.subscribeErrors?.((e: AppErrorRow) => appendRow({
		time: e.time,
		accent: e.source ?? 'error',
		accentColor: 'var(--rr-color-error)',
		detail: e.message,
	})), [host.subscribeErrors, appendRow]);
	useEffect(() => host.subscribeEvents?.((ev: AppEventRow) => appendRow({
		time: ev.time,
		accent: ev.name,
		accentColor: 'var(--rr-color-info)',
		detail: ev.payload,
	})), [host.subscribeEvents, appendRow]);

	/** Copies the whole log as plain text. */
	const copyLog = (): void => {
		const text = logRows.map((r) => `${r.time}  ${r.accent}  ${r.detail ?? ''}`).join('\n');
		try {
			void navigator.clipboard.writeText(text);
		} catch { /* clipboard unavailable in this webview — nothing to do */ }
	};

	// ── Watch/build status for the DEV badge ─────────────────────────────
	const [watch, setWatch] = useState<WatchStatus | null>(null);
	useEffect(() => host.subscribeWatch?.((s) => setWatch(s)), [host.subscribeWatch]);

	// ── Pill menu — Code only where the host has a Code pane. Errors and
	//    events fold into Console (one log), so no pills of their own.
	const pillOptions = useMemo(() => {
		const options: Array<{ id: DevelopPane; label: string }> = [{ id: 'preview', label: 'Preview' }];
		if (caps.hasCodePane) options.push({ id: 'code', label: 'Code' });
		options.push({ id: 'components', label: 'Components' }, { id: 'console', label: 'Console' });
		return options;
	}, [caps.hasCodePane]);

	/** Switch panes, mounting the Components gallery on its first visit. */
	const selectPane = (id: DevelopPane): void => {
		setPane(id);
		if (id === 'components') setGalleryMounted(true);
	};

	/** Theme toggle: update local toolbar state and tell the host. */
	const applyTheme = (theme: 'light' | 'dark'): void => {
		setPreviewTheme(theme);
		host.setPreviewTheme?.(theme);
	};

	// The active frame geometry — all three layouts share one model: this
	// frame floats on the canvas at previewZoom (absolute scale, 1 = actual
	// CSS pixels), draggable when it overflows. Rotation swaps the frame's
	// axes (landscape); the app viewport rotates with it.
	const preset = DEVICE_PRESETS[layout][presetIdx[layout]] ?? DEVICE_PRESETS[layout][DEFAULT_PRESET[layout]];
	const chrome = FRAME_CHROME[layout];
	const [orientation, setOrientation] = useState<'portrait' | 'landscape'>(() => storedPrefs?.orientation ?? 'portrait');
	const frameWidth = orientation === 'landscape' ? preset.height : preset.width;
	const frameHeight = orientation === 'landscape' ? preset.width : preset.height;

	// Pan offset (screen px); recentered on layout switches below — a pan
	// that made sense for one frame geometry is meaningless for the next.
	const [pan, setPan] = useState({ x: 0, y: 0 });

	/**
	 * The zoom at which the whole frame (chrome included) fits the canvas,
	 * FLOORED to the slider's 5% step — rounding up would clip a bezel
	 * edge — and capped at 100% so small devices in a big pane come up at
	 * actual size, not blown up. Null until the canvas has been measured.
	 */
	const computeFit = (): number | null => {
		if (!screenSize) return null;
		const fit = Math.min(
			screenSize.width / (frameWidth + chrome),
			screenSize.height / (frameHeight + chrome),
			1,
		);
		return Math.max(0.25, Math.floor(fit * 20) / 20);
	};

	/** Layout-change auto-fit (fit mode OFF): whole frame visible, centered. */
	const applyFit = (): void => {
		const fit = computeFit();
		if (fit !== null) {
			setPreviewZoom(fit);
			setPan({ x: 0, y: 0 });
		}
	};

	// Fit-mode zoom: continuously proportional to the container, keeping
	// FIT_MARGIN clear on every edge. Unlike the one-shot auto-fit it is NOT
	// stepped or capped at 100% — the frame genuinely tracks the container,
	// growing past actual size on a big pane. Null until measured.
	const fitZoom = useMemo(() => {
		if (!screenSize) return null;
		const fit = Math.min(
			(screenSize.width - FIT_MARGIN * 2) / (frameWidth + chrome),
			(screenSize.height - FIT_MARGIN * 2) / (frameHeight + chrome),
		);
		// No 25% floor here: fit PROMISES the margins, so a skinny docked
		// pane gets a genuinely tiny frame rather than an overflowing one.
		return Math.max(0.05, fit);
	}, [screenSize, frameWidth, frameHeight, chrome]);

	// The zoom the frame actually renders at — Fit owns it while on.
	const effectiveZoom = fitMode ? (fitZoom ?? previewZoom) : previewZoom;

	/** Toggles Fit: entering recenters and drops the hand tool (both are
	 *  meaningless under fit); leaving adopts the fitted zoom so the frame
	 *  does not jump when the slider takes over. */
	const toggleFit = (): void => {
		if (fitMode) {
			// Consume the pending one-shot auto-fit — the auto-fit effect
			// fires on the fitMode flip and would overwrite the adopted
			// zoom, making the frame jump.
			needsFitRef.current = false;
			if (fitZoom !== null) setPreviewZoom(Math.round(fitZoom * 100) / 100);
			setFitMode(false);
		} else {
			setFitMode(true);
			setHandTool(false);
			setPan({ x: 0, y: 0 });
		}
	};

	// Auto-fit on mode entry, rotation, or resolution change: the zoom is
	// SET so everything is visible; after that the slider is free —
	// absolute scale, pan for the overflow. The fit waits on the first
	// real canvas measurement (needsFitRef), so a boot behind a hidden
	// pill fits once shown. All three reset effects SKIP their mount run —
	// on mount these states carry persisted values that must survive (a
	// stored zoom also suppresses the initial fit). Switching layouts
	// returns to portrait.
	const needsFitRef = useRef(storedPrefs?.zoom == null);
	const layoutMountedRef = useRef(false);
	useEffect(() => {
		if (!layoutMountedRef.current) { layoutMountedRef.current = true; return; }
		needsFitRef.current = true;
		setPan({ x: 0, y: 0 });
		setOrientation('portrait');
	}, [layout]);
	const orientationMountedRef = useRef(false);
	useEffect(() => {
		if (!orientationMountedRef.current) { orientationMountedRef.current = true; return; }
		needsFitRef.current = true;
		setPan({ x: 0, y: 0 });
	}, [orientation]);
	const presetMountedRef = useRef(false);
	useEffect(() => {
		if (!presetMountedRef.current) { presetMountedRef.current = true; return; }
		needsFitRef.current = true;
		setPan({ x: 0, y: 0 });
	}, [presetIdx]);
	useEffect(() => {
		// Fit mode owns the zoom continuously — the one-shot auto-fit only
		// serves manual mode.
		if (fitMode || !needsFitRef.current || !screenSize) return;
		needsFitRef.current = false;
		applyFit();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- applyFit reads the same deps
	}, [screenSize, layout, orientation, presetIdx, fitMode]);

	// Persist the whole preferences bag on any change (skip the mount run —
	// it would just echo the loaded values back).
	const prefsMountedRef = useRef(false);
	useEffect(() => {
		if (!prefsMountedRef.current) { prefsMountedRef.current = true; return; }
		const bag: PreviewPrefs = { layout, orientation, zoom: previewZoom, presetIdx, inheritAuth, fit: fitMode };
		host.setPref?.(PREVIEW_PREFS_KEY, bag);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- host is stable; persist on value changes only
	}, [layout, orientation, previewZoom, presetIdx, inheritAuth, fitMode]);

	// In-flight pan drag; pointer capture on the backdrop keeps move events
	// coming even while the pointer crosses the preview iframe.
	const panDragRef = useRef<{ pointerId: number; originX: number; originY: number; baseX: number; baseY: number } | null>(null);

	/** Starts a pan drag from the gray backdrop or the device bezel. */
	const onPanPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
		// Fit mode owns the geometry — the frame is centered, panning is off.
		if (fitMode || e.button !== 0) return;
		panDragRef.current = { pointerId: e.pointerId, originX: e.clientX, originY: e.clientY, baseX: pan.x, baseY: pan.y };
		e.currentTarget.setPointerCapture(e.pointerId);
	};

	/** Applies the drag delta, clamped so part of the device stays reachable. */
	const onPanPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
		const drag = panDragRef.current;
		if (!drag || e.pointerId !== drag.pointerId) return;
		let x = drag.baseX + (e.clientX - drag.originX);
		let y = drag.baseY + (e.clientY - drag.originY);
		// Clamp: never let the whole device leave the pane — always keep a
		// grabbable sliver (60px) inside the visible area.
		if (screenSize) {
			const maxX = (screenSize.width + (frameWidth + chrome) * effectiveZoom) / 2 - 60;
			const maxY = (screenSize.height + (frameHeight + chrome) * effectiveZoom) / 2 - 60;
			x = Math.max(-maxX, Math.min(maxX, x));
			y = Math.max(-maxY, Math.min(maxY, y));
		}
		setPan({ x, y });
	};

	/** Ends a pan drag and releases the pointer capture. */
	const onPanPointerEnd = (e: React.PointerEvent<HTMLDivElement>): void => {
		const drag = panDragRef.current;
		if (!drag || e.pointerId !== drag.pointerId) return;
		panDragRef.current = null;
		try { e.currentTarget.releasePointerCapture(drag.pointerId); } catch { /* already released */ }
	};

	// The scaled+panned shell and the exact-viewport glass inside it —
	// desktop wears the outlined box, tablet/phone the dark hardware bezel.
	const shellStyle: React.CSSProperties = {
		...(layout === 'desktop' ? styles.desktopShell : styles.deviceShell),
		transform: `translate(${pan.x}px, ${pan.y}px) scale(${effectiveZoom})`,
	};
	const glassStyle: React.CSSProperties = {
		...(layout === 'desktop' ? styles.desktopFrame : styles.deviceFrame),
		width: frameWidth,
		height: frameHeight,
	};

	return (
		<div style={styles.wrap}>
			{/* Pill row — the lens switcher */}
			<div style={styles.pillRow}>
				<ToggleGroup options={pillOptions} value={pane} onChange={selectPane} />
			</div>


			{/* PANE: PREVIEW — toolbar + host slot + DEV badge. KEPT MOUNTED
			    while other panes are active: the preview iframe is a running
			    shell + dev session — unmounting it on every pill switch
			    reboots the whole preview (and its HMR client) for nothing. */}
			{previewPane && (
				<div style={{ ...styles.paneHost, display: pane === 'preview' ? 'flex' : 'none' }}>
					<div style={styles.toolbar}>
						{/* Dev/watch status (single line). The preview URL that used
						    to sit here was informational noise — the status is the
						    fact a developer actually watches. */}
						<div style={styles.devStatus}>
							{watch && watch.state !== 'idle' && (
								<>
									<span style={styles.devBadgeBrand}>DEV</span>
									{watch.target ? <span>&rarr; {watch.target}</span> : null}
									<span style={watch.state === 'error' ? styles.devBadgeErr : styles.devBadgeOk}>
										watch: {watch.state}
										{watch.durationMs != null ? ` · ${(watch.durationMs / 1000).toFixed(1)}s` : ''}
									</span>
								</>
							)}
						</div>
					{/* Screen-layout presets — the iframe gets REAL device CSS
						    dimensions (breakpoints fire); entering a layout
						    auto-fits the zoom so the whole frame is visible.
						    Hovering a button opens its top-5 resolution menu;
						    the dot marks the selected one. */}
						<div style={styles.layoutGroup}>
							{([
								['desktop', <Monitor key="i" size={14} />, 'Desktop'],
								['tablet', <Tablet key="i" size={14} />, 'Tablet'],
								['phone', <Smartphone key="i" size={14} />, 'Phone'],
							] as Array<[PreviewLayout, React.ReactNode, string]>).map(([l, icon, label]) => {
								const selected = DEVICE_PRESETS[l][presetIdx[l]] ?? DEVICE_PRESETS[l][DEFAULT_PRESET[l]];
								return (
									<span
										key={l}
										style={styles.layoutBtnWrap}
										onMouseEnter={() => setOpenMenu(l)}
										onMouseLeave={() => setOpenMenu((m) => (m === l ? null : m))}
									>
										<button
											style={layout === l ? { ...styles.layoutBtn, ...styles.toolBtnOn } : styles.layoutBtn}
											title={`${label} layout: ${selected.name} ${selected.width} x ${selected.height} — hover for resolutions`}
											onClick={() => setLayout(l)}
										>{icon}</button>
										{openMenu === l && (
											<div style={styles.resMenu}>
												{DEVICE_PRESETS[l].map((p, i) => (
													<button
														key={p.name}
														style={styles.resMenuItem}
														onClick={() => {
															setPresetIdx((prev) => ({ ...prev, [l]: i }));
															setLayout(l);
															setOpenMenu(null);
														}}
													>
														<span style={styles.resMenuDot}>{presetIdx[l] === i ? '•' : ''}</span>
														{p.name} · {p.width} x {p.height}
													</button>
												))}
											</div>
										)}
									</span>
								);
							})}
							<button
								style={styles.layoutBtn}
								title="Rotate 90 degrees (portrait/landscape)"
								onClick={() => setOrientation((o) => (o === 'portrait' ? 'landscape' : 'portrait'))}
							><RotateCw size={14} /></button>
						</div>
						<span style={styles.toolbarDivider} />
						<button
							style={fitMode ? { ...styles.toolBtn, ...styles.toolBtnOn } : styles.toolBtn}
							title="Fit: size the preview proportionally to the pane (10px margins) and keep it centered. Zoom and the hand tool take over when off."
							onClick={toggleFit}
						>Fit</button>
						<label
							style={fitMode ? { ...styles.zoomControl, ...styles.ctlDisabled } : styles.zoomControl}
							title={fitMode
								? 'Zoom is driven by Fit — toggle Fit off to zoom manually.'
								: 'Preview zoom: absolute scale, 100% = actual size. Drag the gray canvas to pan when zoomed in. Double-click the slider for 100%.'}
						>
							Zoom
							<button
								style={styles.zoomStepBtn}
								title="Zoom in 5%"
								disabled={fitMode}
								onClick={() => setPreviewZoom((z) => Math.min(2, Math.round((z + 0.05) * 100) / 100))}
							>+</button>
							<input
								type="range"
								min={25}
								max={200}
								step={5}
								value={Math.round(effectiveZoom * 100)}
								disabled={fitMode}
								onChange={(e) => setPreviewZoom(Number(e.target.value) / 100)}
								onDoubleClick={() => { if (!fitMode) setPreviewZoom(1); }}
								style={styles.zoomSlider}
							/>
							<button
								style={styles.zoomStepBtn}
								title="Zoom out 5%"
								disabled={fitMode}
								onClick={() => setPreviewZoom((z) => Math.max(0.25, Math.round((z - 0.05) * 100) / 100))}
							>-</button>
							<span style={styles.zoomValue}>{Math.round(effectiveZoom * 100)}%</span>
						</label>
						<button
							style={{
								...(handTool ? { ...styles.layoutBtn, ...styles.toolBtnOn } : styles.layoutBtn),
								...(fitMode ? styles.ctlDisabled : null),
							}}
							title={fitMode
								? 'The hand tool is driven by Fit — toggle Fit off to pan.'
								: 'Hand tool: drag anywhere on the preview to pan, even over the app. The app is not interactive while active.'}
							disabled={fitMode}
							onClick={() => setHandTool((h) => !h)}
						><Hand size={14} /></button>
						{/* Gear — the devtools-style overflow menu for the options
						    that are not part of the geometry cluster. */}
						<span style={styles.gearWrap}>
							<button
								style={gearOpen ? { ...styles.layoutBtn, ...styles.toolBtnOn } : styles.layoutBtn}
								title="Preview options"
								onClick={() => setGearOpen((o) => !o)}
							><Settings size={14} /></button>
							{gearOpen && (
								<>
									<div style={styles.gearBackdrop} onClick={() => setGearOpen(false)} />
									<div style={styles.gearMenu}>
										{host.setInheritAuth && (
											<label style={styles.gearMenuRow} title="Hand this window's signed-in session to the preview. Unchecked: the preview runs its own OAuth sign-in.">
												<input
													type="checkbox"
													checked={inheritAuth}
													onChange={(e) => {
														setInheritAuth(e.target.checked);
														host.setInheritAuth?.(e.target.checked);
													}}
													style={styles.inheritAuthBox}
												/>
												Inherit Auth
											</label>
										)}
										{host.setPreviewTheme && (
											<button
												style={styles.gearMenuRow}
												onClick={() => applyTheme(previewTheme === 'light' ? 'dark' : 'light')}
											>Theme: {previewTheme === 'light' ? 'Light' : 'Dark'}</button>
										)}
										{host.reloadPreview && (
											<button
												style={styles.gearMenuRow}
												onClick={() => { host.reloadPreview?.(); setGearOpen(false); }}
											>Reload</button>
										)}
										{caps.canDebug && host.debug && (
											<button
												style={styles.gearMenuRow}
												onClick={() => { host.debug?.(); setGearOpen(false); }}
											>Debug (F5)</button>
										)}
									</div>
								</>
							)}
						</span>
					</div>
					<div style={styles.previewSurface}>
						<div ref={screenRef} style={styles.previewScreen}>
							{/* ONE stable wrapper structure for every layout — only
							    the styles switch. Branching to different element
							    trees here would remount the iframe on a layout
							    change, rebooting the entire preview session
							    (shell, dev remote, HMR client). The camera dot is
							    rendered ALWAYS (hidden on desktop) for the same
							    reason: conditional children shift the glass's
							    position and remount it. */}
							<div
								style={fitMode ? { ...styles.deviceCenter, cursor: 'default' } : styles.deviceCenter}
								onPointerDown={onPanPointerDown}
								onPointerMove={onPanPointerMove}
								onPointerUp={onPanPointerEnd}
								onPointerCancel={onPanPointerEnd}
								onDoubleClick={() => { if (!fitMode) setPan({ x: 0, y: 0 }); }}
								title={fitMode ? undefined : 'Drag the gray canvas or the frame edge to pan. Double-click to recenter.'}
							>
								<div style={shellStyle}>
									<div style={layout === 'desktop' ? styles.cameraDotHidden : orientation === 'landscape' ? styles.cameraDotLandscape : styles.cameraDot} />
									<div style={glassStyle}>{previewPane}</div>
								</div>
							</div>
							{/* Hand-tool overlay — ABOVE the iframe so drags work
							    over the app too. Rendered AFTER the center div:
							    appending/removing a trailing sibling never shifts
							    the center's child position, so the iframe is not
							    remounted by toggling the tool. */}
							{handTool && (
								<div
									style={styles.handOverlay}
									onPointerDown={onPanPointerDown}
									onPointerMove={onPanPointerMove}
									onPointerUp={onPanPointerEnd}
									onPointerCancel={onPanPointerEnd}
									onDoubleClick={() => setPan({ x: 0, y: 0 })}
									title="Hand tool: drag to pan. Double-click to recenter."
								/>
							)}
						</div>
					</div>
				</div>
			)}

			{/* PANE: CODE — host slot (web only). KEPT MOUNTED while other
			    panes are active: the compiler/linker live inside it, and the
			    preview needs the project compiled without ever visiting the
			    Code pill (RocketApp's keep-editors-mounted pattern). */}
			{caps.hasCodePane && (
				<div style={{ ...styles.paneHost, display: pane === 'code' ? 'flex' : 'none' }}>{codePane}</div>
			)}

			{/* PANE: COMPONENTS — the stock component gallery. Mounted on
			    first visit, then KEPT MOUNTED (display:none) so the selected
			    entry and knob values survive pill switches. Static reference
			    content: no session state, works identically in both hosts. */}
			{galleryMounted && (
				<div style={{ ...styles.paneHost, display: pane === 'components' ? 'flex' : 'none' }}>
					<ComponentGallery />
				</div>
			)}

			{/* PANE: CONSOLE — the ONE log: console output, errors (red), and
			    platform events (info), interleaved in arrival order. */}
			{pane === 'console' && (
				<div style={styles.paneHost}>
					<div style={styles.logToolbar}>
						<button style={styles.toolBtn} onClick={() => setLogRows([])}>Clear</button>
						<button style={styles.toolBtn} onClick={copyLog}>Copy</button>
					</div>
					<LogList
						rows={logRows}
						emptyTitle="No output yet"
						emptyDescription="Everything lands here as the app runs — console.log / warn / error from the preview, runtime and build errors, and shell platform events."
					/>
				</div>
			)}
		</div>
	);
};
