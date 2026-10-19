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
// TOOLS/CORE — the builtin tools' host-services EXTENSION
// =============================================================================
//
// The generic contract (ToolHostServices, ToolHostProvider, useToolHost,
// the loopback peer, ToolWorkspaceFs) lives in the SHELL — the frozen host
// framework. This module is the in-repo builtins' PRIVATE extension of it,
// the same pattern as the tool protocol maps: tool-shaped seams the shell
// must not freeze (appdev feeds, pipelines verbs, host frame bodies) are
// typed here and consumed only by the builtin tools and the two hosts.
// =============================================================================

import type { ComponentType } from 'react';
import { useToolHost as useShellToolHost } from 'shell';
import type { ToolHostServices, ExplorerFileAction } from 'shell';
import type { AppListItem } from '../appdev/sidebarTypes';
import type { ProjectEntry } from '../pipelines/sidebar/types';

// The generic layer, re-exported so in-repo code keeps one import root.
export { ToolHostProvider, createLoopbackPeer } from 'shell';

/** The builtin tools' extended services — tool-shaped seams the shell
 *  deliberately does not freeze. */
export interface BuiltinToolServices extends ToolHostServices {
	/** File-management verbs on workspace paths (hosts with write access). */
	manageFile?: (action: 'rename' | 'delete' | 'createFolder' | 'createFile', path: string, newName?: string) => void | Promise<void>;
	/** Extra per-file actions for file trees (host-specific, e.g. Export). */
	fileActions?: ExplorerFileAction[];
	/** Runs/stops a pipeline source. */
	pipelineAction?: (action: 'run' | 'stop', filePath: string, sourceId: string, projectId?: string) => void;
	/** Starts the new-pipeline flow. */
	newPipeline?: () => void;
	/** Opens the status page for an ad-hoc (no local file) task. */
	openUnknownTask?: (projectId: string, sourceId: string, displayName: string) => void;
	/** The focused document key for list highlights (host-tracked).
	 *  TRANSITIONAL: duplicates DevToolProps.activeDocKey with weaker
	 *  semantics — tools should migrate to the per-mount prop. */
	activeDocKey?: string;
	/** HOST-VARIANT: the appdev working-copy STREAM — rocket-ui scans the
	 *  server store's .appdev tree; a host without it omits this and the
	 *  tool discovers over `workspaceFs` itself. */
	appdevApps?: { subscribe: (cb: (apps: AppListItem[]) => void) => () => void };
	/** HOST-VARIANT: the pipelines entry feed where the host's workspace
	 *  VIEW (staged files, virtual roots) defines what exists (rocket-ui).
	 *  Hosts without it omit this and the tool discovers over
	 *  `workspaceFs` itself. `subscribe` replays the current list. */
	pipelineEntries?: { subscribe: (cb: (entries: ProjectEntry[]) => void) => () => void; refresh: () => void };
	/** HOST-VARIANT: the appdev FRAME BODIES. The apps tool owns its document
	 *  identities (tool:apps/newapp, tool:apps/<appId>) and routes docKeys;
	 *  the builder/wizard internals are host adapters. A host without this
	 *  seam keeps its page routing and the tool falls back to openPage. */
	appdevFrames?: { builder: ComponentType<{ appId: string }>; newApp: ComponentType };
}

/**
 * The builtin tools' view of the enclosing realm's host services.
 *
 * @returns The extended services.
 */
export function useToolHost(): BuiltinToolServices {
	return useShellToolHost<BuiltinToolServices>();
}
