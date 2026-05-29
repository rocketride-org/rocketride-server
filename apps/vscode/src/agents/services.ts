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
 * services.ts - VS Code adapter for service-catalog sync.
 *
 * Thin wrapper over @rocketride/agents-core's syncServiceCatalog. Converts the
 * vscode.Uri workspace root to a filesystem path and injects an output-channel
 * logger. The catalog-writing logic itself lives in core (shared with the CLI).
 */

import * as vscode from 'vscode';
import { syncServiceCatalog as coreSyncServiceCatalog } from '@rocketride/agents-core';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';

export async function syncServiceCatalog(workspaceRoot: vscode.Uri, services: Record<string, unknown>): Promise<void> {
	const out = getLogger();
	await coreSyncServiceCatalog(workspaceRoot.fsPath, services, (message) => out.output(`${icons.info} ${message}`));
}
