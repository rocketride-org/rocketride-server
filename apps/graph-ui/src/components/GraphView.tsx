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
// GRAPH-UI - GRAPH VIEW (toolbar, canvas, inspector, menus, legend and status line)
// =============================================================================
//
// The canvas (React Flow, d3-force worker) is a separate chunk: it loads when the
// Graph tab is first shown, so the editor, the Table, the Raw view and the history
// open without it. If the chunk cannot load (offline, blocked), the view says so
// and points at the Table, which holds every returned row.
//
// Every canvas action is also a BUTTON here, not only a key, a double click or a
// right-click: expand, collapse, dismiss, connect, find path and inspect all work
// from the toolbar on the focused (and, for paths, the two selected) nodes.
//
// Nothing here is a dialog. The inspector and the keys help are inline columns,
// the menus are drawn inside the canvas, and notices are one status line under
// it: rocket-ui keeps every document mounted, and a modal left open in a hidden
// document would trap Tab and take Escape for the whole window. The view adds no
// listener on the document; keys are handled by React handlers on its own
// elements, and a menu closes when a pointer goes down outside it.
// =============================================================================

import React, { Component, Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Button, EmptyState } from 'shell';
import { useConnectionStyle, useGraphEnv, useSchemaView } from '../env';
import { captionOf } from '../graph/captions';
import { menuItemsFor, relationshipTypesFor } from '../graph/canvasMenu';
import type { IMenuItem } from '../graph/canvasMenu';
import { nodeLooks } from '../graph/badges';
import { labelColors, neutralColors, typeColorsOf } from '../graph/colors';
import type { IGraphSession, IGraphState } from '../graph/graphSession';
import { exportFailureText, exportOutcome } from '../graph/exportWording';
import { inspectNode } from '../graph/inspector';
import { legendOf, nodeIdsOfLabel, typeLegendOf } from '../graph/legend';
import { MAX_COPY_CHARS } from '../graph/exportRows';
import { searchNodes } from '../graph/search';
import { statusItems } from '../graph/statusLine';
import { fitToolbar } from '../graph/toolbarFit';
import type { IToolbarSlot } from '../graph/toolbarFit';
import type { GraphNode } from '../graph/types';
import { toJsonText } from '../graph/values';
import { STOP_WAITING_NOTE, canvasBudgetText } from '../graph/wording';
import type { CanvasMenuTarget, IGraphCanvasHandle, LayoutMode } from '../canvas/GraphCanvas';
import type { LayoutStatus } from '../canvas/useGraphLayout';
import { GraphIcon } from '../icons';
import { CanvasMenu } from './CanvasMenu';
import { CanvasSearch } from './CanvasSearch';
import { GraphStatusLine } from './GraphStatusLine';
import { InspectorPanel } from './InspectorPanel';
import { KeysPanel } from './KeysPanel';
import { LegendPanel } from './LegendPanel';
import { CopyBlocked, copyText } from './ResultViews';

// The canvas is imported for its TYPES only above; the value comes through the lazy boundary.
const GraphCanvas = lazy(() => import('../canvas/GraphCanvas'));

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	root: { display: 'flex', flexDirection: 'row', height: '100%', minHeight: 0 } as CSSProperties,
	main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } as CSSProperties,
	// Never wraps: what does not fit moves to the More menu (graph/toolbarFit.ts).
	toolbar: { display: 'flex', flexWrap: 'nowrap', gap: 6, alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	focused: { fontSize: 12, color: 'var(--rr-text-secondary)', marginRight: 6, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	spacer: { marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'nowrap' } as CSSProperties,
	canvas: { flex: 1, minHeight: 0, position: 'relative' } as CSSProperties,
	side: { width: 320, flex: '0 0 320px', minHeight: 0, overflowY: 'auto', borderLeft: '1px solid var(--rr-border)', background: 'var(--rr-bg-default)' } as CSSProperties,
	menuAnchor: { position: 'relative', display: 'inline-block' } as CSSProperties,
};

// =============================================================================
// ERROR BOUNDARY (the canvas chunk may fail to load)
// =============================================================================

/** Catches a failed canvas chunk or a canvas crash and offers the Table instead. */
class CanvasBoundary extends Component<{ children: ReactNode }, { failed: string | null }> {
	state = { failed: null as string | null };
	static getDerivedStateFromError(error: unknown): { failed: string } {
		return { failed: error instanceof Error ? error.message : String(error) };
	}
	render(): ReactNode {
		if (this.state.failed === null) return this.props.children;
		return (
			<EmptyState
				icon={<GraphIcon />}
				title="The graph view could not load"
				description={`${this.state.failed}. The Table tab lists every returned row, and the query editor is unaffected.`}
				action={<Button variant="primary" onClick={() => this.setState({ failed: null })}>Try again</Button>}
			/>
		);
	}
}

// =============================================================================
// HELPERS
// =============================================================================

/** Whether a key press happened in something the user types into. */
function isTyping(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el || typeof el.tagName !== 'string') return false;
	return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.closest('.monaco-editor') !== null;
}

