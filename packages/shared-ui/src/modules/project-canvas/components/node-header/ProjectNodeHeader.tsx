// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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

import { ReactElement } from 'react';

import { useFlow } from '../../FlowContext';
import { NodeType } from '../../../../constants';
import NodeHeader from './NodeHeader';
import useNodeActionLabels from '../../hooks/useNodeActionLabels';
import { useCopy, usePaste } from '../helpers/shortcuts';
import { Option } from '../../../../types/ui';

/**
 * Props for the ProjectNodeHeader component.
 *
 * Provides node identity and metadata used to build the contextual menu options,
 * determine edit/visibility behavior, and wire up action callbacks.
 */
interface IProps {
	/** Unique identifier of the node. */
	id: string;
	/** When true the settings gear icon is hidden in the header. */
	hideEdit?: boolean;
	/** The node type, used to decide which menu items and edit affordances to show. */
	nodeType?: NodeType;
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
	/** If set, the node belongs to a group and an "ungroup" option is added to the menu. */
	parentId?: string;
	/** Optional click handler for the header row. */
	handleClick?: () => void;
	/** Class type tags for the node (e.g. ["llm"]), shown as a subtitle. */
	classType?: string[];
}

/**
 * Smart wrapper around NodeHeader that assembles the "more options" menu and
 * wires up project-canvas-specific actions (open, duplicate, delete, ungroup,
 * documentation link).
 *
 * This component pulls context from the FlowContext (toolchain state, action
 * dispatchers, action panel type) and from keyboard shortcut hooks to build the
 * full set of options passed down to the presentational NodeHeader. It also
 * handles dev-mode title switching (showing node ID instead of title) and
 * conditionally hides the edit button for non-editable node types.
 *
 * @param props - Node identity, metadata, and an optional click handler.
 * @returns The configured NodeHeader with contextual menu options.
 */
export default function ProjectNodeHeader({
	id,
	hideEdit = false,
	nodeType,
	icon,
	title,
	description,
	documentation,
	formDataValid,
	parentId,
	handleClick,
	classType,
}: IProps): ReactElement {
	// Pull canvas-level state and action dispatchers from FlowContext
	const {
		toolchainState,
		onEditNode,
		actionsPanelType,
		deleteNodesById,
		setSelectedNode,
		ungroupNode,
		onOpenLink,
	} = useFlow();

	// Retrieve localized labels and keyboard shortcut hints for each menu action
	const {
		open,
		duplicate,
		deleteNode,
		documentation: documentationLabel,
		ungroup,
	} = useNodeActionLabels();
	const copy = useCopy();
	const paste = usePaste();

	// Build the menu options array incrementally based on node capabilities
	let options: Option[] = [];

	// "Open" is only available for editable node types
	if (!hideEdit) {
		options = [
			{
				...open,
				handleClick: () => onEditNode(),
			},
		];
	}

	// Duplicate and delete are available for all nodes (with conditional disabling)
	options = [
		...options,
		{
			...duplicate,
			handleClick: () => {
				// Select the node first so copy/paste operates on it specifically
				setSelectedNode(id);
				copy();
				paste();
			},
			// Disable when a panel is open or when actions are globally locked (e.g. during run)
			disabled: !!actionsPanelType,
		},
		{
			...deleteNode,
			handleClick: () => deleteNodesById([id]),
			disabled: false,
		},
	];

	// Add the ungroup option only for nodes that are children of a group
	if (parentId) {
		options = [
			...options,
			{
				...ungroup,
				handleClick: () => ungroupNode([id]),
			},
		];
	}

	// Append a documentation link separated by a visual divider if docs URL is provided
	if (documentation) {
		options = [
			...options,
			{
				label: 'border',
			},
			{
				...documentationLabel,
				// Prefer the host-provided link opener (e.g. VS Code external browser) over window.open
				handleClick: () =>
					onOpenLink ? onOpenLink(documentation) : window.open(documentation, '_blank'),
			},
		];
	}

	return (
		<NodeHeader
			handleClick={() => {
				// Guard against clicks when actions are globally disabled (e.g. pipeline running)
				if (handleClick) {
					handleClick();
				}
			}}
			icon={icon}
			// In dev mode, show the internal node ID instead of the display title for debugging
			title={toolchainState.isDevMode ? id : title}
			description={description}
			isDragging={toolchainState.isDragging}
			// Hide the edit gear only for group nodes (which are just containers)
			hideEdit={hideEdit || !nodeType || nodeType === NodeType.Group}
			handleEdit={() => onEditNode()}
			formDataValid={formDataValid}
			options={options}
			classType={classType}
		/>
	);
}
