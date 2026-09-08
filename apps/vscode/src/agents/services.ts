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
 * services.ts - Service Catalog Sync
 *
 * Syncs the server's service catalog to .rocketride/ in the workspace:
 *   1. Individual schema files:  .rocketride/schema/<component>.json
 *   2. Obsolete schema cleanup:  removes files not in the current catalog
 *   3. Master catalog:           .rocketride/services-catalog.json
 *
 * The sync itself lives in the client-common source library — the exact
 * code the CLI's `rocketride init` runs — so both provisioning paths
 * write identical catalogs. This module is the vscode-shaped adapter
 * (Uri + logger wiring).
 */

import * as vscode from 'vscode';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';
import { syncServiceCatalog as syncServiceCatalogCommon } from '../../../../packages/client-common/typescript/src/provision';

/**
 * Sync service catalog data to .rocketride/ when the server sends services.
 *
 * @param workspaceRoot - The workspace folder that owns .rocketride/.
 * @param services - The services map from the connected server.
 */
export async function syncServiceCatalog(workspaceRoot: vscode.Uri, services: Record<string, unknown>): Promise<void> {
	const logger = getLogger();
	syncServiceCatalogCommon(workspaceRoot.fsPath, services, (line) => logger.output(`${icons.info} ${line}`));
}
