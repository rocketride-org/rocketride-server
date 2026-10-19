// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EXPLORER PROTOCOL — frames ask, the controller executes
// =============================================================================
//
// The tool's op vocabulary as a protocol map (shell `ToolOpMap` pattern):
// every server-store interaction the viewer frame needs, keyed by wire name,
// strict-typed end to end. Frames hold NO RocketRide client — the remote
// IExplorerFs (fs.ts) rides these to the tool's sidebar controller, which
// executes them on its single server connection. Connection reachability
// rides the shell's `host:connection` system topic.
// =============================================================================

import type { ToolOpMap, ToolOpSpec } from 'shell';

/** One directory entry of a listing. */
export interface ExplorerDirEntry {
	/** Entry name (no path). */
	name: string;
	/** Entry kind — matches the shell VFS contract. */
	type: 'dir' | 'file';
}

/** File metadata. */
export interface ExplorerStat {
	/** 'file' or 'dir'. */
	type?: string;
	/** Size in bytes (files). */
	size?: number;
}

/** The explorer's op map — private to this tool. */
export interface ExplorerOps extends ToolOpMap {
	/** Directory listing. */
	'explorer.listDir': ToolOpSpec<{ dir: string }, ExplorerDirEntry[]>;
	/** Read a text file. */
	'explorer.readString': ToolOpSpec<{ path: string }, string>;
	/** Presigned URL for the file's bytes (blob fetches and streaming viewers
	 *  — the fetch itself stays in the frame: plain HTTP, no connection). */
	'explorer.getUrl': ToolOpSpec<{ path: string }, string>;
	/** Write a text file. */
	'explorer.writeString': ToolOpSpec<{ path: string; content: string }, void>;
	/** Rename/move. */
	'explorer.rename': ToolOpSpec<{ oldPath: string; newPath: string }, void>;
	/** File metadata. */
	'explorer.stat': ToolOpSpec<{ path: string }, ExplorerStat>;
	/** Delete a file, or a directory recursively (the branch lives controller-side). */
	'explorer.remove': ToolOpSpec<{ path: string }, void>;
	/** Create a directory. */
	'explorer.mkdir': ToolOpSpec<{ path: string }, void>;
}
