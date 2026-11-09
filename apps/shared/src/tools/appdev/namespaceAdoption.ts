// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Moving a `local.<name>` app into the organization's developer namespace.
 *
 * The scaffold names an app `local.<name>` when the org has no developer id
 * yet. Once the org registers one, the App Builder gates STORE and DEPLOY on
 * the id prefix, so the app has to become `<developerId>.<name>`. This module
 * is the host-agnostic part of that rename: which id the app moves to, and
 * the text rewrite of the files that carry the id. Hosts do the IO.
 *
 * Only `local.*` apps move. An id under another namespace belongs to another
 * org, and renaming it is not this action's call.
 */

import type { IAppBuilderHost } from './types';

/** The namespace the scaffold uses when the org has no developer id. */
export const LOCAL_NAMESPACE = 'local';

/** Developer-id grammar (mirrors the scaffold and the server). */
const DEVELOPER_RE = /^[a-z][a-z_]*$/;

/**
 * The id a `local.*` app takes in the org's developer namespace.
 *
 * @param appId - The app's current id (appManifest.id).
 * @param developerId - The org's registered developer id ('' / null = none).
 * @returns `<developerId>.<name>`, or null when the app is not under `local`
 *   or the developer id is missing, malformed, or `local` itself.
 */
export function adoptedAppId(appId: string, developerId: string | null | undefined): string | null {
	if (!developerId || developerId === LOCAL_NAMESPACE || !DEVELOPER_RE.test(developerId)) return null;
	const prefix = `${LOCAL_NAMESPACE}.`;
	if (!appId.startsWith(prefix) || appId.length === prefix.length) return null;
	return `${developerId}.${appId.slice(prefix.length)}`;
}

/** The files that carry an app's id, as text. Absent = the file does not exist. */
export interface AppIdentityFiles {
	/** The app's package.json (required: the appManifest lives there). */
	packageJson: string;
	/** The `<name>.rrapp` trigger (older scaffolds wrote `{ "id": ... }` into it). */
	trigger?: string;
	/** `src/AppDescriptor.ts` (the scaffold writes the id as a string literal). */
	descriptor?: string;
}

/** The result of {@link rewriteAppIdentity}. */
export interface AppIdentityRewrite {
	/** Rewritten texts; a key is present only when that file changes. */
	files: Partial<AppIdentityFiles>;
	/** One plain-language line per change, in file order. */
	changes: string[];
}

/** The npm package name the scaffold derives from an app id. */
function packageNameOf(appId: string): string {
	return appId.replace(/\./g, '-').toLowerCase();
}

/** Escapes a string for use inside a RegExp. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrites an app's id in the files that carry it.
 *
 * - package.json: `appManifest.id` always; `appManifest.publisher` and the
 *   package `name` only while they still hold the scaffold's values for the
 *   old id (a hand-picked value is the developer's and stays). Key order and
 *   indentation are kept.
 * - The `.rrapp` trigger: only when it is JSON carrying the old id.
 * - `src/AppDescriptor.ts`: every quoted string literal equal to the old id.
 *
 * Nothing else is edited: the folder, the projectId and the dev port do not
 * depend on the namespace, and the build's module id follows on its own
 * (rsbuild derives it from appManifest.id at build time).
 *
 * @param files - The current texts.
 * @param oldId - The app's current id.
 * @param newId - The id to move to.
 * @returns The changed texts and a line per change.
 * @throws Error when package.json is not JSON or no longer carries `oldId`.
 */
export function rewriteAppIdentity(files: AppIdentityFiles, oldId: string, newId: string): AppIdentityRewrite {
	const out: Partial<AppIdentityFiles> = {};
	const changes: string[] = [];

	// step: package.json, the identity of record
	let pkg: { name?: unknown; appManifest?: Record<string, unknown> };
	try {
		pkg = JSON.parse(files.packageJson) as typeof pkg;
	} catch (err) {
		throw new Error(`package.json is not valid JSON, so the app id cannot be changed (${err instanceof Error ? err.message : String(err)}).`);
	}
	const manifest = pkg.appManifest;
	if (!manifest || manifest.id !== oldId) {
		throw new Error(`package.json no longer names this app "${oldId}". Reopen the App Builder and try again.`);
	}
	manifest.id = newId;
	changes.push(`package.json: app id ${oldId} -> ${newId}`);
	const oldNs = oldId.split('.')[0];
	const newNs = newId.split('.')[0];
	if (manifest.publisher === oldNs) {
		manifest.publisher = newNs;
		changes.push(`package.json: publisher ${oldNs} -> ${newNs}`);
	}
	if (pkg.name === packageNameOf(oldId)) {
		pkg.name = packageNameOf(newId);
		changes.push(`package.json: package name ${packageNameOf(oldId)} -> ${packageNameOf(newId)}`);
	}
	const indent = files.packageJson.match(/\n([ \t]+)"/)?.[1] ?? '\t';
	const eol = files.packageJson.endsWith('\n') ? '\n' : '';
	out.packageJson = JSON.stringify(pkg, null, indent) + eol;

	// step: the trigger, when an older scaffold wrote the id into it
	if (files.trigger !== undefined) {
		try {
			const trigger = JSON.parse(files.trigger) as { id?: unknown } | null;
			if (trigger && typeof trigger === 'object' && trigger.id === oldId) {
				trigger.id = newId;
				out.trigger = `${JSON.stringify(trigger, null, 2)}\n`;
				changes.push(`.rrapp: app id ${oldId} -> ${newId}`);
			}
		} catch {
			// Not JSON: the trigger is contentless by contract, nothing to move.
		}
	}

	// step: the descriptor's id literal
	if (files.descriptor !== undefined) {
		const literal = new RegExp(`(['"\`])${escapeRegExp(oldId)}\\1`, 'g');
		let count = 0;
		const next = files.descriptor.replace(literal, (_match, quote: string) => {
			count += 1;
			return `${quote}${newId}${quote}`;
		});
		if (count > 0) {
			out.descriptor = next;
			changes.push(`src/AppDescriptor.ts: app id ${oldId} -> ${newId}`);
		}
	}

	return { files: out, changes };
}

/**
 * The host the App Builder views get: registering a developer id (the Deploy
 * tab's form) also reports the assigned id, so the screen's namespace gate
 * and banner update without reopening the App Builder.
 *
 * @param host - The host adapter.
 * @param onRegistered - Receives the developer id the server assigned.
 * @returns The same host when it cannot register; otherwise a copy whose
 *   registerDeveloper reports the result.
 */
export function withRegistrationReport(host: IAppBuilderHost, onRegistered: (developerId: string) => void): IAppBuilderHost {
	const register = host.registerDeveloper;
	if (!register) return host;
	return {
		...host,
		registerDeveloper: async (developerId) => {
			const assigned = await register(developerId);
			onRegistered(assigned);
			return assigned;
		},
	};
}
