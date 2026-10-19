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
// TOOL HOST — host-wide capabilities a workbench hands its tools
// =============================================================================
//
// The host framework's second layer, beside the per-mount DevToolProps:
// HOST-WIDE services, provided once per realm via React context. A tool
// reads what it needs; a host contributes only capabilities it can state
// generically. Capabilities are a MENU: a tool must degrade gracefully
// when an optional capability is absent, and absence must FAIL SAFE (a
// missing `confirm` means no destructive action, never auto-confirm).
//
// This core interface is the frozen contract. In-repo builtin tools extend
// it with their tool-shaped seams in apps/shared (BuiltinToolServices) —
// the same private-extension pattern as the tool protocol maps.
//
// Page keys are DATA mapped by the host ('intro:<mode>', …); a host
// without a page for a key no-ops. Tool documents do NOT ride this
// surface — tools open their own via DevToolProps.documents.
// =============================================================================

import { createContext, useContext } from 'react';
import type { DevToolProps } from './types';
import type { PrefsStore } from './prefsStore';
import type { ToolWorkspaceFs } from './toolWorkspaceFs';

export type { ToolWorkspaceFs } from './toolWorkspaceFs';

// =============================================================================
// THE SERVICES CONTRACT
// =============================================================================

/** The generic, host-wide capabilities a workbench hands its tools. */
export interface ToolHostServices {
	/** Opens an embedded host page/document by key (see file header). */
	openPage: (key: string, title?: string) => void;
	/** Opens a workspace FILE in the host's editor surface. */
	openFile?: (path: string) => void;
	/** Workspace/store file access for tool discovery. */
	workspaceFs?: ToolWorkspaceFs;
	/** This tool's preference partition — PRE-SCOPED by the host (see
	 *  scopedPrefs): the handle physically cannot address another app's
	 *  keys, and system prefs are not reachable through it. */
	prefs?: PrefsStore;
	/** Subscription gate for run affordances. */
	isSubscribed?: boolean;
}

const ToolHostContext = createContext<ToolHostServices | null>(null);

/** The provider a host wraps its sidebar chrome in (one per realm; hosts
 *  may nest a second provider per tool to override `prefs` with that
 *  tool's scoped partition). */
export const ToolHostProvider = ToolHostContext.Provider;

/**
 * The host services for the enclosing realm. Throws without a provider —
 * tools only mount inside a host's chrome. In-repo builtin tools call this
 * with their extended services type.
 *
 * @returns The services.
 */
export function useToolHost<T extends ToolHostServices = ToolHostServices>(): T {
	const services = useContext(ToolHostContext);
	if (!services) throw new Error('useToolHost: no ToolHostProvider above this component.');
	return services as T;
}

// =============================================================================
// LOOPBACK PEER — for builtin mounts with no isolated counterpart
// =============================================================================

/**
 * A dead-simple in-realm peer for tool mounts that have no isolated
 * counterpart document: posts loop back to this realm's own subscribers,
 * asynchronously (matching the real transports' macrotask semantics).
 *
 * @returns The loopback peer.
 */
export function createLoopbackPeer(): DevToolProps['peer'] {
	const subs = new Set<(m: unknown) => void>();
	return {
		post: (message: unknown) => {
			setTimeout(() => { for (const cb of subs) cb(message); }, 0);
		},
		subscribe: (cb: (message: unknown) => void) => {
			subs.add(cb);
			return () => { subs.delete(cb); };
		},
	};
}
