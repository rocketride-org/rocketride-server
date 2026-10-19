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
// TOOLS/CORE — the builtin tool registry
// =============================================================================
//
// A TOOL IS AN APP: builtins (agent, appdev, nodes, pipelines) export the
// same AppDescriptor surface a store tool ships over Module Federation —
// devToolSidebar as the controller, devToolFrame as the document view — but
// are COMPILED INTO the host bundle and registered here. The tier is decided
// by the registration route alone (this registry ⇒ builtin, the MF catalog ⇒
// store), never by anything a manifest claims, so a store app can never
// self-promote into host capabilities.
//
// Phase 3 of the sidebar-as-controller migration populates this registry
// (tools/appdev first); until then it is the empty, typed seam both hosts
// already agree on.
// =============================================================================

import type { ComponentType, ReactNode } from 'react';
import type { DevToolProps } from 'shell';

/** One builtin tool: the tool surface plus the strip metadata a store
 *  tool's manifest row would otherwise carry (the "fake appManifest"). */
export interface BuiltinTool {
	/** Stable tool id — the strip tab id AND the tool's channel key. */
	id: string;
	/** Display name (tab tooltip, store rows, panel headings). */
	name: string;
	/** Strip tab glyph (undefined = text label). */
	icon?: ReactNode;
	/** One-line description for the Dev Tools store rows. */
	description?: string;
	/** The tool's CONTROLLER — same contract a store tool MF-exports as
	 *  devToolSidebar; host capabilities arrive via ToolContext. */
	sidebar: ComponentType<DevToolProps>;
	/** The tool's document view, where one exists. */
	frame?: ComponentType<DevToolProps>;
	/** Host ids this tool is served on (undefined = every host). The agent
	 *  tool, for example, has no VS Code surface yet. */
	hosts?: readonly ('rocket' | 'vscode')[];
}

const builtins: BuiltinTool[] = [];

/**
 * Registers a builtin tool. Called at host startup, before any sidebar
 * renders; registration order is the strip's default order (the user's
 * persisted tab order re-ranks it).
 *
 * @param tool - The builtin tool entry.
 */
export function registerBuiltinTool(tool: BuiltinTool): void {
	if (builtins.some((t) => t.id === tool.id)) return;
	builtins.push(tool);
}

/**
 * The registered builtin tools, in registration order.
 *
 * @returns The builtin tool list.
 */
export function getBuiltinTools(): readonly BuiltinTool[] {
	return builtins;
}