/**
 * Save a blob as a file.
 *
 * @param blob - The content.
 * @param name - The file name.
 */
function download(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The toolbar menus. */
type ToolMenu = 'view' | 'export' | 'more';

// =============================================================================
// COMPONENT
// =============================================================================

/** Props. */
export interface IGraphViewProps {
	session: IGraphSession;
	/** Every label of the connection (from its schema), so colours stay stable between queries. */
	schemaLabels: readonly string[];
	/** Caption choice per label, owned by the workbench (persisted per connection). */
	captions: ReadonlyMap<string, string>;
	/** No longer called: captions are kept with the connection's style. Accepted so a host that still passes it compiles. */
	onCaption?(label: string, choice: string): void;
	/** Open the inspector for a node. */
	onInspect(id: string): void;
	/** Text identifying this result, for the layout seed. */
	seedKey: string;
	announce(text: string): void;
	/** The connection (its style and schema). */
	endpointKey?: string;
	/** What the result is (rows, time), shown in the status line. */
	meta?: React.ReactNode;
	/** Run the query again (the status line's out-of-date action). */
	onRerun?(): void;
	/** Open a new query tab with this text, not run. */
	onNewQuery?(cypher: string, title: string): void;
	/** Whether the result area fills the document. */
	maximized?: boolean;
	onToggleMaximized?(): void;
	/** `copy` where the host cannot download files (VS Code): Export copies the SVG and the JSON, and PNG is not offered. */
	exportMode?: 'download' | 'copy';
	/**
	 * View state a host may keep per tab, so a tab switch does not reset it. When a value is given it is used and a
	 * change is reported; otherwise the view keeps its own.
	 */
	layoutMode?: LayoutMode;
	onLayoutModeChange?(mode: LayoutMode): void;
	keepPinned?: boolean;
	onKeepPinnedChange?(keep: boolean): void;
	legendOpen?: boolean;
	onLegendOpenChange?(open: boolean): void;
}

/**
 * The graph view.
 *
 * @param props - See {@link IGraphViewProps}.
 * @returns The view.
 */
export const GraphView: React.FC<IGraphViewProps> = ({ session, schemaLabels, captions: hostCaptions, onInspect, seedKey, announce, endpointKey, meta, onRerun, onNewQuery, maximized, onToggleMaximized, exportMode = 'download', layoutMode: layoutModeProp, onLayoutModeChange, keepPinned: keepPinnedProp, onKeepPinnedChange, legendOpen: legendOpenProp, onLegendOpenChange }) => {
	const state: IGraphState = useSyncExternalStore(session.subscribe, session.getState, session.getState);
	const env = useGraphEnv();
	const key = endpointKey ?? '';
	const styleView = useConnectionStyle(key);
	const style = styleView.style;
	// A caption kept with the connection's style wins over one the host still passes.
	const captions = useMemo(() => {
		const merged = new Map(hostCaptions);
		for (const label of Object.keys(style.labels)) {
			const caption = style.labels[label]?.caption;
			if (caption) merged.set(label, caption);
		}
		return merged;
	}, [hostCaptions, style]);
	const schema = useSchemaView(key);
	const [layoutStatus, setLayoutStatus] = useState<LayoutStatus>({ state: 'idle' });
	// The canvas reports its layout once it has mounted, so Export waits for that (its handle is null before).
	const canvasReady = layoutStatus.state !== 'idle';
	const [helpOpen, setHelpOpen] = useState(false);
	const [helpToken, setHelpToken] = useState(0);
	const [legendOwn, setLegendOwn] = useState(false);
	const [inspectToken, setInspectToken] = useState(0);
	const [layoutOwn, setLayoutOwn] = useState<LayoutMode>('force');
	const [pinnedOwn, setPinnedOwn] = useState(true);
	const layoutMode = layoutModeProp ?? layoutOwn;
	const keepPinned = keepPinnedProp ?? pinnedOwn;
	const legendOpen = legendOpenProp ?? legendOwn;
	const setLayoutMode = (mode: LayoutMode): void => {
		setLayoutOwn(mode);
		onLayoutModeChange?.(mode);
	};
	const setKeepPinned = (keep: boolean): void => {
		setPinnedOwn(keep);
		onKeepPinnedChange?.(keep);
	};
	const setLegendOpen = (open: boolean): void => {
		setLegendOwn(open);
		onLegendOpenChange?.(open);
	};
	const [blockedCopy, setBlockedCopy] = useState<string | null>(null);
	const [pickFrom, setPickFrom] = useState<string | null>(null);
	const [menu, setMenu] = useState<{ target: CanvasMenuTarget; x: number; y: number } | null>(null);
	const [toolMenu, setToolMenu] = useState<ToolMenu | null>(null);
	const [toolStart, setToolStart] = useState<'first' | 'last'>('first');
	const [query, setQuery] = useState('');
	const [current, setCurrent] = useState(0);
	const canvasBox = useRef<HTMLDivElement>(null);
	const handle = useRef<IGraphCanvasHandle | null>(null);
	const searchInput = useRef<HTMLInputElement>(null);
	const triggers = useRef<Record<ToolMenu, HTMLSpanElement | null>>({ view: null, export: null, more: null });
	const toolbar = useRef<HTMLDivElement | null>(null);

	// An informational notice leaves by itself; a warning or an error stays until the next action.
	const [expiredNotice, setExpiredNotice] = useState<unknown>(null);
	useEffect(() => {
		if (!state.notice || state.notice.variant !== 'info') return undefined;
		const notice = state.notice;
		const timer = window.setTimeout(() => setExpiredNotice(notice), 6000);
		return () => window.clearTimeout(timer);
	}, [state.notice]);

	const allLabels = useMemo(() => {
		const labels = new Set(schemaLabels);
		for (const node of state.model.nodes.values()) for (const l of node.labels.slice(0, 1)) labels.add(l);
		return labels;
	}, [schemaLabels, state.model.nodes]);
	// Until the style is read, nothing is drawn in a colour that would change a moment later.
	const colors = useMemo(() => (styleView.ready ? labelColors(style, allLabels) : neutralColors(allLabels)), [styleView.ready, style, allLabels]);
	const looks = useMemo(() => nodeLooks(allLabels, style), [style, allLabels]);
	const typeColors = useMemo(() => typeColorsOf(style), [style]);
	const legend = useMemo(() => legendOf(state.model, colors), [state.model, colors]);
	const typeLegend = useMemo(() => typeLegendOf(state.model, typeColors), [state.model, typeColors]);
	const nodes = useMemo(() => [...state.model.nodes.values()], [state.model.nodes]);
	const captionFor = (n: GraphNode): string => captionOf(n, captions.get(n.labels[0] ?? ''));

	const matches = useMemo(() => searchNodes(nodes, query, (n) => captionOf(n, captions.get(n.labels[0] ?? ''))), [nodes, query, captions]);
	const matchIds = useMemo(() => (matches === null ? null : new Set(matches)), [matches]);
	// The list of matches changes under the search after an expand, a collapse or a dismiss: start again from the first, and never read past the end.
	const matchKey = matches === null ? null : matches.join('\u0000');
	useEffect(() => {
		setCurrent(0);
	}, [matchKey]);
	const at = matches === null ? 0 : Math.min(current, Math.max(0, matches.length - 1));
	// The canvas no longer refits when its size changes, so a change of full screen asks for it.
	const wasMaximized = useRef(maximized);
	useEffect(() => {
		if (wasMaximized.current === maximized) return;
		wasMaximized.current = maximized;
		// After the resize has reached the canvas.
		const timer = window.setTimeout(() => handle.current?.fit(), 60);
		return () => window.clearTimeout(timer);
	}, [maximized]);

	const budget = canvasBudgetText(state.model);
	const focused = state.focusedId !== null ? state.model.nodes.get(state.focusedId) : undefined;
	const focusedCaption = focused ? captionFor(focused) : null;
	const busy = state.busy !== null;
	const hasMore = state.model.hiddenNodes > 0 && state.model.nodes.size < 1000;
	// Out of date: a write ran after the drawing, or this element came back as a different one. Nothing is fetched for it.
	const focusedStale = state.stale || (focused !== undefined && state.staleIds.has(focused.id));

	// A menu closes when the selection changes under it (but not for the change that came with opening it).
	const selectionSig = `${[...state.selected].join('\u0000')}|${state.selectedRelationship ?? ''}`;
	const openedSig = useRef(selectionSig);
	useEffect(() => {
		openedSig.current = selectionSig;
	}, [menu]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (menu !== null && selectionSig !== openedSig.current) setMenu(null);
	}, [selectionSig]); // eslint-disable-line react-hooks/exhaustive-deps

	// ---------------------------------------------------------------------
	// actions
	// ---------------------------------------------------------------------

	/** Put focus back on the node a menu or panel was about; when the canvas cannot (not drawn, off screen), on the toolbar. */
	const restoreFocus = (nodeId?: string): void => {
		const id = nodeId ?? state.focusedId;
		if (id !== null && id !== undefined && handle.current?.focusNode(id)) return;
		toolbar.current?.querySelector('button')?.focus();
	};
	const restoreToolFocus = (which: ToolMenu): void => triggers.current[which]?.querySelector('button')?.focus();

	const inspect = (id: string): void => {
		onInspect(id);
		setInspectToken((n) => n + 1);
	};
	const startPath = (id: string): void => {
		setPickFrom(id);
		announce('Pick the second node for the path.');
	};
	const choosePathEnd = (id: string): void => {
		const from = pickFrom;
		setPickFrom(null);
		if (from === null || from === id) return;
		session.clearSelection();
		session.toggleSelect(from);
		session.toggleSelect(id);
		session.inspect(null);
		void session.findPath();
	};
	const nodeClick = (id: string, mode: 'only' | 'toggle'): void => {
		if (pickFrom !== null && id !== pickFrom) {
			choosePathEnd(id);
			return;
		}
		session.select(id, mode);
	};

	const openMenu = (target: CanvasMenuTarget, at: { x: number; y: number }): void => {
		const box = canvasBox.current?.getBoundingClientRect();
		setToolMenu(null);
		setMenu({ target, x: at.x - (box?.left ?? 0), y: at.y - (box?.top ?? 0) });
	};
	const exportGraphJson = (): string => toJsonText({ nodes: nodes, relationships: [...state.model.relationships.values()] }, 2);
	/** Announce a copy; when the browser refused it, leave the text on screen to copy by hand. */
	const say = async (text: string, ok: boolean, fallback?: string): Promise<void> => {
		announce(ok ? text : 'Copying was not allowed by the browser.');
		setBlockedCopy(ok ? null : (fallback !== undefined && fallback.length <= MAX_COPY_CHARS ? fallback : null));
	};
	/** Copy exported text; one that is too large is not put on the clipboard (a huge string can freeze the page or be refused). */
	const copyExport = async (text: string, what: string, done: string): Promise<void> => {
		if (text.length > MAX_COPY_CHARS) {
			setBlockedCopy(null);
			announce(`Not copied: ${what} is too large for the clipboard (over ${MAX_COPY_CHARS.toLocaleString('en-US')} characters). Export where downloads are allowed.`);
			return;
		}
		await say(done, await copyText(text), text);
	};
	// A box left for copying by hand belongs to the drawing it came from.
	useEffect(() => {
		setBlockedCopy(null);
	}, [state.model]);

	const runExport = async (what: 'png' | 'svg' | 'json' | 'copy-svg' | 'copy-json'): Promise<void> => {
		try {
			await exportNow(what);
		} catch {
			announce('The image could not be made.');
		}
	};
	const exportNow = async (what: 'png' | 'svg' | 'json' | 'copy-svg' | 'copy-json'): Promise<void> => {
		if (what === 'json') {
			download(new Blob([exportGraphJson()], { type: 'application/json' }), 'graph.json');
			return;
		}
		if (what === 'copy-json') {
			{
				await copyExport(exportGraphJson(), 'the drawn graph as JSON', 'Copied the drawn graph as JSON.');
			}
			return;
		}
		const format = what === 'png' ? 'png' : 'svg';
		const canvas = handle.current;
		const outcome = canvas ? exportOutcome(await canvas.exportImage(format)) : { blob: null, reason: 'not-ready' as const };
		const blob = outcome.blob;
		if (blob === null) {
			announce(exportFailureText(outcome.reason ?? 'render-failed', format));
			return;
		}
		if (what === 'copy-svg') {
			await copyExport(await blob.text(), 'the SVG', 'Copied the SVG.');
		}
		else download(blob, `graph.${format}`);
	};

	/** What a menu item does. */
	const activate = (id: string): void => {
		if (menu) {
			const target = menu.target;
			const nodeId = target.kind === 'node' ? target.id : undefined;
			setMenu(null);
			restoreFocus(nodeId);
			if (target.kind === 'pane') {
				if (id === 'fit') handle.current?.fit();
				else if (id === 'relayout') handle.current?.relayout();
				else if (id === 'clear-selection') session.clearSelection();
				return;
			}
			if (target.kind === 'relationship') {
				const rel = state.model.relationships.get(target.id);
				if (id === 'inspect') {
					session.selectRelationship(target.id);
					setInspectToken((n) => n + 1);
				} else if (id === 'select-start' && rel) session.select(rel.start, 'only');
				else if (id === 'select-end' && rel) session.select(rel.end, 'only');
				else if (id === 'new-query') {
					const text = session.queryTextFor({ kind: 'relationship', id: target.id });
					if (text !== null && rel) onNewQuery?.(text, `From :${rel.type}`);
				}
				return;
			}
			const node = state.model.nodes.get(target.id);
			if (!node) return;
			if (id === 'expand') void session.expand(node.id);
			else if (id.startsWith('type:')) void session.expandByType(node.id, id.slice(5));
			else if (id === 'collapse') session.collapse(node.id);
			else if (id === 'dismiss') session.dismiss(node.id);
			else if (id === 'inspect') inspect(node.id);
			else if (id === 'find-path') startPath(node.id);
			else if (id === 'connect') void session.connect();
			else if (id === 'copy-caption') void copyText(captionFor(node)).then((ok) => say('Copied the caption.', ok));
			else if (id === 'copy-json') void copyText(inspectNode(node, captionFor(node)).json).then((ok) => say('Copied as JSON.', ok));
			else if (id === 'new-query') {
				const text = session.queryTextFor({ kind: 'node', id: node.id });
				if (text !== null) onNewQuery?.(text, `From ${captionFor(node)}`.slice(0, 40));
			}
			return;
		}
		const which = toolMenu;
		setToolMenu(null);
		if (which) restoreToolFocus(which);
		if (id.startsWith('tb:')) actions.find((a) => `tb:${a.id}` === id)?.run();
		else if (id === 'force' || id === 'tree' || id === 'left-right') setLayoutMode(id);
		else if (id === 'relayout') handle.current?.relayout();
		else if (id === 'keep-pinned') setKeepPinned(!keepPinned);
		else if (id === 'legend') setLegendOpen(!legendOpen);
		else if (id === 'keys') {
			setHelpOpen(!helpOpen);
			setHelpToken((n) => n + 1);
		} else if (id === 'fullscreen') onToggleMaximized?.();
		else if (id === 'png' || id === 'svg' || id === 'json' || id === 'copy-svg' || id === 'copy-json') void runExport(id);
	};

	const closeMenu = (restore: boolean): void => {
		if (menu) {
			const nodeId = menu.target.kind === 'node' ? menu.target.id : undefined;
			setMenu(null);
			if (restore) restoreFocus(nodeId);
		} else if (toolMenu) {
			const which = toolMenu;
			setToolMenu(null);
			if (restore) restoreToolFocus(which);
		}
	};

	// ---------------------------------------------------------------------
	// menu contents
	// ---------------------------------------------------------------------

	const menuItems = (() => {
		if (!menu) return null;
		const target = menu.target;
		const nodeTarget = target.kind === 'node' ? state.model.nodes.get(target.id) : undefined;
		const rel = target.kind === 'relationship' ? state.model.relationships.get(target.id) : undefined;
		const canQuery = !!onNewQuery && target.kind !== 'pane' && session.queryTextFor({ kind: target.kind, id: target.id }) !== null;
		return menuItemsFor(target, {
			busy,
			stale: state.stale,
			selectedCount: state.selected.size,
			nodeCount: state.model.nodes.size,
			canQuery,
			relationshipTypes: relationshipTypesFor(schema, nodeTarget?.labels ?? []),
			startDrawn: rel ? state.model.nodes.has(rel.start) : undefined,
			endDrawn: rel ? state.model.nodes.has(rel.end) : undefined,
		});
	})();

	const viewItems: IMenuItem[] = [
		{ id: 'force', label: 'Layout: Force', role: 'menuitemradio', checked: layoutMode === 'force' },
		{ id: 'tree', label: 'Layout: Tree (top down)', role: 'menuitemradio', checked: layoutMode === 'tree' },
		{ id: 'left-right', label: 'Layout: Left to right (paths)', role: 'menuitemradio', checked: layoutMode === 'left-right' },
		{ id: 'relayout', label: 'Re-run layout' },
		{ id: 'keep-pinned', label: 'Keep dragged nodes pinned', role: 'menuitemcheckbox', checked: keepPinned },
		{ id: 'legend', label: 'Legend and styles', role: 'menuitemcheckbox', checked: legendOpen, separatorBefore: true },
		{ id: 'keys', label: 'Keyboard shortcuts', hint: '?', role: 'menuitemcheckbox', checked: helpOpen },
		...(onToggleMaximized ? [{ id: 'fullscreen', label: maximized ? 'Exit full screen' : 'Full screen', hint: maximized ? 'Esc' : undefined, separatorBefore: true }] : []),
	];
	const loading = canvasReady ? {} : { disabled: true, reason: 'The graph is still loading; try again in a moment.' };
	const exportItems: IMenuItem[] =
		exportMode === 'copy'
			? [
					{ id: 'copy-svg', label: 'Copy SVG', ...loading },
					{ id: 'copy-json', label: 'Copy the drawn graph as JSON' },
					{ id: 'png', label: 'PNG image (needs a download; use Copy SVG)', disabled: true, reason: 'PNG needs a file download, which this host does not allow. Copy SVG instead.' },
				]
			: [
					{ id: 'png', label: 'PNG image', ...loading },
					{ id: 'svg', label: 'SVG image', ...loading },
					{ id: 'json', label: 'The drawn graph as JSON' },
				];

	// ---------------------------------------------------------------------
	// keys and pointer, as React handlers on this view's own elements
	// ---------------------------------------------------------------------

	const onRootKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.defaultPrevented) return;
		if (event.key === '/' && !isTyping(event.target)) {
			event.preventDefault();
			searchInput.current?.focus();
			searchInput.current?.select();
			return;
		}
		if (event.key === 'Escape' && pickFrom !== null) {
			event.preventDefault();
			setPickFrom(null);
		}
	};
	const onPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>): void => {
		if (menu === null && toolMenu === null) return;
		const el = event.target as HTMLElement;
		if (el.closest('[role="menu"]') || el.closest('[data-menu-trigger]')) return;
		setMenu(null);
		setToolMenu(null);
	};

	// ---------------------------------------------------------------------
	// search
	// ---------------------------------------------------------------------

	const stepSearch = (delta: 1 | -1): void => {
		if (!matches || matches.length === 0) return;
		const next = (at + delta + matches.length) % matches.length;
		setCurrent(next);
		handle.current?.centerOn(matches[next]);
	};
	const chooseMatch = (): void => {
		if (!matches || matches.length === 0) return;
		const id = matches[at];
		session.select(id, 'only');
		handle.current?.centerOn(id);
	};

	// ---------------------------------------------------------------------
	// render
	// ---------------------------------------------------------------------

	const target = state.inspect;
	const showInspector = target ? (target.kind === 'node' ? state.model.nodes.has(target.id) : state.model.relationships.has(target.id)) : state.path !== null;
	const selectedOnly = state.selected.size === 1 ? state.model.nodes.get([...state.selected][0]) : undefined;
	const pickNode = pickFrom !== null ? state.model.nodes.get(pickFrom) : undefined;
	const items = statusItems({
		stale: state.stale,
		notice: state.notice && state.notice !== expiredNotice ? state.notice : null,
		budget,
		layout: layoutStatus,
		selection: {
			count: state.selected.size,
			caption: selectedOnly ? captionFor(selectedOnly) : null,
			relationshipType: state.selectedRelationship !== null ? (state.model.relationships.get(state.selectedRelationship)?.type ?? null) : null,
		},
		picking: pickFrom !== null ? (pickNode ? captionFor(pickNode) : pickFrom) : null,
		progress: state.progress,
		path: state.path,
	});

	// -------------------------------------------------------------------
	// the toolbar: it never wraps, so what does not fit goes to "More"
	// -------------------------------------------------------------------

	interface IToolbarAction {
		id: string;
		label: string;
		title: string;
		disabled: boolean;
		keep: number;
		run(): void;
	}
	const actions: IToolbarAction[] = [
		{ id: 'expand', label: 'Expand', title: 'Fetch up to 100 new neighbours (E)', disabled: !focused || busy || focusedStale, keep: 90, run: () => focused && void session.expand(focused.id) },
		{ id: 'collapse', label: 'Collapse', title: 'Remove what hangs only from this node (C)', disabled: !focused, keep: 50, run: () => focused && session.collapse(focused.id) },
		{ id: 'dismiss', label: 'Dismiss', title: 'Remove this node from the canvas (Delete or Backspace)', disabled: !focused, keep: 40, run: () => focused && session.dismiss(focused.id) },
		{ id: 'inspect', label: 'Inspect', title: 'Open the inspector (Enter)', disabled: !focused, keep: 70, run: () => focused && inspect(focused.id) },
		{ id: 'connect', label: 'Connect nodes', title: 'Draw the relationships among the nodes on the canvas', disabled: busy || state.stale || state.model.nodes.size < 2, keep: 30, run: () => void session.connect() },
		{ id: 'path', label: 'Find path', title: 'Select two nodes with Space, then find a path (P)', disabled: busy || state.stale || state.selected.size !== 2, keep: 80, run: () => void session.findPath() },
		...(busy ? [{ id: 'stop', label: 'Stop waiting', title: STOP_WAITING_NOTE, disabled: false, keep: 100, run: () => session.stopWaiting() }] : []),
		...(hasMore ? [{ id: 'more-nodes', label: 'Show more nodes', title: 'Draw more of the result', disabled: false, keep: 10, run: () => session.showMore() }] : []),
		...(state.path ? [{ id: 'clear-path', label: 'Clear path', title: 'Stop showing the found path', disabled: false, keep: 85, run: () => { session.clearPath(); restoreFocus(); } }] : []),
		...(state.selected.size > 0 ? [{ id: 'clear', label: `Clear selection (${state.selected.size})`, title: 'Clear the selection', disabled: false, keep: 20, run: () => session.clearSelection() }] : []),
		{ id: 'fit', label: 'Fit', title: 'Fit to screen (F)', disabled: false, keep: 60, run: () => handle.current?.fit() },
	];
	const fixedEl = useRef<HTMLSpanElement | null>(null);
	const moreEl = useRef<HTMLSpanElement | null>(null);
	const slotEls = useRef(new Map<string, HTMLElement>());
	const widths = useRef(new Map<string, number>());
	const [hiddenIds, setHiddenIds] = useState<readonly string[]>([]);
	const [tick, setTick] = useState(0);
	// The row's width changes when a panel opens beside it; measuring is a ResizeObserver, not a document listener.
	useLayoutEffect(() => {
		const el = toolbar.current;
		if (!el || typeof ResizeObserver === 'undefined') return undefined;
		const observer = new ResizeObserver(() => setTick((n) => n + 1));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useLayoutEffect(() => {
		const el = toolbar.current;
		if (!el) return;
		for (const [id, node] of slotEls.current) if (node.isConnected && node.offsetWidth > 0) widths.current.set(id, node.offsetWidth);
		if (moreEl.current && moreEl.current.offsetWidth > 0) widths.current.set('__more', moreEl.current.offsetWidth);
		const box = getComputedStyle(el);
		const available = el.clientWidth - parseFloat(box.paddingLeft || '0') - parseFloat(box.paddingRight || '0');
		const slots: IToolbarSlot[] = [{ id: 'label', width: widths.current.get('label') ?? 150, keep: 0 }, ...actions.map((a) => ({ id: a.id, width: widths.current.get(a.id) ?? 90, keep: a.keep }))];
		const fit = fitToolbar(slots, { available, fixed: fixedEl.current?.offsetWidth ?? 0, gap: 6, moreWidth: widths.current.get('__more') ?? 70 });
		// Runs after every render on purpose (labels and counts change widths); it sets state only when the answer differs.
		setHiddenIds((before) => (before.join('\u0000') === fit.hidden.join('\u0000') ? before : fit.hidden));
	});
	void tick;
	const hiddenActions = actions.filter((a) => hiddenIds.includes(a.id));
	const moreItems: IMenuItem[] = hiddenActions.map((a) => ({ id: `tb:${a.id}`, label: a.label, ...(a.disabled ? { disabled: true, reason: a.title } : {}) }));
	/** One toolbar slot: measured by id, so its width is known even after it has moved to More. */
	const slotRef = (id: string) => (node: HTMLElement | null): void => {
		if (node) slotEls.current.set(id, node);
		else slotEls.current.delete(id);
	};

	if (state.model.nodes.size === 0) {
		// Still the status line: an out-of-date empty drawing must keep its Rerun.
		return (
			<div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
				<div style={{ flex: 1, minHeight: 0 }}>
					<EmptyState icon={<GraphIcon />} title="Nothing to draw" description="This result has no nodes. The Table tab lists every returned row." />
				</div>
				<GraphStatusLine items={items} meta={meta} onRerun={onRerun} />
			</div>
		);
	}

	/** The menu-button pattern: Down opens the menu on its first item, Up on its last (keys inside an open menu are the menu's). */
	const openFromKey = (event: React.KeyboardEvent<HTMLElement>, which: ToolMenu): void => {
		if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
		if ((event.target as HTMLElement).closest('[role="menu"]')) return;
		event.preventDefault();
		setMenu(null);
		setToolStart(event.key === 'ArrowUp' ? 'last' : 'first');
		setToolMenu(which);
	};

	const toolMenuTrigger = (which: ToolMenu, text: string, items: IMenuItem[]): ReactNode => (
		<span
			ref={(el) => {
				triggers.current[which] = el;
			}}
			style={styles.menuAnchor}
			data-menu-trigger=""
			onKeyDown={(event) => openFromKey(event, which)}
		>
			<Button variant="ghost" small ariaExpanded={toolMenu === which} onClick={() => { setMenu(null); setToolStart('first'); setToolMenu(toolMenu === which ? null : which); }}>{`${text} ▾`}</Button>
			{toolMenu === which && <CanvasMenu label={text} items={items} x={0} y={28} start={toolStart} onActivate={activate} onClose={closeMenu} />}
		</span>
	);

	return (
		<div style={styles.root} onKeyDown={onRootKeyDown} onPointerDownCapture={onPointerDownCapture}>
			<div style={styles.main}>
				<div
					ref={toolbar}
					style={styles.toolbar}
					role="toolbar"
					aria-label="Graph actions"
				>
					{!hiddenIds.includes('label') && (
						<span ref={slotRef('label')} style={styles.focused} title={focusedCaption ?? ''}>{focusedCaption ? `Focused: ${focusedCaption}` : 'No node focused'}</span>
					)}
					{actions.filter((a) => !hiddenIds.includes(a.id)).map((a) => (
						<span key={a.id} ref={slotRef(a.id)}>
							<Button variant="ghost" small disabled={a.disabled} title={a.title} onClick={a.run}>{a.label}</Button>
						</span>
					))}
					{hiddenActions.length > 0 && (
						<span
							ref={(el) => {
								moreEl.current = el;
								triggers.current.more = el;
							}}
							style={styles.menuAnchor}
							data-menu-trigger=""
							onKeyDown={(event) => openFromKey(event, 'more')}
						>
							<Button variant="ghost" small ariaExpanded={toolMenu === 'more'} title="More actions" onClick={() => { setMenu(null); setToolStart('first'); setToolMenu(toolMenu === 'more' ? null : 'more'); }}>More ▾</Button>
							{toolMenu === 'more' && <CanvasMenu label="More actions" items={moreItems} x={0} y={28} start={toolStart} onActivate={activate} onClose={closeMenu} />}
						</span>
					)}
					<span ref={fixedEl} style={styles.spacer}>
						<CanvasSearch
							inputRef={searchInput}
							value={query}
							onChange={(value) => {
								setQuery(value);
								setCurrent(0);
							}}
							count={matches === null ? null : matches.length}
							current={at}
							onStep={stepSearch}
							onChoose={chooseMatch}
							onLeave={() => restoreFocus()}
						/>
						{toolMenuTrigger('view', 'View', viewItems)}
						{toolMenuTrigger('export', 'Export', exportItems)}
						{maximized === true && onToggleMaximized && <Button variant="ghost" small pressed title="Exit full screen (Esc)" onClick={onToggleMaximized}>Exit full screen</Button>}
					</span>
				</div>

				<div ref={canvasBox} style={styles.canvas} onWheel={() => menu !== null && setMenu(null)}>
					<CanvasBoundary>
						<Suspense fallback={<EmptyState icon={<GraphIcon />} title="Loading the graph view" description="The canvas loads on first use." />}>
							<GraphCanvas
								model={state.model}
								colors={colors}
								captions={captions}
								selected={state.selected}
								focusedId={state.focusedId}
								staleIds={state.staleIds}
								staleRelationshipIds={state.staleRelationshipIds}
								allStale={state.stale}
								seedKey={seedKey}
								expandHint={state.hint}
								highlighted={state.highlight}
								selectedRelationshipId={state.selectedRelationship}
								matchIds={matchIds}
								path={state.path}
								onClearPath={() => session.clearPath()}
								looks={looks}
								typeColors={typeColors}
								layoutMode={layoutMode}
								keepPinned={keepPinned}
								handleRef={handle}
								onFocus={(id) => session.focus(id)}
								onInspect={inspect}
								onToggleSelect={(id) => nodeClick(id, 'toggle')}
								onNodeClick={nodeClick}
								onSelectRelationship={(id) => session.selectRelationship(id)}
								onContextMenu={openMenu}
								onExpand={(id) => void session.expand(id)}
								onCollapse={(id) => session.collapse(id)}
								onDismiss={(id) => session.dismiss(id)}
								onFindPath={() => void session.findPath()}
								onClearSelection={() => session.clearSelection()}
								onHelp={() => { setHelpOpen(true); setHelpToken((n) => n + 1); }}
								announce={announce}
								onLayoutStatus={setLayoutStatus}
							/>
						</Suspense>
					</CanvasBoundary>
					{menu && menuItems && (
						<CanvasMenu
							label={menu.target.kind === 'node' ? 'Node actions' : menu.target.kind === 'relationship' ? 'Relationship actions' : 'Canvas actions'}
							items={menuItems}
							x={menu.x}
							y={menu.y}
							bounds={canvasBox.current ? { width: canvasBox.current.clientWidth, height: canvasBox.current.clientHeight } : undefined}
							onActivate={activate}
							onClose={closeMenu}
						/>
					)}
				</div>

				<GraphStatusLine items={items} meta={meta} onRerun={onRerun} />
			</div>

			{(showInspector || helpOpen || legendOpen || blockedCopy !== null) && (
				<div style={styles.side}>
					{showInspector && <InspectorPanel state={state} session={session} captions={captions} announce={announce} onNewQuery={onNewQuery} onFindPathFrom={startPath} focusToken={inspectToken} schema={schema} onClosed={() => restoreFocus()} />}
					{blockedCopy !== null && (
						<section aria-label="Text to copy" style={{ padding: '8px 12px', borderTop: '1px solid var(--rr-border)' }}>
							<CopyBlocked text={blockedCopy} />
							<Button variant="ghost" small onClick={() => setBlockedCopy(null)}>Close</Button>
						</section>
					)}
					{legendOpen && (
						<LegendPanel
							labels={legend}
							types={typeLegend}
							colors={colors}
							style={style}
							captions={captions}
							nodes={nodes}
							onSelectLabel={(label) => {
								session.selectMany(nodeIdsOfLabel(state.model, label), 'only');
							}}
							onEdit={(edit) => env.userData.editStyle(key, edit)}
							privacyNote={env.userData.privacyNote}
						/>
					)}
					{helpOpen && <KeysPanel focusToken={helpToken} onClose={() => { setHelpOpen(false); restoreToolFocus('view'); }} />}
				</div>
			)}
		</div>
	);
};

export default GraphView;
