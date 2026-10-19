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
// surface a store tool MF-exports, and the hosts' sidebars render them by
// iterating the registry — no per-host composition roots, no fixed-mode
// special cases. The tier is decided by the registration route alone
// (this registry ⇒ builtin, the MF catalog ⇒ store).
//
// Hosts call registerBuiltinTools() once at startup; registration order is
// the strip's default order (Agent first — the startup default where the
// host serves it).
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

/** Registers the builtin tools (idempotent — the registry dedupes by id). */
export function registerBuiltinTools(): void {
	registerBuiltinTool({
		// No VS Code surface BY POLICY: that host's agent story is Claude
		// Code / Copilot — a second chat surface would be clutter.
		id: 'agent',
		name: 'Agent',
		description: 'Agent sessions against the connected engine.',
		icon: <AgentIcon size={16} />,
		sidebar: AgentTool,
		frame: AgentConversationTool,
		hosts: ['rocket'],
	});
	registerBuiltinTool({
		id: 'apps',
		name: 'Apps',
		description: 'Build, package, and deploy apps (App Builder).',
		icon: <AppsIcon size={16} />,
		sidebar: AppDevTool,
		frame: AppsToolFrame,
	});
	registerBuiltinTool({
		id: 'nodes',
		name: 'Nodes',
		description: 'Browse and scaffold pipeline nodes.',
		icon: <CodiconCircuitBoard size={16} />,
		sidebar: NodesTool,
	});
	registerBuiltinTool({
		id: 'pipelines',
		name: 'Pipelines',
		description: 'Discover, open, and run pipelines.',
		icon: <CodiconTypeHierarchy size={16} />,
		sidebar: PipelinesTool,
	});
}
