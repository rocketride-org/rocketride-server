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
// PREFS BAG — the extension host's storage for the shell prefs-store seam
// =============================================================================
//
// ONE Memento bag per durability scope ('rr.prefs' in workspaceState and
// globalState) backing every webview's bridged PrefsStore. Each webview
// provider seeds its realm with the merged snapshot (global under
// workspace; workspace wins) in its view:ready reply — BEFORE any consumer
// mounts — and persists `prefs:set` writes here. The wire shape is the
// generic prefs channel: `prefs:init { values }` down, `prefs:set { key,
// value, scope }` up.
// =============================================================================

import * as vscode from 'vscode';

/** Memento key holding the generic prefs bag in each scope. */
const PREFS_BAG_KEY = 'rr.prefs';

/**
 * The merged prefs snapshot for seeding a webview realm: the global bag
 * under the workspace bag (workspace wins).
 *
 * @param context - The extension context owning both mementos.
 * @returns The merged values.
 */
export function readPrefsSnapshot(context: vscode.ExtensionContext): Record<string, unknown> {
	const workspace = context.workspaceState.get<Record<string, unknown>>(PREFS_BAG_KEY) ?? {};
	const global = context.globalState.get<Record<string, unknown>>(PREFS_BAG_KEY) ?? {};
	return { ...global, ...workspace };
}

/**
 * Persists one prefs-store write into the bag for its scope
 * (fire-and-forget, like every prefs write).
 *
 * @param context - The extension context owning both mementos.
 * @param key - The (partitioned) key.
 * @param value - The value to store verbatim.
 * @param scope - Which memento the key lives in.
 */
export function writePref(context: vscode.ExtensionContext, key: string, value: unknown, scope: 'workspace' | 'global'): Thenable<void> {
	const memento = scope === 'global' ? context.globalState : context.workspaceState;
	const bag = { ...(memento.get<Record<string, unknown>>(PREFS_BAG_KEY) ?? {}) };
	bag[key] = value;
	return memento.update(PREFS_BAG_KEY, bag);
}

/**
 * One key's current value, workspace bag over global bag.
 *
 * @param context - The extension context owning both mementos.
 * @param key - The key to read.
 * @returns The value, or undefined when unset in both scopes.
 */
export function readPref<T>(context: vscode.ExtensionContext, key: string): T | undefined {
	const workspace = context.workspaceState.get<Record<string, unknown>>(PREFS_BAG_KEY) ?? {};
	if (key in workspace) return workspace[key] as T;
	const global = context.globalState.get<Record<string, unknown>>(PREFS_BAG_KEY) ?? {};
	return global[key] as T | undefined;
}
