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
// SIDEBAR — the VS Code host's builtin-tool COMPOSITION ROOT
// =============================================================================
//
// The one place this host wires the builtin tools' panels (tools/<tool>/ in
// shared) to its capabilities. SidebarWebview stays plumbing; the chrome
// stays generic; THIS file is the catalog. When the builtin panels consume
// a ToolContext instead of bespoke props, this enumeration collapses into
// iterating the tools/core registry — until then, adding a builtin tool to
// this host means adding one entry here.
// =============================================================================

import React from 'react';
import { AppDevSidebarPanel } from 'shared/tools/appdev/AppDevSidebarPanel';
import { NodesSidebarPanel } from 'shared/tools/nodes/NodesSidebarPanel';
import { PipelinesSidebarPanel } from 'shared/tools/pipelines/PipelinesSidebarPanel';
import type { IAppDevSidebarPanelProps } from 'shared/tools/appdev/AppDevSidebarPanel';
import type { INodesSidebarPanelProps } from 'shared/tools/nodes/NodesSidebarPanel';
import type { IPipelinesSidebarPanelProps } from 'shared/tools/pipelines/PipelinesSidebarPanel';
import type { SidebarToolItem } from 'shared/tools/core/chrome/SidebarChrome';
import { AppsIcon } from 'shared/components/icons/AppsIcon';
import { CodiconCircuitBoard, CodiconTypeHierarchy } from 'shared/components/icons/Codicon';

/** Everything the builtin tools need from this host. */
export interface IBuiltinToolDeps {
	appdev: IAppDevSidebarPanelProps;
	nodes: INodesSidebarPanelProps;
	pipelines: IPipelinesSidebarPanelProps;
}

/**
 * The VS Code host's builtin tools, in default strip order.
 *
 * @param deps - The per-tool wiring.
 * @returns The chrome's item list.
 */
export function buildBuiltinSidebarItems(deps: IBuiltinToolDeps): SidebarToolItem[] {
	return [
		{
			id: 'apps',
			label: 'Apps',
			icon: <AppsIcon size={16} />,
			render: () => <AppDevSidebarPanel {...deps.appdev} />,
		},
		{
			id: 'nodes',
			label: 'Nodes',
			icon: <CodiconCircuitBoard size={16} />,
			render: () => <NodesSidebarPanel {...deps.nodes} />,
		},
		{
			id: 'pipelines',
			label: 'Pipelines',
			icon: <CodiconTypeHierarchy size={16} />,
			render: () => <PipelinesSidebarPanel {...deps.pipelines} />,
		},
	];
}
