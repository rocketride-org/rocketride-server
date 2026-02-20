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
import CreateNodePanel from './panels/create-node/CreateNodePanel';
import NodePanel from './panels/node/NodePanel';
import { useFlow } from '../FlowContext';
import { ActionsType } from '../constants';
import DevPanel from './panels/dev-panel/DevPanel';
import ImportExportPanel from './panels/import-export/ImportExportPanel';

/**
 * Renders the appropriate side panel based on the currently active action type.
 * Acts as a router/switch for the various panel views (create node, node config,
 * dev panel, import/export) within the project canvas. The active panel type is
 * determined by the FlowContext state, and closing any panel resets it to undefined.
 *
 * @returns The active panel component, or null if no panel is open.
 */
export default function ActionsPanel(): ReactElement {
	// Retrieve the current panel type and the toggle function from shared flow context
	const { toggleActionsPanel, actionsPanelType } = useFlow();

	/**
	 * Closes the currently open actions panel by resetting the panel type to undefined.
	 */
	const onClose = () => {
		// Setting the panel type to undefined causes no panel to render
		toggleActionsPanel(undefined);
	};

	// Route to the correct panel component based on the active action type
	switch (actionsPanelType) {
		case ActionsType.CreateNode:
			return <CreateNodePanel onClose={onClose} />;
		case ActionsType.Node:
			return <NodePanel onClose={onClose} />;
		case ActionsType.DevPanel:
			return <DevPanel onClose={onClose} />;
		case ActionsType.ImportExportPanel:
			return <ImportExportPanel onClose={onClose} />;
		default:
			// No panel is open; cast null to ReactElement to satisfy the return type
			return null as unknown as ReactElement;
	}
}
