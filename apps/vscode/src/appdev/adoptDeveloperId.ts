// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Moves a `local.<name>` app folder into the org's developer namespace on
 * disk: the files that carry the app id are rewritten to
 * `<developerId>.<name>` (the text rewrite is shared, see
 * shared/tools/appdev/namespaceAdoption). Node fs only, no vscode import:
 * the host passes in what it reads from the server and the editor, so
 * node:test can run the whole move against a temp folder.
 */

import * as fs from 'fs';
import * as path from 'path';
import { markerPathOf } from 'rocketride/app-pack';
import { adoptedAppId, rewriteAppIdentity } from 'shared/tools/appdev/namespaceAdoption';

/** The result of a move. */
export interface AdoptedApp {
	/** The app's new id. */
	appId: string;
	/** One line per file change, for the output channel. */
	changes: string[];
}

/** What a move needs from the host, injected so it can be tested. */
export interface AdoptDeveloperIdDeps {
	/** The org's developer id as the server reports it now ('' = none). */
	developerStatus: () => Promise<string>;
	/** How many versions the server holds under an app id. */
	versionsOf: (appId: string) => Promise<number>;
	/** The workspace's bound apps. */
	scan: () => Promise<Array<{ id: string; folder: string }>>;
	/** Which of these absolute paths are open with unsaved edits. */
	dirtyPaths: (paths: string[]) => string[];
}

/** Reads a text file, or undefined when it does not exist. */
function readIfPresent(filePath: string): string | undefined {
	return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
}

/**
 * Replaces a file's content in one step: the text goes to a temp file next
 * to it, which is then renamed over it, so a crash or a full disk leaves
 * either the old file or the new one, never a truncated one. The original
 * file's mode is kept.
 *
 * @param filePath - The file to replace.
 * @param text - The new content.
 */
function writeAtomic(filePath: string, text: string): void {
	const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
	try {
		fs.writeFileSync(temp, text);
		if (fs.existsSync(filePath)) fs.chmodSync(temp, fs.statSync(filePath).mode);
		fs.renameSync(temp, filePath);
	} catch (err) {
		fs.rmSync(temp, { force: true });
		throw err;
	}
}

/**
 * The files a move may rewrite. The trigger keeps its name: it is named
 * after the part after the dot, which the move does not change.
 *
 * @param folder - The app's folder (absolute path).
 * @param appId - The app's current id.
 * @returns Absolute paths of package.json, the trigger and the descriptor.
 */
export function identityPathsOf(folder: string, appId: string): { packageJson: string; trigger: string; descriptor: string } {
	return {
		packageJson: path.join(folder, 'package.json'),
		trigger: markerPathOf(folder, appId),
		descriptor: path.join(folder, 'src', 'AppDescriptor.ts'),
	};
}

/**
 * The id a confirmed move goes to, checked against what the server says now.
 *
 * @param appId - The app's current id.
 * @param confirmedId - The developer id the user confirmed in the banner.
 * @param serverId - The org's developer id as the server reports it ('' = none).
 * @returns `<serverId>.<name>`.
 * @throws Error when the org has no id, the id changed since the user
 *   confirmed, or the app is not under `local`.
 */
export function confirmedTargetOf(appId: string, confirmedId: string, serverId: string): string {
	if (!serverId) throw new Error('Your organization has no developer id yet. Register one on the Deploy tab first.');
	if (serverId !== confirmedId) {
		throw new Error(`Your organization's developer id is now "${serverId}", not "${confirmedId}". Reopen the App Builder and try again.`);
	}
	const newId = adoptedAppId(appId, serverId);
	if (!newId) throw new Error(`Only an app under "local" can move into the "${serverId}" namespace; this one is "${appId}".`);
	return newId;
}

/**
 * Refuses a move onto an id that is already in use, or over unsaved edits.
 *
 * @param newId - The id the app would move to.
 * @param facts - Ids of the workspace's apps, how many versions the server
 *   holds under `newId`, and which target files have unsaved edits.
 * @throws Error naming the first reason the move cannot go ahead.
 */
export function assertTargetFree(newId: string, facts: { workspaceIds: string[]; deployedVersions: number; dirtyFiles: string[] }): void {
	if (facts.workspaceIds.includes(newId)) {
		throw new Error(`Another app in this workspace already has the id "${newId}". Rename one of them first.`);
	}
	if (facts.deployedVersions > 0) {
		throw new Error(`Your organization already has an app "${newId}" on the server. If a teammate already moved this app, pull their change; otherwise change the name part of this app's id first.`);
	}
	if (facts.dirtyFiles.length > 0) {
		throw new Error(`Save or revert your changes to ${facts.dirtyFiles.map((f) => path.basename(f)).join(', ')} first.`);
	}
}

/**
 * Rewrites the app id in one app folder.
 *
 * Each file is replaced atomically, and package.json goes LAST: a failure
 * part way leaves package.json, and so the app, on its old id, and a retry
 * finishes the job (the other rewrites only touch text that still holds
 * the old id).
 *
 * @param folder - The app's folder (absolute path).
 * @param oldId - The app's current id, `local.<name>`.
 * @param developerId - The org's registered developer id.
 * @returns The new id and what changed.
 * @throws Error when the app is not under `local`, or package.json no
 *   longer names `oldId`.
 */
export function adoptDeveloperIdInFolder(folder: string, oldId: string, developerId: string): AdoptedApp {
	const newId = adoptedAppId(oldId, developerId);
	if (!newId) {
		throw new Error(`Only an app under "local" can move into the "${developerId}" namespace; this one is "${oldId}".`);
	}

	const paths = identityPathsOf(folder, oldId);
	const rewrite = rewriteAppIdentity({ packageJson: fs.readFileSync(paths.packageJson, 'utf8'), trigger: readIfPresent(paths.trigger), descriptor: readIfPresent(paths.descriptor) }, oldId, newId);

	if (rewrite.files.trigger !== undefined) writeAtomic(paths.trigger, rewrite.files.trigger);
	if (rewrite.files.descriptor !== undefined) writeAtomic(paths.descriptor, rewrite.files.descriptor);
	if (rewrite.files.packageJson !== undefined) writeAtomic(paths.packageJson, rewrite.files.packageJson);
	return { appId: newId, changes: rewrite.changes };
}

/**
 * The whole move behind the banner's confirmation: every check first, then
 * the rewrite. A refusal writes nothing.
 *
 * @param appId - The app's current id.
 * @param confirmedId - The developer id the user confirmed.
 * @param deps - What the host reads from the server and the editor.
 * @returns The new id, what changed, and the app's folder.
 * @throws Error naming why the move cannot go ahead.
 */
export async function adoptDeveloperId(appId: string, confirmedId: string, deps: AdoptDeveloperIdDeps): Promise<AdoptedApp & { folder: string }> {
	const newId = confirmedTargetOf(appId, confirmedId, await deps.developerStatus());
	// The new id must be free in this workspace (the scan keeps one folder
	// per id) and on the server (deploys would join that app).
	const apps = await deps.scan();
	const app = apps.find((a) => a.id === appId);
	if (!app) throw new Error(`App "${appId}" has no bound folder in this workspace.`);
	assertTargetFree(newId, {
		workspaceIds: apps.map((a) => a.id),
		deployedVersions: await deps.versionsOf(newId),
		dirtyFiles: deps.dirtyPaths(Object.values(identityPathsOf(app.folder, appId))),
	});
	return { ...adoptDeveloperIdInFolder(app.folder, appId, confirmedId), folder: app.folder };
}
