// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * CreateNodePanel — Side panel for adding pipeline nodes to the canvas.
 *
 * Styled to match VS Code's Explorer panel using plain HTML + CSS.
 * No MUI components — avoids theme color overrides.
 *
 * Features:
 *   - Collapsible category sections with chevrons on the left
 *   - Text search to filter by title
 *   - Click-to-add at viewport center
 *   - Drag-to-add at drop position
 *   - Resizable via pill-shaped drag handle on the left border
 */

import { ReactElement, useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { TextField, InputAdornment } from '@mui/material';
import { Search } from 'lucide-react';

import { useFlowGraph } from '../../../context/FlowGraphContext';
import { useFlowProject } from '../../../context/FlowProjectContext';
import { IService, IServiceCapabilities } from '../../../types';

// =============================================================================
// Constants
// =============================================================================

const CATEGORY_TITLES: Record<string, string> = {
	source: 'Source',
	embedding: 'Embedding',
	llm: 'LLM',
	database: 'Database',
	filter: 'Filter',
	image: 'Image',
	preprocessor: 'Preprocessor',
	store: 'Store',
	agent: 'Agent',
	tool: 'Tool',
	other: 'Other',
};

const MIN_WIDTH = 200;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 260;

// =============================================================================
// Styles — all use --rr-* variables for theme adaptation
// =============================================================================

const styles = {
	container: {
		position: 'absolute' as const,
		right: 0,
		top: 0,
		bottom: 0,
		display: 'flex',
		zIndex: 20,
	},
	resizeHandle: {
		position: 'absolute' as const,
		left: 0,
		top: '50%',
		transform: 'translate(-50%, -50%)',
		width: '8px',
		height: '56px',
		borderRadius: '9999px',
		backgroundColor: 'var(--rr-border)',
		cursor: 'col-resize',
		zIndex: 1,
	},
	panel: {
		position: 'relative' as const,
		flex: 1,
		display: 'flex',
		flexDirection: 'column' as const,
		overflow: 'hidden',
		backgroundColor: 'var(--rr-bg-widget)',
		color: 'var(--rr-fg-widget)',
		fontFamily: 'var(--rr-font-family-widget)',
		fontSize: 'var(--rr-font-size-widget)',
	},
	header: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		height: '36px',
		padding: '0 8px 0 12px',
		backgroundColor: 'var(--rr-bg-widget-header)',
	},
	headerTitle: {
		fontWeight: 700,
		textTransform: 'uppercase' as const,
		letterSpacing: '0.5px',
		fontSize: '11px',
	},
	closeButton: {
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		color: 'inherit',
		padding: '4px',
		display: 'flex',
		alignItems: 'center',
		borderRadius: '4px',
	},
	searchBox: {
		padding: '6px 8px',
	},
	searchInput: {
		width: '100%',
		height: '24px',
		padding: '0 8px',
		border: '1px solid var(--rr-border)',
		borderRadius: '2px',
		backgroundColor: 'var(--rr-bg-widget)',
		color: 'inherit',
		fontFamily: 'inherit',
		fontSize: 'inherit',
		outline: 'none',
		boxSizing: 'border-box' as const,
	},
	scrollArea: {
		flex: 1,
		overflowY: 'auto' as const,
		minHeight: 0,
	},
	sectionHeader: {
		display: 'flex',
		alignItems: 'center',
		height: '22px',
		padding: '0 8px 0 4px',
		cursor: 'pointer',
		userSelect: 'none' as const,
		fontWeight: 700,
		fontSize: '11px',
		textTransform: 'uppercase' as const,
		letterSpacing: '0.5px',
	},
	chevron: {
		width: '16px',
		height: '16px',
		marginRight: '2px',
		flexShrink: 0,
		transition: 'transform 0.15s',
	},
	item: {
		display: 'flex',
		alignItems: 'center',
		height: '22px',
		padding: '0 8px 0 28px',
		cursor: 'pointer',
		gap: '6px',
	},
	itemIcon: {
		width: '16px',
		height: '16px',
		flexShrink: 0,
	},
	itemTitle: {
		whiteSpace: 'nowrap' as const,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
	badge: {
		fontSize: '9px',
		padding: '1px 4px',
		borderRadius: '3px',
		backgroundColor: 'var(--rr-border)',
		color: 'var(--rr-fg-widget)',
		marginLeft: '4px',
		flexShrink: 0,
		lineHeight: '14px',
	},
	experimentalBadge: {
		fontSize: '9px',
		padding: '1px 4px',
		borderRadius: '3px',
		backgroundColor: 'var(--rr-color-warning)',
		color: 'var(--rr-fg-button)',
		marginLeft: '4px',
		flexShrink: 0,
		lineHeight: '14px',
	},
	empty: {
		padding: '16px',
		textAlign: 'center' as const,
		color: 'var(--rr-text-disabled)',
	},
};

// =============================================================================
// Chevron SVG (matches VS Code's codicon chevron)
// =============================================================================

function ChevronIcon({ expanded }: { expanded: boolean }) {
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
// Close icon SVG
// =============================================================================

function CloseIcon() {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
			<path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z" />
		</svg>
	);
}

// =============================================================================
// Props
// =============================================================================

interface ICreateNodePanelProps {
	onClose: () => void;
}

// =============================================================================
// Component
// =============================================================================

export default function CreateNodePanel({ onClose }: ICreateNodePanelProps): ReactElement {
	const { inventory } = useFlowProject();
	const { addNode, setTempNode } = useFlowGraph();

	const [search, setSearch] = useState('');
	const [width, setWidth] = useState(DEFAULT_WIDTH);
	const [isResizing, setIsResizing] = useState(false);
	// Track which groups are expanded. Only "source" is open by default.
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set(['source']));
	const resizeStart = useRef({ mouseX: 0, width: 0 });

	// --- Resize handlers ---

	const onResizeMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			resizeStart.current = { mouseX: e.clientX, width };
			setIsResizing(true);
		},
		[width]
	);

	useEffect(() => {
		if (!isResizing) return;
		const onMouseMove = (e: MouseEvent) => {
			const delta = resizeStart.current.mouseX - e.clientX;
			setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, resizeStart.current.width + delta)));
		};
		const onMouseUp = () => setIsResizing(false);
		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseup', onMouseUp);
		return () => {
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', onMouseUp);
		};
	}, [isResizing]);

	// --- Group toggle ---

	const toggleGroup = (key: string) => {
		setExpandedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	// --- Inventory grouping + filtering ---

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

	// --- Click to add ---

	const onClickItem = (providerKey: string) => {
		addNode({
			provider: providerKey,
			name: '',
			description: '',
			config: {},
			input: [],
			control: [],
		});
	};

	// --- Drag to add ---

	const onDragStart = (e: React.DragEvent, providerKey: string) => {
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

	return (
		<div className="nopan nodrag" style={{ ...styles.container, width: `${width}px`, userSelect: isResizing ? 'none' : 'auto' }}>
			{/* Resize handle — pill-shaped grabber */}
			<div
				onMouseDown={onResizeMouseDown}
				style={{
					...styles.resizeHandle,
					opacity: isResizing ? 1 : 0.7,
				}}
				onMouseEnter={(e) => {
					(e.target as HTMLElement).style.opacity = '1';
					(e.target as HTMLElement).style.backgroundColor = 'var(--rr-accent)';
				}}
				onMouseLeave={(e) => {
					if (!isResizing) {
						(e.target as HTMLElement).style.opacity = '0.7';
						(e.target as HTMLElement).style.backgroundColor = 'var(--rr-border)';
					}
				}}
			/>

			{/* Panel body */}
			<div style={styles.panel}>
				{/* Header */}
				<div style={styles.header}>
					<span style={styles.headerTitle}>Add Node</span>
					<button style={styles.closeButton} onClick={onClose} title="Close">
						<CloseIcon />
					</button>
				</div>

				{/* Search */}
				<div style={styles.searchBox}>
					<TextField
						size="small"
						fullWidth
						placeholder="Search nodes..."
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						InputProps={{
							startAdornment: (
								<InputAdornment position="start">
									<Search size={14} style={{ color: 'var(--rr-text-disabled)' }} />
								</InputAdornment>
							),
							sx: {
								fontSize: 'inherit',
								fontFamily: 'inherit',
								color: 'inherit',
								height: '24px',
							},
						}}
					/>
				</div>

				{/* Scrollable node list */}
				<div style={styles.scrollArea}>
					{Object.entries(groupedInventory).map(([groupKey, items]) => {
						const expanded = expandedGroups.has(groupKey);
						return (
							<div key={groupKey}>
								{/* Section header */}
								<div style={styles.sectionHeader} onClick={() => toggleGroup(groupKey)}>
									<ChevronIcon expanded={expanded} />
									<span>{CATEGORY_TITLES[groupKey] ?? groupKey}</span>
								</div>

								{/* Items */}
								{expanded &&
									items.map(({ key, service }) => (
										<div
											key={key}
											draggable
											onDragStart={(e) => onDragStart(e, key)}
											onClick={() => onClickItem(key)}
											style={styles.item}
											onMouseEnter={(e) => {
												(e.currentTarget as HTMLElement).style.backgroundColor = 'var(--rr-bg-widget-hover)';
											}}
											onMouseLeave={(e) => {
												(e.currentTarget as HTMLElement).style.backgroundColor = '';
											}}
										>
											{service.icon && <img src={service.icon} alt="" style={{ ...styles.itemIcon, filter: service.icon?.includes('#td') ? 'var(--icon-filter)' : undefined }} />}
											<span style={styles.itemTitle}>{service.title ?? key}</span>
											{Array.isArray(service.classType) && service.classType.includes('tool') && <span style={styles.badge}>Tool</span>}
											{!!(service.capabilities && IServiceCapabilities.Experimental & service.capabilities) && <span style={styles.experimentalBadge}>Experimental</span>}
										</div>
									))}
							</div>
						);
					})}

					{Object.keys(groupedInventory).length === 0 && <div style={styles.empty}>{search ? 'No matching nodes' : 'No nodes available'}</div>}
				</div>
			</div>
		</div>
	);
}
