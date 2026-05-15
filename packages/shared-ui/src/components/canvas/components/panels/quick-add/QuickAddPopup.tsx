// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * QuickAddPopup — Compact popup for adding a compatible node from a handle click.
 *
 * Shows a filtered list of services that are compatible with the clicked
 * handle's lane type. Selecting a service creates a new node and connects
 * it to the clicked handle in one step.
 */

import { ReactElement, useMemo, useState, useEffect, useRef } from 'react';
import { TextField, InputAdornment } from '@mui/material';
import { Search } from 'lucide-react';

import { useFlowGraph } from '../../../context/FlowGraphContext';
import { useFlowProject } from '../../../context/FlowProjectContext';
import { IService, IServiceCapabilities, IServiceLane } from '../../../types';
import { getOutputLaneDisplayValues, renameInvokeType } from '../../../util/helpers';
import { generateNodeId } from '../../../util';
import { getIconPath } from '../../../util/get-icon-path';
import { commonStyles } from '../../../../../themes/styles';

// =============================================================================
// Positioning
// =============================================================================

/** Default gap between nodes when auto-placing. */
const GAP = 40;

/** Vertical step when searching for a free slot (lane mode shifts down, invoke mode shifts right). */
const STEP_Y = 20;

/** Horizontal step when searching for a free slot in invoke mode. */
const STEP_X = 20;

/**
 * Finds a free position near the clicked node by starting at the ideal
 * spot (GAP px to the right or left) and shifting down until no existing
 * node overlaps.
 */
function findFreePosition(nodes: { position: { x: number; y: number }; measured?: { width?: number; height?: number } }[], anchorX: number, anchorY: number, estimatedWidth: number, estimatedHeight: number): { x: number; y: number } {
	const overlaps = (x: number, y: number) =>
		nodes.some((n) => {
			const nw = n.measured?.width ?? 200;
			const nh = n.measured?.height ?? 80;
			return x < n.position.x + nw && x + estimatedWidth > n.position.x && y < n.position.y + nh && y + estimatedHeight > n.position.y;
		});

	let y = anchorY;
	// Try up to 30 steps down before giving up
	for (let i = 0; i < 30; i++) {
		if (!overlaps(anchorX, y)) return { x: anchorX, y };
		y += STEP_Y;
	}

	// Fallback — place below everything
	return { x: anchorX, y };
}

/**
 * Finds a free position for invoke mode by starting at the ideal spot
 * (GAP px above or below) and shifting right until no existing node overlaps.
 */
function findFreePositionVertical(nodes: { position: { x: number; y: number }; measured?: { width?: number; height?: number } }[], anchorX: number, anchorY: number, estimatedWidth: number, estimatedHeight: number): { x: number; y: number } {
	const overlaps = (x: number, y: number) =>
		nodes.some((n) => {
			const nw = n.measured?.width ?? 200;
			const nh = n.measured?.height ?? 80;
			return x < n.position.x + nw && x + estimatedWidth > n.position.x && y < n.position.y + nh && y + estimatedHeight > n.position.y;
		});

	let x = anchorX;
	// Try up to 30 steps right before giving up
	for (let i = 0; i < 30; i++) {
		if (!overlaps(x, anchorY)) return { x, y: anchorY };
		x += STEP_X;
	}

	// Fallback — place to the right of everything
	return { x, y: anchorY };
}

// =============================================================================
// Styles
// =============================================================================

const styles = {
	overlay: {
		position: 'fixed' as const,
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		zIndex: 50,
	},
	popup: {
		position: 'fixed' as const,
		width: '220px',
		maxHeight: '300px',
		display: 'flex',
		flexDirection: 'column' as const,
		backgroundColor: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
		borderRadius: '4px',
		boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
		zIndex: 51,
		overflow: 'hidden',
		fontSize: '12px',
		fontFamily: 'var(--rr-font-family)',
		color: 'var(--rr-fg-widget)',
	},
	searchBox: {
		padding: '6px',
		borderBottom: '1px solid var(--rr-border)',
	},
	scrollArea: {
		flex: 1,
		overflowY: 'auto' as const,
		padding: '4px 0',
	},
	item: {
		display: 'flex',
		alignItems: 'center',
		height: '24px',
		padding: '0 8px',
		cursor: 'pointer',
		gap: '6px',
	},
	itemIcon: {
		width: '16px',
		height: '16px',
		flexShrink: 0,
	},
	itemTitle: commonStyles.textEllipsis,
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
		padding: '12px',
		textAlign: 'center' as const,
		color: 'var(--rr-text-disabled)',
		fontSize: '11px',
	},
};

