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
// TOOLS — the builtin tool CATALOG (one registration, every host)
// =============================================================================
//
// A TOOL IS AN APP: the four resident tools register here with the same
// manifest + descriptor pair a store tool ships, and the hosts' sidebars
// render them by iterating the registry — no per-host composition roots, no
// fixed-mode special cases. The tier is decided by the registration route
// alone (this registry ⇒ builtin, the MF catalog ⇒ store); the one thing a
// builtin's manifest lacks is a loader, because there is nothing to fetch.
//
// Hosts call registerBuiltinTools() once at startup; registration order is
// the strip's default order (Agent first — the startup default where the
// host serves it). Host reach is the manifest's `shells` declaration
// (absent = every shell), exactly as for a store app.
// =============================================================================

import { registerBuiltinTool } from './core/registry';
import { AgentTool } from './agent/AgentTool';
import { AgentConversationTool } from './agent/AgentConversation';
import { AgentIcon } from './agent/AgentIcon';
import { AppDevTool } from './appdev/AppDevTool';
import { AppsToolFrame } from './appdev/AppsToolFrame';
import { NodesTool } from './nodes/NodesTool';
import { PipelinesTool } from './pipelines/PipelinesTool';
import { AppsIcon } from '../components/icons/AppsIcon';
import { CodiconCircuitBoard, CodiconTypeHierarchy } from '../components/icons/Codicon';
// Catalog icons: the SAME glyph sources as the strip tabs, as plain assets.
// `?url` bypasses SVGR and yields the emitted asset's URL — every host
// resolves it like any web app (the VS Code webviews via assetPrefix 'auto').
import agentIconUrl from './agent/icon.svg?url';
import appsIconUrl from './appdev/icon.svg?url';
import nodesIconUrl from './nodes/icon.svg?url';
import pipelinesIconUrl from './pipelines/icon.svg?url';
// Setting declarations live in the PURE toolSettings leaf (the ext host and
// settings surfaces import that, never this asset-bearing module).
import { APPS_TOOL_SETTINGS, PIPELINES_TOOL_SETTINGS } from './toolSettings';

const PUBLISHER = 'Aparavi Software AG';

/** Registers the builtin tools (idempotent — the registry dedupes by id). */
export function registerBuiltinTools(): void {
	registerBuiltinTool({
		manifest: {
			name: 'Agent',
			publisher: PUBLISHER,
			description: 'Agent sessions against the connected engine.',
			icon: agentIconUrl,
			categories: ['devTool'],
			// No VS Code surface BY POLICY: that host's agent story is Claude
			// Code / Copilot — a second chat surface would be clutter.
			shells: ['saas', 'oss'],
		},
		descriptor: {
			id: 'agent',
			name: 'Agent',
			icon: <AgentIcon size={16} />,
			devToolSidebar: AgentTool,
			devToolFrame: AgentConversationTool,
		},
	});
	registerBuiltinTool({
		manifest: {
			name: 'Apps',
			publisher: PUBLISHER,
			description: 'Build, package, and deploy apps (App Builder).',
			icon: appsIconUrl,
			categories: ['devTool'],
			configuration: APPS_TOOL_SETTINGS,
		},
		descriptor: {
			id: 'apps',
			name: 'Apps',
			icon: <AppsIcon size={16} />,
			devToolSidebar: AppDevTool,
			devToolFrame: AppsToolFrame,
		},
	});
	registerBuiltinTool({
		manifest: {
			name: 'Nodes',
			publisher: PUBLISHER,
			description: 'Browse and scaffold pipeline nodes.',
			icon: nodesIconUrl,
			categories: ['devTool'],
		},
		descriptor: {
			id: 'nodes',
			name: 'Nodes',
			icon: <CodiconCircuitBoard size={16} />,
			devToolSidebar: NodesTool,
		},
	});
	registerBuiltinTool({
		manifest: {
			name: 'Pipelines',
			publisher: PUBLISHER,
			description: 'Discover, open, and run pipelines.',
			icon: pipelinesIconUrl,
			categories: ['devTool'],
			configuration: PIPELINES_TOOL_SETTINGS,
		},
		descriptor: {
			id: 'pipelines',
			name: 'Pipelines',
			icon: <CodiconTypeHierarchy size={16} />,
			devToolSidebar: PipelinesTool,
		},
	});
}
