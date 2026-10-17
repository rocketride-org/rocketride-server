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
// TOOLS/CORE — the workspace-FS capability interface
// =============================================================================
//
// The generic file capability a host hands tool code: globs, bytes, and
// watches — nothing tool-shaped. Hosts implement it twice: direct access
// for code running in their own process, and an RPC client for tool
// controllers running in an isolated webview. Tool modules (tools/appdev,
// tools/pipelines, …) are written against this interface alone.
// =============================================================================

/** The workspace-FS capability a host provides to tool code. */
export interface IToolWorkspaceFs {
	/**
	 * Finds files by glob across the workspace.
	 *
	 * @param include - Include glob (e.g. '**​/*.rrapp').
	 * @param exclude - Optional exclude glob.
	 * @returns Absolute paths, host-native separators.
	 */
	findFiles(include: string, exclude?: string): Promise<string[]>;
	/**
	 * The open workspace folders' absolute root paths — what absolute result
	 * paths are made display-relative against.
	 *
	 * @returns The roots (possibly empty), host-native separators.
	 */
	workspaceRoots(): Promise<string[]>;
	/**
	 * Reads a file as UTF-8 text.
	 *
	 * @param path - Absolute path (must be inside the workspace).
	 * @returns The text.
	 */
	readTextFile(path: string): Promise<string>;
	/**
	 * Reads a file as base64, size-gated.
	 *
	 * @param path - Absolute path (must be inside the workspace).
	 * @param maxBytes - Files larger than this return null.
	 * @returns The base64 payload, or null (missing / too large).
	 */
	readFileBase64(path: string, maxBytes: number): Promise<string | null>;
	/**
	 * Watches globs for create/change/delete.
	 *
	 * @param globs - Include globs.
	 * @param onEvent - Receives each changed path (undebounced).
	 * @returns Unsubscribe.
	 */
	watch(globs: string[], onEvent: (path: string) => void): () => void;
}
