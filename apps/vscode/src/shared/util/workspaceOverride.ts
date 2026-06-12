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

/**
 * The subset of `vscode.WorkspaceConfiguration.inspect()` we care about when
 * deciding whether a value we write to the user (Global) target will actually
 * take effect in the active window.
 *
 * Pulled out as a plain interface so the shadowing logic stays pure and unit
 * testable without a live VS Code instance.
 */
export interface WorkspaceInspection<T> {
	workspaceValue?: T;
	workspaceFolderValue?: T;
}

/** Structural equality good enough for config values (primitives + string[]). */
function valuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	// Arrays/objects (e.g. engineArgs lists) — compare by serialized shape.
	if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	return false;
}

/**
 * Whether a setting we are about to write to the user (Global) target is
 * shadowed by a *conflicting* workspace-level value.
 *
 * VS Code resolves a key as WorkspaceFolder > Workspace > Global, so when the
 * open workspace's `.vscode/settings.json` sets the same key to a different
 * value, the Global write succeeds but the effective (read-back) value does not
 * change — the UI appears to revert and user settings silently diverge.
 *
 * Returns true only when a workspace/workspace-folder value exists AND differs
 * from `desired`; an override that already matches what we are saving causes no
 * visible conflict and is intentionally not flagged.
 */
export function isShadowedByWorkspace<T>(info: WorkspaceInspection<T> | undefined, desired: T): boolean {
	if (!info) {
		return false;
	}
	// WorkspaceFolder is the narrowest scope and wins when present.
	const override = info.workspaceFolderValue !== undefined ? info.workspaceFolderValue : info.workspaceValue;
	if (override === undefined) {
		return false;
	}
	return !valuesEqual(override, desired);
}
