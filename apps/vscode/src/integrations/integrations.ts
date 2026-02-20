// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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
 * Integration utilities for syncing documentation with AI coding assistants
 */

import * as vscode from 'vscode';
import { integrateCopilot } from './integrateCopilot';
import { integrateCursor } from './integrateCursor';

/**
 * Syncs documentation files based on integration settings
 * Each integration function handles its own IDE detection
 * Safe to call when no workspace is open - just returns early
 */
export async function syncIntegrations(copilotEnabled: boolean, cursorEnabled: boolean): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		// No workspace open - can't sync files, just return
		return;
	}

	const workspaceRoot = workspaceFolders[0].uri.fsPath;
	
	// Each integration function checks if it's running in the correct IDE
	// and handles sync/removal accordingly
	await integrateCopilot(workspaceRoot, copilotEnabled);
	await integrateCursor(workspaceRoot, cursorEnabled);
}
