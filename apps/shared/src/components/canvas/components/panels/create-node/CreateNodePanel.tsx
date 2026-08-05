// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * CreateNodePanel — the "Add Node" catalog, a MODELESS DetailPanel drawer.
 *
 * Ported onto the record-panel standard: the chrome (EntityHeader, close glyph,
 * left-edge resize handle, slide-in) is the stock {@link DetailPanel}; this file
 * supplies only the body — a pinned search box over collapsible provider
 * categories. It renders `modeless` + `contained`: no dim backdrop and the
 * overlay passes pointer / drag events THROUGH to the ReactFlow canvas behind
 * it, so BOTH add gestures keep working while the drawer is open —
 *   - click a catalog item  -> adds the node at viewport centre;
 *   - drag a catalog item onto the canvas -> the graph's own onDrop places it.
 *
 * `contained` anchors the drawer to the canvas surface (the record-owning
 * surface), so it dims/clips to the graph area rather than the whole page.
 */

import { ReactElement, useMemo, useState, useEffect, useRef, CSSProperties } from 'react';
import { Search, Plus, List, LayoutGrid } from 'lucide-react';

import { useFlowGraph } from '../../../context/FlowGraphContext';
import { useFlowProject } from '../../../context/FlowProjectContext';
import { usePrefs } from 'shell';
import { IService, IServiceCapabilities } from '../../../types';
import { Icon } from '../../../util/Icon';
import { DetailPanel } from 'shell';
import { commonStyles } from 'shell';
import { CATEGORY_TITLES } from './categoryTitles';

// =============================================================================
// Constants
// =============================================================================

/** Default drawer width when the workspace has no saved width yet — fairly wide
 * so the default icon grid shows several columns. A saved width overrides it. */
const PANEL_WIDTH = 440;

/** Slim resize floor — a node list reads fine narrow, below the 380 record floor. */
const PANEL_MIN_WIDTH = 240;

/** Workspace-preference key the drawer width is remembered under. */
const WIDTH_PERSIST_KEY = 'panelDetailAddNodeWidth';

/** Workspace-preference key the list/icon view mode is remembered under. */
const VIEW_MODE_PERSIST_KEY = 'panelDetailAddNodeViewMode';

/** Catalog display modes: a vertical list, or an Explorer-style icon grid. */
type ViewMode = 'list' | 'icon';

// =============================================================================
// Styles — all use --rr-* variables for theme adaptation
// =============================================================================

