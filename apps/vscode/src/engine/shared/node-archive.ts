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

/**
 * The node archive the server in engineDir reads and nodesDir does not hold, or null:
 * without it, the server cannot run the nodes it does not carry.
 */
export function missingNodeArchive(engineDir: string, nodesDir: string): string | null {
	const archive = nodeArchiveOf(engineDir);
	return archive && !fs.existsSync(path.join(nodesDir, archive)) ? archive : null;
}

/**
 * Renames src to dest, retrying while Windows holds a file just written (an antivirus scan),
 * as graceful-fs does for Windows renames.
 */
export async function renameRetrying(src: string, dest: string, delayMs = 500): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fs.promises.rename(src, dest);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? '';
			if (attempt >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw err;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

/**
 * Fetches a node archive into nodesDir: written under a staging name and renamed into place
 * once whole, so an archive that is there is complete. The staging file never stays behind.
 *
 * @param nodesDir - The nodes/ folder beside the engine directory.
 * @param archive - The archive's file name.
 * @param download - Writes the archive to the path it is given.
 * @param delayMs - The pause between tries of a rename Windows refuses.
 */
export async function fetchNodeArchive(nodesDir: string, archive: string, download: (dest: string) => Promise<void>, delayMs = 500): Promise<void> {
	fs.mkdirSync(nodesDir, { recursive: true });
	const staging = path.join(nodesDir, `${archive}.download`);
	try {
		await download(staging);
		// Retried as in a fresh install: a scanner may still hold the file just written
		await renameRetrying(staging, path.join(nodesDir, archive), delayMs);
	} finally {
		fs.rmSync(staging, { force: true });
	}
}

/**
 * Moves a staged release into place once all of it is downloaded: the server's files into
 * engineDir, already cleared, and its node archive, if it has one, into a fresh nodesDir.
 */
export async function commitStagedRelease(stagedEngine: string, engineDir: string, stagedArchive: string | null, nodesDir: string): Promise<void> {
	fs.mkdirSync(engineDir, { recursive: true });
	for (const entry of fs.readdirSync(stagedEngine)) {
		await renameRetrying(path.join(stagedEngine, entry), path.join(engineDir, entry));
	}
	// A prerelease and its release name the same archive, so the old one goes too
	fs.rmSync(nodesDir, { recursive: true, force: true });
	if (stagedArchive) {
		fs.mkdirSync(nodesDir, { recursive: true });
		await renameRetrying(stagedArchive, path.join(nodesDir, path.basename(stagedArchive)));
	}
}
