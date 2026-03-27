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
 */

import * as vscode from 'vscode';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';

/**
 * Write a file only if content has actually changed (line-ending normalized).
 */
async function writeIfChanged(uri: vscode.Uri, content: string): Promise<boolean> {
	try {
		const existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		if (existing.replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n')) {
			return false;
		}
	} catch {
		// File doesn't exist — will create
	}
	await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
	return true;
}

/**
 * Extract the first sentence from an HTML description string.
 */
function firstSentence(description: string | undefined): string {
	if (!description) return '';
	// Strip HTML tags
	const text = description.replace(/<[^>]*>/g, '').trim();
	// Take first sentence (ends with . ! or ?)
	const match = text.match(/^[^.!?]*[.!?]/);
	return match ? match[0].trim() : text;
}

/**
 * Sanitize a service name so it is safe to use as a filename.
 * Only `[a-zA-Z0-9._-]` characters are kept; everything else is replaced with `_`.
 * Each leading dot is replaced individually to preserve name uniqueness.
 */
function sanitizeServiceName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, (match) => '_'.repeat(match.length));
}

/**
 * Return true only when `child` is strictly inside `parent` (same scheme + authority,
 * and child path starts with parent path followed by a `/`).
 * Used as a defense-in-depth guard after name sanitization.
 */
function isUnderDirectory(parent: vscode.Uri, child: vscode.Uri): boolean {
	if (child.scheme !== parent.scheme || child.authority !== parent.authority) {
		return false;
	}
	const parentPath = parent.path.endsWith('/') ? parent.path : parent.path + '/';
	return child.path.startsWith(parentPath);
}

/**
 * Sync service catalog data to .rocketride/ when the server sends services.
 *
 * 1. Write individual schema files: .rocketride/schema/<component>.json
 * 2. Remove obsolete schema files not in the current catalog
 * 3. Write master catalog: .rocketride/services-catalog.json
 */
export async function syncServiceCatalog(workspaceRoot: vscode.Uri, services: Record<string, unknown>): Promise<void> {
	const schemaDir = vscode.Uri.joinPath(workspaceRoot, '.rocketride', 'schema');
	await vscode.workspace.fs.createDirectory(schemaDir);

	const logger = getLogger();
	const serviceNames = Object.keys(services);

	// Step 1: Write individual schema files; track written filenames for cleanup.
	const expectedFiles = new Set<string>();
	for (const name of serviceNames) {
		const safeName = sanitizeServiceName(name);
		const schemaUri = vscode.Uri.joinPath(schemaDir, `${safeName}.json`);
		// Defense-in-depth: verify the resolved path is still within schemaDir.
		if (!isUnderDirectory(schemaDir, schemaUri)) {
			logger.output(`${icons.info} Skipped schema write for unsafe service name: ${name}`);
			continue;
		}
		expectedFiles.add(`${safeName}.json`);
		const json = JSON.stringify(services[name], null, 2);
		await writeIfChanged(schemaUri, json);
	}

	// Step 2: Remove obsolete schema files
	try {
		const entries = await vscode.workspace.fs.readDirectory(schemaDir);
		for (const [fileName, fileType] of entries) {
			if (fileType === vscode.FileType.File && !expectedFiles.has(fileName)) {
				await vscode.workspace.fs.delete(vscode.Uri.joinPath(schemaDir, fileName));
				logger.output(`${icons.info} Removed obsolete schema: ${fileName}`);
			}
		}
	} catch {
		// Directory listing failed — first run, nothing to clean
	}

	// Step 3: Build and write master catalog
	const catalog = serviceNames.map((name) => {
		const svc = services[name] as Record<string, unknown>;
		const entry: Record<string, unknown> = {
			name,
			classType: svc.classType ?? [],
			description: firstSentence(svc.description as string | undefined),
			lanes: svc.lanes ?? {},
		};
		if (svc.invoke !== undefined) {
			entry.invoke = svc.invoke;
		}
		return entry;
	});

	const catalogUri = vscode.Uri.joinPath(workspaceRoot, '.rocketride', 'services-catalog.json');
	await writeIfChanged(catalogUri, JSON.stringify(catalog, null, 2));
}