const styles = {
	// Plus-glyph avatar filling the DetailPanel's 42px round slot.
	avatar: {
		width: '100%',
		height: '100%',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		background: 'color-mix(in srgb, var(--rr-brand) 16%, transparent)',
		color: 'var(--rr-brand)',
	} as CSSProperties,

	// Fixed search header: stays put while the categories scroll in their OWN
	// region below it (not underneath a sticky element) — see bodyFill/scrollArea.
	searchWrap: {
		flexShrink: 0,
		background: 'var(--rr-bg-default)',
		paddingBottom: 8,
	} as CSSProperties,

	// Fills the DetailPanel's scrolling body so the search is a fixed header and
	// the category list owns a separate scroll region beneath it.
	bodyFill: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
	} as CSSProperties,

	// Category scroll region below the fixed search. Negative side margins (with
	// matching padding) reclaim the DetailPanel body's 20px gutters so the
	// scrollbar sits at the panel edge while content stays aligned with the search.
	scrollArea: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
		marginLeft: -20,
		marginRight: -20,
		paddingLeft: 20,
		paddingRight: 20,
	} as CSSProperties,

	searchRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
	} as CSSProperties,

	// Relative wrapper so the search glyph anchors to the input while the input
	// flexes to leave room for the view-mode toggle on the right.
	searchInputWrap: {
		position: 'relative',
		display: 'flex',
		alignItems: 'center',
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	searchIcon: {
		position: 'absolute',
		left: 9,
		display: 'flex',
		color: 'var(--rr-text-disabled)',
		pointerEvents: 'none',
	} as CSSProperties,

	searchInput: {
		...commonStyles.inputField,
		paddingLeft: 30,
	} as CSSProperties,

	// View-mode toggle: a small two-button segmented control (list / icon).
	viewToggle: {
		display: 'flex',
		flexShrink: 0,
		border: '1px solid var(--rr-border)',
		borderRadius: 5,
		overflow: 'hidden',
	} as CSSProperties,

	// One toggle button; the active mode fills with the theme highlight.
	viewToggleBtn: (active: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 26,
		height: 26,
		padding: 0,
		border: 'none',
		cursor: 'pointer',
		background: active ? 'var(--rr-bg-list-active)' : 'transparent',
		color: active ? 'var(--rr-fg-list-active)' : 'var(--rr-text-secondary)',
	}),

	// Icon (Explorer-style) grid for a category's nodes, replacing the list rows
	// when icon mode is on: equal auto-filled columns of centered icon+label tiles.
	iconGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))',
		gap: 2,
		padding: '2px 4px 6px 22px',
	} as CSSProperties,

	iconTile: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		gap: 5,
		padding: '8px 4px',
		cursor: 'pointer',
		borderRadius: 5,
		textAlign: 'center',
	} as CSSProperties,

	iconTileIcon: {
		width: 28,
		height: 28,
		flexShrink: 0,
	} as CSSProperties,

	iconTileTitle: {
		fontSize: 10,
		lineHeight: '13px',
		color: 'var(--rr-text-primary)',
		// Clamp to two lines so long node names wrap rather than overflow the tile.
		display: '-webkit-box',
		WebkitLineClamp: 2,
		WebkitBoxOrient: 'vertical',
		overflow: 'hidden',
		wordBreak: 'break-word',
	} as CSSProperties,

	// Experimental pill for an icon tile: the same yellow as the list badge,
	// centered beneath the label (no left margin).
	iconTileExperimental: {
		fontSize: '9px',
		padding: '1px 4px',
		borderRadius: '3px',
		backgroundColor: 'var(--rr-color-warning)',
		color: 'var(--rr-fg-button)',
		lineHeight: '14px',
	} as CSSProperties,

	sectionHeader: {
		...commonStyles.labelUppercase,
		display: 'flex',
		alignItems: 'center',
		height: '26px',
		padding: '0 4px',
		cursor: 'pointer',
		userSelect: 'none' as const,
		fontWeight: 700,
	} as CSSProperties,

	chevron: {
		width: '16px',
		height: '16px',
		marginRight: '2px',
		flexShrink: 0,
		transition: 'transform 0.15s',
	} as CSSProperties,

	item: {
		display: 'flex',
		alignItems: 'center',
		height: '26px',
		padding: '0 8px 0 26px',
		cursor: 'pointer',
		gap: '6px',
		borderRadius: 5,
	} as CSSProperties,

	itemIcon: {
		width: '16px',
		height: '16px',
		flexShrink: 0,
	} as CSSProperties,

	itemTitle: commonStyles.textEllipsis,

	badge: {
		fontSize: '9px',
		padding: '1px 4px',
		borderRadius: '3px',
		backgroundColor: 'var(--rr-border)',
		color: 'var(--rr-text-secondary)',
		marginLeft: '4px',
		flexShrink: 0,
		lineHeight: '14px',
	} as CSSProperties,

	experimentalBadge: {
		fontSize: '9px',
		padding: '1px 4px',
		borderRadius: '3px',
		backgroundColor: 'var(--rr-color-warning)',
		color: 'var(--rr-fg-button)',
		marginLeft: '4px',
		flexShrink: 0,
		lineHeight: '14px',
	} as CSSProperties,

	empty: {
		padding: '16px',
		textAlign: 'center' as const,
		color: 'var(--rr-text-disabled)',
	} as CSSProperties,
};

// =============================================================================
// Chevron SVG (matches VS Code's codicon chevron)
// =============================================================================

/**
 * Right-pointing disclosure chevron that rotates to point down when expanded.
 *
 * @param expanded - Whether the owning category is open.
 * @returns The chevron SVG.
 */
function ChevronIcon({ expanded }: { expanded: boolean }): ReactElement {
	return (
		<svg
			viewBox="0 0 16 16"
			style={{
				...styles.chevron,
				transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
			}}
			fill="currentColor"
		>
			<path d="M5.7 13.7L5 13l4.6-4.6L5 3.7l.7-.7 5.3 5.3-5.3 5.4z" />
		</svg>
	);
}

// =============================================================================
// Props
// =============================================================================

/** Props for {@link CreateNodePanel}. */
interface ICreateNodePanelProps {
	/** Close the drawer. */
	onClose: () => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the Add Node catalog drawer.
 *
 * @param props - {@link ICreateNodePanelProps}.
 * @returns The DetailPanel drawer element.
 */
export default function CreateNodePanel({ onClose }: ICreateNodePanelProps): ReactElement {
	const { inventory } = useFlowProject();
	const { addNode, setTempNode } = useFlowGraph();
	// The one shared prefs accessor: drives the list/icon view-mode persistence
	// below (the drawer width rides the same store via DetailPanel's persistKey).
	const { getPref, setPref } = usePrefs();

	const [search, setSearch] = useState('');
	// Track which groups are expanded. Only "source" is open by default.
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set(['source']));
	const savedExpandedGroups = useRef<Set<string> | null>(null);

