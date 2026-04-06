// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

/**
 * NodeHeader — Header bar for canvas nodes.
 *
 * Combines context-aware menu assembly with the visual rendering of the
 * node header. This single component:
 *
 *   1. Pulls state and action dispatchers from FlowContext (toolchain state,
 *      edit/delete/ungroup handlers, action panel type).
 *   2. Assembles the "more options" menu entries based on node capabilities:
 *      - Open (edit) — only for editable node types
 *      - Duplicate — copy + paste via keyboard shortcut hooks
 *      - Delete — remove the node by ID
 *      - Ungroup — only for nodes inside a group
 *      - Documentation — external link, only when a docs URL is provided
 *   3. Switches the displayed title to the internal node ID when dev mode is active.
 *   4. Renders the icon, title (with rich-HTML tooltip), class type subtitle,
 *      settings gear, and overflow menu.
 */

import React, { ReactElement } from 'react';
import { Tooltip } from '@mui/material';
import { Settings } from 'lucide-react';

import { Option } from '../../../../../../types/ui';
import { sanitizeAndParseHtmlToReact } from '../../../../util/helpers';
import ConditionalRender from '../../../ConditionalRender';
import MoreMenu from './more-menu';
import { useFlow, useNodeActionLabels, useCopy, usePaste } from '../../../../hooks';

// =============================================================================
// Styles
// =============================================================================

const nodeLabel = {
	letterSpacing: 0,
	lineHeight: 1,
	textAlign: 'left' as const,
	overflow: 'hidden',
	whiteSpace: 'normal' as const,
	display: '-webkit-box',
	WebkitLineClamp: 2,
	WebkitBoxOrient: 'vertical' as const,
};

// =============================================================================
// Types
// =============================================================================

/**
 * Props for the NodeHeader component.
 */
