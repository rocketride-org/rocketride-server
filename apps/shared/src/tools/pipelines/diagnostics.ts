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
// PIPELINES — per-source diagnostics ingress (host-pushed, tool-consumed)
// =============================================================================
//
// Per-source error/warning STATUS originates in host-side caches (the VS
// Code canvas editor's diagnostics) and is pushed here; the pipelines tool
// folds it into its task map. A tiny in-realm store so the host's message
// plumbing never reaches into the tool's React state.
// =============================================================================

/** One source's diagnostics update. */
export interface ISourceDiagnostics {
	projectId: string;
	sourceId: string;
	errors: string[];
	warnings: string[];
}

const subs = new Set<(update: ISourceDiagnostics) => void>();

/**
 * HOST side: pushes one source's diagnostics into the realm's pipelines
 * tool (no-op while the tool is not mounted).
 *
 * @param update - The diagnostics update.
 */
export function pushSourceDiagnostics(update: ISourceDiagnostics): void {
	subs.forEach((fn) => fn(update));
}

/**
 * TOOL side: subscribes to pushed diagnostics.
 *
 * @param cb - Receives each update.
 * @returns Unsubscribe.
 */
export function onSourceDiagnostics(cb: (update: ISourceDiagnostics) => void): () => void {
	subs.add(cb);
	return () => { subs.delete(cb); };
}