	// List vs icon catalog display, seeded from the persisted workspace preference.
	// Default is the icon grid until the user explicitly picks the list.
	const [viewMode, setViewMode] = useState<ViewMode>(() => (getPref(VIEW_MODE_PERSIST_KEY) === 'list' ? 'list' : 'icon'));

	/**
	 * Switch the catalog display mode and remember it in the workspace file, so
	 * the choice rides the workspace like the drawer width does.
	 *
	 * @param mode - The view mode to apply.
	 */
	const applyViewMode = (mode: ViewMode): void => {
		setViewMode(mode);
		setPref(VIEW_MODE_PERSIST_KEY, mode);
	};

	// --- Group toggle -------------------------------------------------------

	/**
	 * Toggle one category open/closed.
	 *
	 * @param key - The category key to toggle.
	 */
	const toggleGroup = (key: string): void => {
		setExpandedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	// --- Inventory grouping + filtering -------------------------------------

	const groupedInventory = useMemo(() => {
		const catalog = (inventory ?? {}) as Record<string, Record<string, IService>>;
		const groups: Record<string, { key: string; service: IService }[]> = {};

		// Collect provider keys that appear in non-tool categories
		const nonToolKeys = new Set<string>();
		for (const [groupKey, groupServices] of Object.entries(catalog)) {
			if (groupKey === 'tool') continue;
			for (const providerKey of Object.keys(groupServices as Record<string, IService>)) {
				nonToolKeys.add(providerKey);
			}
		}

		for (const [groupKey, groupServices] of Object.entries(catalog)) {
			const items: { key: string; service: IService }[] = [];
			for (const [providerKey, service] of Object.entries(groupServices as Record<string, IService>)) {
				// For the tool category, only include items that don't appear in any other category
				if (groupKey === 'tool' && nonToolKeys.has(providerKey)) continue;

				const title = (service.title ?? '').toLowerCase();
				if (search && !title.includes(search.toLowerCase())) continue;

				const isDeprecated = service.capabilities && (IServiceCapabilities.Deprecated & service.capabilities) === IServiceCapabilities.Deprecated;
				if (isDeprecated) continue;

				items.push({ key: providerKey, service });
			}
			if (items.length > 0) groups[groupKey] = items;
		}

		// Sort keys: "source" first, then alphabetical by display title
		const sortedKeys = Object.keys(groups).sort((a, b) => {
			if (a === 'source') return -1;
			if (b === 'source') return 1;
			const titleA = (CATEGORY_TITLES[a] ?? a).toLowerCase();
			const titleB = (CATEGORY_TITLES[b] ?? b).toLowerCase();
			return titleA.localeCompare(titleB);
		});

		const sorted: Record<string, { key: string; service: IService }[]> = {};
		for (const key of sortedKeys) sorted[key] = groups[key];
		return sorted;
	}, [inventory, search]);

	// Auto-expand all matching categories while searching; restore on clear
	useEffect(() => {
		if (search) {
			if (!savedExpandedGroups.current) {
				savedExpandedGroups.current = new Set(expandedGroups);
			}
			setExpandedGroups(new Set(Object.keys(groupedInventory)));
		} else if (savedExpandedGroups.current) {
			setExpandedGroups(savedExpandedGroups.current);
			savedExpandedGroups.current = null;
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [search, groupedInventory]);

	// --- Add gestures -------------------------------------------------------

	/**
	 * Click-to-add: drop a fresh node of this provider at the viewport centre.
	 *
	 * @param providerKey - The provider to instantiate.
	 */
	const onClickItem = (providerKey: string): void => {
		addNode({
			provider: providerKey,
			name: '',
			description: '',
			config: {},
			input: [],
			control: [],
		});
	};

	/**
	 * Drag-to-add: stage the temp node; the graph's own onDrop (which the
	 * modeless overlay lets events reach) places it at the drop position.
	 *
	 * @param e - The dragstart event.
	 * @param providerKey - The provider to instantiate.
	 */
	const onDragStart = (e: React.DragEvent, providerKey: string): void => {
		setTempNode({
			provider: providerKey,
			name: '',
			description: '',
			config: {},
			input: [],
			control: [],
		});
		e.dataTransfer.effectAllowed = 'move';
	};

	// --- Render -------------------------------------------------------------

	return (
		<DetailPanel
			open
			contained
			modeless
			onClose={onClose}
			title="Add Node"
			subtitle="Click to add, or drag onto the canvas"
			avatar={
				<div style={styles.avatar}>
					<Plus size={20} />
				</div>
			}
			width={PANEL_WIDTH}
			minWidth={PANEL_MIN_WIDTH}
			persistKey={WIDTH_PERSIST_KEY}
		>
			{/* Pinned search + view-mode toggle — sticks to the top of the body. */}
			<div style={styles.bodyFill}>
				<div style={styles.searchWrap}>
					<div style={styles.searchRow}>
						<div style={styles.searchInputWrap}>
							<span style={styles.searchIcon}>
								<Search size={14} />
							</span>
							<input style={styles.searchInput} placeholder="Search nodes..." value={search} onChange={(e) => setSearch(e.target.value)} data-rr-autofocus="true" aria-label="Search nodes" />
						</div>
						{/* Button 1: list view · Button 2: icon (Explorer-style) view. */}
						<div style={styles.viewToggle} role="group" aria-label="Catalog view mode">
							<button type="button" style={styles.viewToggleBtn(viewMode === 'list')} onClick={() => applyViewMode('list')} title="List view" aria-label="List view" aria-pressed={viewMode === 'list'}>
								<List size={14} />
							</button>
							<button type="button" style={styles.viewToggleBtn(viewMode === 'icon')} onClick={() => applyViewMode('icon')} title="Icon view" aria-label="Icon view" aria-pressed={viewMode === 'icon'}>
								<LayoutGrid size={14} />
							</button>
						</div>
					</div>
				</div>

				<div style={styles.scrollArea}>
					{/* Collapsible provider categories. */}
					{Object.entries(groupedInventory).map(([groupKey, items]) => {
						const expanded = expandedGroups.has(groupKey);
						return (
							<div key={groupKey}>
								{/* Section header — keyboard-operable (Enter/Space expand). */}
								<div
									style={styles.sectionHeader}
									role="button"
									tabIndex={0}
									aria-expanded={expanded}
									onClick={() => toggleGroup(groupKey)}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											toggleGroup(groupKey);
										}
									}}
								>
									<ChevronIcon expanded={expanded} />
									<span>{CATEGORY_TITLES[groupKey] ?? groupKey}</span>
								</div>

								{/* Items — vertical list rows, or an Explorer-style icon grid. */}
								{expanded &&
									(viewMode === 'icon' ? (
										<div style={styles.iconGrid}>
											{items.map(({ key, service }) => (
												<div
													key={key}
													draggable
													role="button"
													tabIndex={0}
													onDragStart={(e) => onDragStart(e, key)}
													onClick={() => onClickItem(key)}
													onKeyDown={(e) => {
														if (e.key === 'Enter' || e.key === ' ') {
															e.preventDefault();
															onClickItem(key);
														}
													}}
													style={styles.iconTile}
													title={service.title ?? key}
													onMouseEnter={(e) => {
														(e.currentTarget as HTMLElement).style.backgroundColor = 'var(--rr-bg-list-hover)';
													}}
													onMouseLeave={(e) => {
														(e.currentTarget as HTMLElement).style.backgroundColor = '';
													}}
												>
													{service.icon && <Icon name={service.icon} width={28} height={28} style={styles.iconTileIcon} />}
													<span style={styles.iconTileTitle}>{service.title ?? key}</span>
													{!!(service.capabilities && IServiceCapabilities.Experimental & service.capabilities) && <span style={styles.iconTileExperimental}>Experimental</span>}
												</div>
											))}
										</div>
									) : (
										items.map(({ key, service }) => (
											<div
												key={key}
												draggable
												role="button"
												tabIndex={0}
												onDragStart={(e) => onDragStart(e, key)}
												onClick={() => onClickItem(key)}
												onKeyDown={(e) => {
													if (e.key === 'Enter' || e.key === ' ') {
														e.preventDefault();
														onClickItem(key);
													}
												}}
												style={styles.item}
												onMouseEnter={(e) => {
													(e.currentTarget as HTMLElement).style.backgroundColor = 'var(--rr-bg-list-hover)';
												}}
												onMouseLeave={(e) => {
													(e.currentTarget as HTMLElement).style.backgroundColor = '';
												}}
											>
												{service.icon && <Icon name={service.icon} width="16px" height="16px" style={styles.itemIcon} />}
												<span style={styles.itemTitle}>{service.title ?? key}</span>
												{Array.isArray(service.classType) && service.classType.includes('tool') && <span style={styles.badge}>Tool</span>}
												{!!(service.capabilities && IServiceCapabilities.Experimental & service.capabilities) && <span style={styles.experimentalBadge}>Experimental</span>}
											</div>
										))
									))}
							</div>
						);
					})}

					{Object.keys(groupedInventory).length === 0 && <div style={styles.empty}>{search ? 'No matching nodes' : 'No nodes available'}</div>}
				</div>
			</div>
		</DetailPanel>
	);
}
