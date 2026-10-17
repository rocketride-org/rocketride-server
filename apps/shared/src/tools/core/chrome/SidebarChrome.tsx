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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// TOOLS/CORE/CHROME — the generic sidebar chrome (strip + tool bodies)
// =============================================================================
//
// What remains of the old fixed-mode SidebarView after Phase 5: a strip of
// TOOL TABS and a panel stack, knowing nothing about any particular tool.
// The host supplies:
//
//   - `items`: the builtin tools, each an id + icon + render() — their
//     bodies live in tools/<tool>/ (PipelinesSidebarPanel, …).
//   - `toolTabs`: the pinned MF dev tools + the Dev Tools catalog, exactly
//     the contract the hosts already wire.
//
// The strip is one ordered list of ALL of it (persisted tabOrder re-ranks),
// selection falls back to `fallbackId` when the requested id has no tab,
// every mounted body stays mounted (TabPanel display-hides), and selecting
// an MF tool tab REVEALS its open window, never creates one.
// =============================================================================

import React, { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { commonStyles } from 'shell';
import { BxGridAlt, BxTrash } from 'shell';
import { SidebarMenu, TabControl, TabPanel } from 'shell';
import type { ViewMenu } from 'shell';
import { CodiconExtensions } from '../../../components/icons/Codicon';
import { PANEL_HOVER_BG, panelStyles } from './panelStyles';
import type { SidebarMode, ToolTab, ToolTabsSidebar } from '../../../modules/sidebar/types';

// =============================================================================
// STYLES (chrome-only — panel vocabulary lives in panelStyles)
// =============================================================================

const S = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		height: '100vh',
		fontFamily: 'var(--rr-font-family, system-ui, sans-serif)',
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		overflow: 'hidden',
	} as CSSProperties,

	/** TabPanel stack wrapper: remaining column height; the top padding
	 *  separates the strip from whichever body renders beneath it. */
	panelStack: {
		flex: 1,
		minHeight: 0,
		paddingTop: 8,
		boxSizing: 'border-box' as const,
	} as CSSProperties,

	/** Tool tab glyph on the strip — a CSS MASK filled with currentColor so
	 *  it renders in the tab's own text color exactly like the icon tabs
	 *  (active/inactive shift included). */
	toolTabIcon: {
		width: 16,
		height: 16,
		display: 'block' as const,
		backgroundColor: 'currentColor',
		WebkitMaskSize: 'contain',
		maskSize: 'contain',
		WebkitMaskRepeat: 'no-repeat',
		maskRepeat: 'no-repeat',
		WebkitMaskPosition: 'center',
		maskPosition: 'center',
	} as CSSProperties,

	/** MF tool panel header — icon chip + name/version. */
	toolHeader: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '10px 12px 6px',
	} as CSSProperties,
	toolIcon: {
		width: 28,
		height: 28,
		flexShrink: 0,
		borderRadius: 6,
		objectFit: 'contain' as const,
	} as CSSProperties,

	/** Modules-list row (the Dev Tools catalog) — two-line extensions-style. */
	storeRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '6px 10px',
		borderRadius: 5,
		cursor: 'pointer',
		userSelect: 'none' as const,
	} as CSSProperties,
	storeRowIcon: {
		width: 26,
		height: 26,
		flexShrink: 0,
		objectFit: 'contain' as const,
	} as CSSProperties,
	storeInstalled: {
		flexShrink: 0,
		fontSize: 10,
		fontWeight: 600,
		padding: '1px 7px',
		borderRadius: 8,
		border: '1px solid var(--rr-border)',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// TOOL STORE PANEL — the modules list behind the strip's Dev Tools tab
// =============================================================================

/**
 * The dev-tool catalog, VS Code extensions-view style: one row per available
 * tool (icon, name, version, description, Installed marker). Clicking a row
 * opens the tool's details page via `onShowTool`.
 */
const ToolStorePanel: React.FC<{ available: ToolTab[]; installedIds: Set<string>; onShowTool: (id: string) => void }> = ({ available, installedIds, onShowTool }) => {
	const [hovered, setHovered] = useState<string | null>(null);
	return (
		<div style={panelStyles.panelColumn}>
			<div style={panelStyles.sectionLabel}>Dev Tools</div>
			<div style={panelStyles.sectionList}>
				{available.length === 0 && (
					<div style={panelStyles.emptyLine}>No dev tools are published on this server.</div>
				)}
				{available.map((t) => (
					<div
						key={t.id}
						style={{ ...S.storeRow, ...(hovered === t.id ? { background: PANEL_HOVER_BG } : {}) }}
						onMouseEnter={() => setHovered(t.id)}
						onMouseLeave={() => setHovered(null)}
						onClick={() => onShowTool(t.id)}
					>
						{t.iconUrl ? <img src={t.iconUrl} alt="" style={S.storeRowIcon} /> : <div style={S.storeRowIcon} />}
						<div style={{ flex: 1, minWidth: 0 }}>
							<div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
								<span style={{ fontWeight: 600, ...commonStyles.textEllipsis }}>{t.name}</span>
								{t.version && <span style={{ fontSize: 10, color: 'var(--rr-text-secondary)', flexShrink: 0 }}>{t.version}</span>}
							</div>
							{t.description && (
								<div style={{ fontSize: 11, color: 'var(--rr-text-secondary)', ...commonStyles.textEllipsis }}>{t.description}</div>
							)}
						</div>
						{installedIds.has(t.id) && <span style={S.storeInstalled}>Installed</span>}
					</div>
				))}
			</div>
		</div>
	);
};

// =============================================================================
// TOOL PANEL — the built-in body behind a pinned MF tool's tab
// =============================================================================

/**
 * Default panel for an MF dev-tool tab: icon, name, version, and the Open /
 * Remove rows. Hosts replace it via `toolTabs.renderToolPanel` once they
 * mount the tool's own devToolSidebar here — exported so their mount
 * components can fall back to it for tools without a devToolSidebar.
 */
export const ToolPanel: React.FC<{ tool: ToolTab; onOpen: (id: string) => void; onRemove: (id: string) => void }> = ({ tool, onOpen, onRemove }) => {
	const navMenu: ViewMenu = {
		entries: [
			{ id: 'open', label: `Open ${tool.name}`, icon: <BxGridAlt size={16} /> },
			{ id: 'remove', label: 'Remove from tools', icon: <BxTrash size={16} /> },
		],
	};
	return (
		<div style={panelStyles.panelColumn}>
			<div style={S.toolHeader}>
				{tool.iconUrl && <img src={tool.iconUrl} alt="" style={S.toolIcon} />}
				<div style={{ minWidth: 0 }}>
					<div style={{ fontWeight: 600, ...commonStyles.textEllipsis }}>{tool.name}</div>
					{tool.version && <div style={{ fontSize: 11, color: 'var(--rr-text-secondary)' }}>{tool.version}</div>}
				</div>
			</div>
			<div style={panelStyles.navSection}>
				<SidebarMenu
					menu={navMenu}
					activeId=""
					onSelect={(id) => {
						if (id === 'open') onOpen(tool.id);
						if (id === 'remove') onRemove(tool.id);
					}}
				/>
			</div>
		</div>
	);
};

// =============================================================================
// CHROME
// =============================================================================

/** One builtin tool on the strip: a tab plus the body that renders for it. */
export interface SidebarToolItem {
	/** Tab id (also the SidebarMode value for this tool). */
	id: string;
	/** Tab tooltip. */
	label: string;
	/** Tab glyph (text label renders when absent). */
	icon?: ReactNode;
	/** The tool's sidebar body. */
	render: () => ReactNode;
}

/** Props for {@link SidebarChrome}. */
export interface ISidebarChromeProps {
	/** The builtin tools, in default strip order. */
	items: SidebarToolItem[];
	/** Host-injected nav above the strip (e.g. a Home button). */
	headerSlot?: ReactNode;
	/** Footer (connection status etc.). */
	footerSlot?: ReactNode;
	/** Force the strip visible (hosts with one item but future tabs). */
	showModeStrip?: boolean;
	/** Hide the strip — the hosting chrome (workbench rail) owns selection.
	 *  Selection handling still works; only the strip's pixels go. */
	hideModeStrip?: boolean;
	/** The selected tab id. */
	sidebarMode?: SidebarMode;
	/** Selection change (host persists). */
	onSidebarModeChange?: (mode: SidebarMode) => void;
	/** The id selection falls back to when the requested tab has no entry
	 *  (defaults to the first item). */
	fallbackId?: string;
	/** Pinned MF dev tools + the catalog (adds their tabs + the store tab). */
	toolTabs?: ToolTabsSidebar;
	/** Persisted strip order (re-ranks the default sequence). */
	tabOrder?: string[];
	/** Wire to make every tab draggable; receives the full ordered id list. */
	onReorderTabs?: (orderedIds: string[]) => void;
}

/**
 * The generic sidebar chrome: one ordered strip of builtin-tool tabs, MF
 * dev-tool tabs, and the Dev Tools catalog tab, over a keep-mounted panel
 * stack. Knows nothing about what any tool renders.
 */
export const SidebarChrome: React.FC<ISidebarChromeProps> = ({ items, headerSlot, footerSlot, showModeStrip = false, hideModeStrip = false, sidebarMode, onSidebarModeChange, fallbackId, toolTabs, tabOrder, onReorderTabs }) => {
	const tools = toolTabs?.tools ?? [];
	const reorderable = Boolean(onReorderTabs);
	const tabsVisible = !hideModeStrip && (items.length > 1 || Boolean(toolTabs) || showModeStrip);

	// The default sequence: builtin items, then pinned MF tools (icon-only —
	// a tab exists once its icon is in hand), then the Dev Tools catalog.
	const baseEntries = [
		...items.map((item) => ({ id: item.id, label: item.label, ...(item.icon !== undefined && item.icon !== null ? { icon: item.icon } : {}), draggable: reorderable })),
		...tools.filter((t) => t.iconUrl).map((t) => ({
			id: `tool:${t.id}`,
			label: t.name,
			icon: <span style={{ ...S.toolTabIcon, WebkitMaskImage: `url(${t.iconUrl})`, maskImage: `url(${t.iconUrl})` }} />,
			draggable: reorderable,
		})),
		...(toolTabs ? [{ id: 'toolStore', label: 'Dev Tools', icon: <CodiconExtensions size={16} />, draggable: reorderable }] : []),
	];
	const rank = new Map((tabOrder ?? []).map((id, i) => [id, i]));
	const modeMenu: ViewMenu = {
		entries: baseEntries
			.map((entry, baseIndex) => ({ entry, baseIndex }))
			.sort((a, b) => {
				const ra = rank.get(a.entry.id);
				const rb = rank.get(b.entry.id);
				if (ra !== undefined && rb !== undefined) return ra - rb;
				if (ra !== undefined) return -1;
				if (rb !== undefined) return 1;
				return a.baseIndex - b.baseIndex;
			})
			.map(({ entry }) => entry),
	};

	// A requested mode is honored only when its tab exists — membership in
	// the menu IS the wiredness check; anything else falls back.
	const fallback = fallbackId ?? items[0]?.id ?? 'toolStore';
	const mode = sidebarMode !== undefined && modeMenu.entries.some((e) => e.id === sidebarMode) ? sidebarMode : fallback;

	return (
		<div style={S.container}>
			{/* ── Host-injected nav above the strip ─────────────────────── */}
			{headerSlot != null && <div style={panelStyles.navSection}>{headerSlot}</div>}

			{/* ── The strip ─────────────────────────────────────────────── */}
			{tabsVisible && (
				<TabControl
					menu={modeMenu}
					iconsOnly
					activeId={mode}
					onSelect={(id) => {
						// Membership in the menu is the validity check. Selecting
						// an MF tool tab brings an already-open window forward
						// (never creates one); hosts without the distinction fall
						// back to open-or-focus.
						if (!modeMenu.entries.some((e) => e.id === id)) return;
						onSidebarModeChange?.(id as SidebarMode);
						if (id.startsWith('tool:')) (toolTabs?.onFocusTool ?? toolTabs?.onOpenTool)?.(id.slice('tool:'.length));
					}}
					onReorder={onReorderTabs ? (dragId, targetId, position) => {
						// Rebuild the DISPLAYED order with the dragged tab beside
						// the target; the host persists the full id list.
						const order = modeMenu.entries.map((e) => e.id).filter((id) => id !== dragId);
						const at = order.indexOf(targetId);
						if (at < 0) return;
						order.splice(position === 'before' ? at : at + 1, 0, dragId);
						onReorderTabs(order);
					} : undefined}
				/>
			)}

			{/* ── Tool bodies — keep-mounted so per-tool state survives
			    switches (Explorer scroll, list positions, mounted MF UIs) */}
			<div style={S.panelStack}>
				<TabPanel
					activeId={mode}
					panels={{
						...Object.fromEntries(items.map((item) => [item.id, { content: item.render() }])),
						...(toolTabs
							? {
								toolStore: { content: <ToolStorePanel available={toolTabs.available} installedIds={new Set(tools.map((t) => t.id))} onShowTool={toolTabs.onShowTool} /> },
								...Object.fromEntries(tools.map((t) => [
									`tool:${t.id}`,
									{ content: toolTabs.renderToolPanel?.(t.id) ?? <ToolPanel tool={t} onOpen={toolTabs.onOpenTool} onRemove={toolTabs.onRemoveTool} /> },
								])),
							}
							: {}),
					}}
				/>
			</div>

			{/* ── Footer slot ───────────────────────────────────────────── */}
			{footerSlot}
		</div>
	);
};

export default SidebarChrome;