// =============================================================================
// Component
// =============================================================================

export default function QuickAddPopup(): ReactElement | null {
	const { quickAddState, setQuickAddState, addNode, onEdgeConnect, nodes } = useFlowGraph();
	const { servicesJson } = useFlowProject();

	const [search, setSearch] = useState('');
	const searchRef = useRef<HTMLInputElement>(null);

	// Focus search field when popup opens
	useEffect(() => {
		if (quickAddState) {
			setSearch('');
			setTimeout(() => searchRef.current?.focus(), 0);
		}
	}, [quickAddState]);

	// Filter services compatible with the clicked handle
	const compatibleServices = useMemo(() => {
		if (!quickAddState || !servicesJson) return [];

		const { laneType, isSource, mode, invokeKey } = quickAddState;
		const catalog = servicesJson as Record<string, IService>;
		const results: { key: string; service: IService }[] = [];

		for (const [providerKey, service] of Object.entries(catalog)) {
			// Skip NoSaas services (not available in SaaS UI, e.g. Filesys)
			const isNoSaas = service.capabilities && (IServiceCapabilities.NoSaas & service.capabilities) === IServiceCapabilities.NoSaas;
			if (isNoSaas) continue;

			// Skip deprecated
			const isDeprecated = service.capabilities && (IServiceCapabilities.Deprecated & service.capabilities) === IServiceCapabilities.Deprecated;
			if (isDeprecated) continue;

			if (mode === 'invoke') {
				// --- Invoke mode filtering ---
				if (isSource && invokeKey) {
					// Clicked an invoke-source handle (e.g. invoke-source.llm)
					// New node must be invocable AND have a classType matching the channel key
					const isInvocable = service.capabilities && (IServiceCapabilities.Invoke & service.capabilities) === IServiceCapabilities.Invoke;
					if (isInvocable && Array.isArray(service.classType) && service.classType.includes(invokeKey)) {
						results.push({ key: providerKey, service });
					}
				} else if (!isSource) {
					// Clicked an invoke-target handle
					// New node must have an invoke channel whose key matches one of the clicked node's classType entries
					const clickedNode = nodes.find((n) => n.id === quickAddState.nodeId);
					const clickedService = clickedNode ? catalog[clickedNode.data.provider as string] : undefined;
					const clickedClassType = clickedService?.classType ?? [];
					const serviceInvokeKeys = Object.keys(service.invoke ?? {});
					if (serviceInvokeKeys.some((k) => clickedClassType.includes(k))) {
						results.push({ key: providerKey, service });
					}
				}
			} else {
				// --- Lane mode filtering ---
				const lanes = service.lanes as Record<string, IServiceLane> | undefined;
				if (!lanes) continue;

				if (isSource) {
					// Clicked a source handle — find services that accept this lane type as input
					if (laneType in lanes) {
						results.push({ key: providerKey, service });
					}
				} else {
					// Clicked a target handle — find services that produce this lane type as output
					let produces = false;
					for (const outputLanes of Object.values(lanes)) {
						for (const entry of outputLanes) {
							const { type } = getOutputLaneDisplayValues(entry);
							if (type === laneType) {
								produces = true;
								break;
							}
						}
						if (produces) break;
					}
					if (produces) {
						results.push({ key: providerKey, service });
					}
				}
			}
		}

		// Apply text search filter
		if (search) {
			const lower = search.toLowerCase();
			return results.filter(({ service }) => (service.title ?? '').toLowerCase().includes(lower));
		}

		return results.sort((a, b) => (a.service.title ?? a.key).localeCompare(b.service.title ?? b.key));
	}, [quickAddState, servicesJson, search, nodes]);

	if (!quickAddState) return null;

	const { nodeId, handleId, laneType, isSource, position, mode, invokeKey } = quickAddState;

	const onSelect = (providerKey: string) => {
		const catalog = servicesJson as Record<string, IService>;

		// Compute the new node's ID before creating it
		const newNodeId = generateNodeId(nodes, providerKey);

		// Find the clicked node to position the new node near it
		const clickedNode = nodes.find((n) => n.id === nodeId);
		const nodePos = clickedNode?.position ?? { x: 0, y: 0 };
		const nodeWidth = clickedNode?.measured?.width ?? 200;
		const nodeHeight = clickedNode?.measured?.height ?? 80;
		const estimatedNewWidth = 200;
		const estimatedNewHeight = 80;

		let newPos: { x: number; y: number };

		if (mode === 'invoke') {
			// Invoke mode: position above (target click) or below (source click), centered horizontally
			const anchorX = nodePos.x + (nodeWidth - estimatedNewWidth) / 2;
			const anchorY = isSource ? nodePos.y + nodeHeight + GAP : nodePos.y - estimatedNewHeight - GAP;
			newPos = findFreePositionVertical(nodes, anchorX, anchorY, estimatedNewWidth, estimatedNewHeight);
		} else {
			// Lane mode: position to the right (source) or left (target)
			const anchorX = isSource ? nodePos.x + nodeWidth + GAP : nodePos.x - estimatedNewWidth - GAP;
			newPos = findFreePosition(nodes, anchorX, nodePos.y, estimatedNewWidth, estimatedNewHeight);
		}

		// Create the new node
		addNode(
			{
				provider: providerKey,
				name: '',
				description: '',
				config: {},
				input: [],
				control: [],
			},
			newPos
		);

		if (mode === 'invoke') {
			// Connect invoke handles
			if (isSource && invokeKey) {
				// Clicked invoke-source.{key} on existing node → new node is the target
				onEdgeConnect({
					source: nodeId,
					target: newNodeId,
					sourceHandle: handleId,
					targetHandle: 'invoke-target',
				});
			} else {
				// Clicked invoke-target on existing node → new node is the source
				// Find which invoke key on the new node matches the clicked node's classType
				const clickedService = clickedNode ? catalog[clickedNode.data.provider as string] : undefined;
				const clickedClassType = clickedService?.classType ?? [];
				const newService = catalog[providerKey];
				const newInvokeKeys = Object.keys(newService?.invoke ?? {});
				const matchingKey = newInvokeKeys.find((k) => clickedClassType.includes(k));
				if (matchingKey) {
					onEdgeConnect({
						source: newNodeId,
						target: nodeId,
						sourceHandle: `invoke-source.${matchingKey}`,
						targetHandle: 'invoke-target',
					});
				}
			}
		} else {
			// Connect lane handles
			if (isSource) {
				onEdgeConnect({
					source: nodeId,
					target: newNodeId,
					sourceHandle: handleId,
					targetHandle: `target-${laneType}`,
				});
			} else {
				onEdgeConnect({
					source: newNodeId,
					target: nodeId,
					sourceHandle: `source-${laneType}`,
					targetHandle: handleId,
				});
			}
		}

		setQuickAddState(null);
	};

	return (
		<>
			{/* Invisible overlay to close popup on click outside */}
			<div style={styles.overlay} onClick={() => setQuickAddState(null)} />

			{/* Popup */}
			<div
				className="nopan nodrag"
				style={{
					...styles.popup,
					left: position.x,
					top: position.y,
				}}
			>
				{/* Search */}
				<div style={styles.searchBox}>
					<TextField
						inputRef={searchRef}
						size="small"
						fullWidth
						placeholder={mode === 'invoke' ? (isSource ? `Add ${renameInvokeType(invokeKey ?? 'invoke')} provider...` : 'Add invoker...') : `Add ${laneType} node...`}
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						InputProps={{
							startAdornment: (
								<InputAdornment position="start">
									<Search size={14} style={{ color: 'var(--rr-text-disabled)' }} />
								</InputAdornment>
							),
							sx: {
								fontSize: '12px',
								fontFamily: 'inherit',
								color: 'inherit',
								height: '24px',
							},
						}}
					/>
				</div>

				{/* Service list */}
				<div style={styles.scrollArea}>
					{compatibleServices.map(({ key, service }) => (
						<div
							key={key}
							onClick={() => onSelect(key)}
							style={styles.item}
							onMouseEnter={(e) => {
								(e.currentTarget as HTMLElement).style.backgroundColor = 'var(--rr-bg-widget-hover)';
							}}
							onMouseLeave={(e) => {
								(e.currentTarget as HTMLElement).style.backgroundColor = '';
							}}
						>
							{(() => {
								const icon = getIconPath(service.icon);
								return (
									<img
										src={icon}
										alt=""
										style={{
											...styles.itemIcon,
											filter: icon.includes('#td') ? 'var(--icon-filter)' : undefined,
										}}
									/>
								);
							})()}
							<span style={styles.itemTitle}>{service.title ?? key}</span>
							{Array.isArray(service.classType) && service.classType.includes('tool') && <span style={styles.badge}>Tool</span>}
							{!!(service.capabilities && IServiceCapabilities.Experimental & service.capabilities) && <span style={styles.experimentalBadge}>Experimental</span>}
						</div>
					))}

					{compatibleServices.length === 0 && <div style={styles.empty}>{search ? 'No matching nodes' : 'No compatible nodes'}</div>}
				</div>
			</div>
		</>
	);
}