interface INodeHeaderProps {
	/** Unique node identifier. */
	id: string;
	/** When true the settings gear icon is hidden in the header. */
	hideEdit?: boolean;
	/** Node type, used to decide which menu items and edit affordances to show. */
	nodeType?: string;
	/** URL of the node icon image. */
	icon?: string;
	/** Display name for the node header. */
	title?: string;
	/** HTML description rendered in a tooltip on hover. */
	description?: string;
	/** URL to external documentation for this node/service. */
	documentation?: string;
	/** When false the settings icon turns red to indicate invalid configuration. */
	formDataValid?: boolean;
	/** If set, the node belongs to a group and an "ungroup" option is added. */
	parentId?: string;
	/** Optional click handler for the header row. */
	handleClick?: () => void;
	/** Class type tags for the node (e.g. ["llm"]), shown as a subtitle. */
	classType?: string[];
	/** Number of pipeline errors to display as a red badge on the title. */
	errorCount?: number;
	/** Number of pipeline warnings to display as an orange badge on the title. */
	warningCount?: number;
	/** Callback when error/warning badge is clicked (opens status page). */
	onBadgeClick?: () => void;
	/** Whether this node's service is flagged as experimental. */
	isExperimental?: boolean;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the node header bar with context-aware menu options.
 *
 * @param props - Node identity, metadata, and an optional click handler.
 * @returns The fully rendered header bar element.
 */
export default function NodeHeader({ id, hideEdit = false, nodeType, icon, title, description, documentation, formDataValid, parentId: _parentId, handleClick, classType, errorCount, warningCount, onBadgeClick, isExperimental }: INodeHeaderProps): ReactElement {
	// ========================================================================
	// FlowContext state and actions
	// ========================================================================

	const { toolchainState, deleteNode: deleteNodeFromGraph, onOpenLink } = useFlow();

	// Open the node config panel via the graph context
	const { setEditingNodeId, editingNodeId } = useFlow();
	const onEditNode = () => setEditingNodeId(id);
	const actionsPanelType: string | undefined = editingNodeId ? 'node' : undefined;

	// Retrieve localised labels and keyboard shortcut hints for each action
	const { open, duplicate, deleteNode, documentation: documentationLabel } = useNodeActionLabels();
	const copy = useCopy();
	const paste = usePaste();

	// ========================================================================
	// Assemble menu options based on node capabilities
	// ========================================================================

	let options: Option[] = [];

	// "Open" is only available for editable node types
	if (!hideEdit) {
		options = [{ ...open, handleClick: () => onEditNode() }];
	}

	// Duplicate and delete are available for all nodes
	options = [
		...options,
		{
			...duplicate,
			handleClick: () => {
				copy();
				paste();
			},
			disabled: !!actionsPanelType,
		},
		{
			...deleteNode,
			handleClick: () => deleteNodeFromGraph([id]),
			disabled: false,
		},
	];

	// Documentation link — separated by a visual divider if a docs URL is provided
	if (documentation) {
		options = [
			...options,
			{ label: 'border' },
			{
				...documentationLabel,
				// Prefer the host-provided link opener (e.g. VS Code external browser)
				handleClick: () => (onOpenLink ? onOpenLink(documentation) : window.open(documentation, '_blank')),
			},
		];
	}

	// ========================================================================
	// Derived display values
	// ========================================================================

	// In dev mode, show the internal node ID instead of the display title
	const displayTitle = toolchainState.isDevMode ? id : title;

	// Hide the edit gear when hideEdit is set or nodeType is missing
	const showEdit = !(hideEdit || !nodeType);

	// Build the subtitle from class type tags (e.g. "AGENT · TOOL")
	const subtitleText = classType?.length ? classType.join(' · ') : undefined;

	// Title element — reused in both the tooltip and non-tooltip render paths
	const titleElement = (
		<div>
			<span style={{ ...styles.title, ...nodeLabel }}>
				{displayTitle}
				{errorCount != null && errorCount > 0 && (
					<span
						style={styles.errorBadge}
						onClick={(e: React.MouseEvent) => {
							e.stopPropagation();
							onBadgeClick?.();
						}}
					>
						{errorCount}
					</span>
				)}
				{warningCount != null && warningCount > 0 && (
					<span
						style={styles.warningBadge}
						onClick={(e: React.MouseEvent) => {
							e.stopPropagation();
							onBadgeClick?.();
						}}
					>
						{warningCount}
					</span>
				)}
			</span>
			{isExperimental && <span style={styles.experimentalBadge}>EXPERIMENTAL</span>}
			<ConditionalRender condition={subtitleText}>
				<span style={styles.subtitle}>{subtitleText}</span>
			</ConditionalRender>
		</div>
	);

	// ========================================================================
	// Render
	// ========================================================================

	return (
		<div className="rr-node-header" onClick={handleClick ? () => handleClick() : undefined}>
			{/* Node icon */}
			<ConditionalRender condition={icon}>
				<div style={styles.boxImage}>
					<img
						style={{
							...styles.nodeIcon,
							// Apply icon filter for themed icons (identified by #td in URL)
							filter: icon?.includes('#td') ? 'var(--icon-filter)' : undefined,
						}}
						width="auto"
						src={icon}
					/>
				</div>
			</ConditionalRender>

			{/* Title with optional tooltip showing the HTML description */}
			<div style={styles.boxLabel}>
				<ConditionalRender condition={description && !toolchainState.isDragging} fallback={titleElement}>
					<Tooltip
						enterDelay={700}
						arrow
						placement="top"
						title={
							<div
								style={{
									fontSize: 'var(--rr-font-size)',
									fontFamily: 'var(--rr-font-family)',
									fontWeight: 400,
									padding: '0.25rem',
								}}
							>
								{sanitizeAndParseHtmlToReact(description)}
							</div>
						}
						slotProps={{
							tooltip: {
								sx: {
									maxWidth: 300,
									fontWeight: 400,
									fontFamily: 'var(--rr-font-family)',
									fontSize: 'var(--rr-font-size)',
								},
							},
						}}
					>
						{titleElement}
					</Tooltip>
				</ConditionalRender>
			</div>

			{/* Settings gear and overflow menu */}
			<div style={styles.boxEdit}>
				<ConditionalRender condition={showEdit}>
					<button aria-label="Edit node" style={{ ...styles.editButton, background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }} onClick={() => onEditNode()}>
						<Settings
							size={16}
							style={{
								...styles.editIcon,
								// Red gear when form data is invalid; otherwise let editIcon.color stand.
								...(formDataValid === false ? { color: 'var(--rr-color-error)' } : {}),
							}}
						/>
					</button>
				</ConditionalRender>
				<ConditionalRender condition={options}>
					<MoreMenu buttonSx={{ padding: 0 }} options={options!} isDisabled={false} />
				</ConditionalRender>
			</div>
		</div>
	);
}

/**
 * Style definitions for the NodeHeader component.
 * The root header uses the `.rr-node-header` CSS class for hover/selected states.
 */
const styles = {
	/** Node icon sizing and spacing. */
	nodeIcon: {
		width: 'auto',
		height: '1rem',
		marginRight: '0.5rem',
		fill: 'var(--rr-text-secondary)',
	} as React.CSSProperties,

	/** Title text styling. */
	title: {
		fontWeight: 500,
		fontSize: 'var(--rr-font-size-sm)',
	} as React.CSSProperties,

	/** Class type subtitle (e.g. "AGENT · TOOL"). */
	subtitle: {
		fontSize: '0.4rem',
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.2,
		textTransform: 'uppercase' as const,
		marginTop: '0.15rem',
		textAlign: 'left' as const,
		display: 'block',
	} as React.CSSProperties,

	/** Icon container. */
	boxImage: {
		display: 'flex',
		alignItems: 'center' as const,
		minWidth: '1rem',
	} as React.CSSProperties,

	/** Title/label container — takes up most of the header width. */
	boxLabel: {
		overflow: 'hidden',
		flex: 4,
	} as React.CSSProperties,

	/** Edit button + menu container. */
	boxEdit: {
		display: 'flex',
	} as React.CSSProperties,

	/** Settings gear button. */
	editButton: {
		padding: 0,
	} as React.CSSProperties,

	/** Settings gear icon. */
	editIcon: {
		height: '1rem',
		width: 'auto',
		color: 'var(--rr-text-secondary)',
	} as React.CSSProperties,

	/** Red error count badge next to the title. */
	errorBadge: {
		display: 'inline-flex',
		alignItems: 'center' as const,
		justifyContent: 'center',
		backgroundColor: 'var(--rr-error, #f14c4c)',
		color: 'var(--rr-fg-button)',
		fontSize: '8px',
		fontWeight: 600,
		minWidth: '14px',
		height: '14px',
		borderRadius: '7px',
		padding: '0 3px',
		marginLeft: '4px',
		lineHeight: 1,
		cursor: 'pointer',
		verticalAlign: 'middle' as const,
	} as React.CSSProperties,
	/** Orange warning count badge next to the title. */
	warningBadge: {
		display: 'inline-flex',
		alignItems: 'center' as const,
		justifyContent: 'center',
		backgroundColor: 'var(--rr-warning, #cca700)',
		color: 'var(--rr-fg-button)',
		fontSize: '8px',
		fontWeight: 600,
		minWidth: '14px',
		height: '14px',
		borderRadius: '7px',
		padding: '0 3px',
		marginLeft: '4px',
		lineHeight: 1,
		cursor: 'pointer',
		verticalAlign: 'middle' as const,
	} as React.CSSProperties,

	/** Yellow experimental badge below the title. */
	experimentalBadge: {
		display: 'inline-block',
		fontSize: '8px',
		fontWeight: 600,
		padding: '1px 4px',
		borderRadius: '3px',
		backgroundColor: 'var(--rr-color-warning)',
		color: 'var(--rr-fg-button)',
		lineHeight: '14px',
	} as React.CSSProperties,
};
