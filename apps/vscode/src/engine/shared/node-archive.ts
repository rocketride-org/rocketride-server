// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * node-archive.ts — which node archive an installed server reads.
 *
 * A server's nodes/index.json names the release's node archive; EaaS reads it
 * from the nodes/ folder beside the engine directory.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * The node archive the server in engineDir reads, or null for a server whose
 * index names none (or that has no index): it carries all its nodes itself.
 */
export function nodeArchiveOf(engineDir: string): string | null {
	const indexPath = path.join(engineDir, 'nodes', 'index.json');
	if (!fs.existsSync(indexPath)) return null;
	const archive: unknown = JSON.parse(fs.readFileSync(indexPath, 'utf8')).archive;
	if (archive === undefined) return null;
	// The release's file name only: it is joined to the nodes/ folder, so '..' must not pass
	if (typeof archive !== 'string' || !/^rocketride-nodes-v[^/\\]+\.zip$/.test(archive)) {
		throw new Error(`The server's node index names an invalid node archive: ${JSON.stringify(archive)}`);
	}
	return archive;
}
