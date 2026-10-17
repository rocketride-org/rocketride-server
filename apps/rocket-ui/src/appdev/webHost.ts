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
// WEB HOST — the DIRECT-MOUNT IAppBuilderHost over the live client
// =============================================================================

/**
 * The web App Builder host adapter: every accessor/action is a direct SDK
 * call on the shell's live client — no bridge, no RPC lane. This is
 * integration mode #1 from the appdev module's contract ("rocket-ui renders
 * <AppBuilderScreen host={adapter}> where the adapter wraps the live
 * client").
 *
 * Capability shape: no native files, no Code pane — the workspace
 * Explorer + file-editor tabs are the web host's code surface (the dev
 * session still runs headless underneath: its rebuild loop adopts those
 * tabs' saves off the notification bus and re-renders the preview). Debug
 * opens the preview in a NEW browser tab (same-origin — DevTools against
 * the real page), review ladder mirrors the server flavor.
 */

import { ConnectionManager } from 'shell';
import type { RocketRideClient } from 'shell';
import { projectListing, applyListing, probePackage, runListingPreflight, toRungPins, toVersionInfos, walkDeploymentHistory } from 'shared/modules/appdev';
import type { BuildStatusTick, IAppBuilderHost, WireHistoryRow, WirePin, WireRailEntry } from 'shared/modules/appdev';
import { appFileExists, readAppImageDataUri, readAppPackage, readAppText, writeAppPackage } from './appStore';
import { packAppSource } from './pack';
import type { WebDevSession } from './devSession';

// =============================================================================
// TYPES
// =============================================================================

/** Inputs for {@link createWebAppBuilderHost}. */
export interface WebHostOptions {
	/** The shell's live client. */
	client: RocketRideClient;
	/** The app id the screen shows. */
	appId: string;
	/** The app's folder name under .appdev. */
	folder: string;
	/** Whether the server runs the review ladder (SaaS). */
	hasReviewLadder: boolean;
	/** The preview URL (informational + the debug tab target). */
	previewUrl: string;
	/** The app's live dev session (null while it boots) — feeds + Code pane. */
	session: WebDevSession | null;
	/** Remount the preview iframe. */
	onReloadPreview: () => void;
	/** Open the linked preview in a new browser tab (the debug verb). */
	onOpenDebugTab: () => void;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Builds the web IAppBuilderHost for one app document.
 *
 * @param o - See {@link WebHostOptions}.
 * @returns The host adapter AppBuilderScreen mounts.
 */
export function createWebAppBuilderHost(o: WebHostOptions): IAppBuilderHost {
	const { client, appId, folder, hasReviewLadder, previewUrl, session, onReloadPreview, onOpenDebugTab } = o;

	// Per-app UI preference bag — localStorage IS the synchronous store the
	// getPref contract requires (VSCode pre-hydrates workspaceState; the
	// browser's storage read is already sync).
	const prefKey = (key: string): string => `rr:appdev:${appId}:${key}`;

	return {
		capabilities: {
			hasNativeFiles: false,
			canDebug: true,
			hasReviewLadder,
		},

		// ── Develop ──────────────────────────────────────────────────────
		// Console/errors/watch ride the dev session: preview consoles and
		// runtime errors forwarded by the embedded shell, linker states as
		// watch status, server build lines merged in by the provider.
		subscribeConsole: session ? (listener) => session.subscribeConsole(listener) : undefined,
		subscribeErrors: session ? (listener) => session.subscribeErrors(listener) : undefined,
		subscribeWatch: session ? (listener) => session.subscribeWatch(listener) : undefined,
		subscribeBuildStatus: (listener: (tick: BuildStatusTick) => void) => {
			// The server delivers DEPLOY-typed events only to connections that
			// monitored them — arm the wildcard monitor exactly like the other
			// deployment surfaces do (useDeployments.ts).
			client.addMonitor({ token: '*' }, ['deploy']).catch((err) => {
				console.error('[webHost] deploy monitor subscription failed:', err);
			});
			const unsub = ConnectionManager.getInstance().on('shell:event', ({ event }: { event: { event?: string; body?: { appId?: string; version?: number; status?: string } } }) => {
				if (event?.event !== 'apaevt_build_status') return;
				const body = event.body;
				if (!body || body.appId !== appId) return;
				listener({ version: body.version, status: body.status ?? '' });
			});
			return () => {
				unsub();
			};
		},
		reloadPreview: onReloadPreview,
		getPreviewUrl: () => previewUrl,
		// Debug = the LINKED preview in a first-class browser tab: the
		// provider adopts the tab as the injection target (same-origin
		// handle), so DevTools debugs the real linked app with sourcemapped
		// VFS frames.
		debug: onOpenDebugTab,
		getPref: (key: string) => {
			try {
				const raw = window.localStorage.getItem(prefKey(key));
				return raw === null ? undefined : (JSON.parse(raw) as unknown);
			} catch {
				return undefined;
			}
		},
		setPref: (key: string, value: unknown) => {
			try {
				window.localStorage.setItem(prefKey(key), JSON.stringify(value));
			} catch { /* storage full/unavailable — the pref just does not stick */ }
		},

		// ── Deploy (the publish ladder) — direct SDK calls ───────────────
		listVersions: async () => toVersionInfos((await client.listDeployments(appId)) as unknown as WireRailEntry[]),
		// DEPLOY = pack the VFS source, upload bytes; the server builds the
		// one true bundle (auto-enqueued on receipt). Progress streams back
		// through apaevt_build into the Console pane.
		deploy: async (message) => {
			session?.pushConsole('log', '[deploy] packing source...');
			const data = await packAppSource(client, folder);
			session?.pushConsole('log', `[deploy] uploading ${(data.byteLength / 1024).toFixed(0)} KB...`);
			await client.deploy.add({ kind: 'app', data, comment: message });
			session?.pushConsole('log', '[deploy] accepted — server build queued.');
		},
		publish: async (version, target) => {
			await client.publishApp(appId, version, target);
		},
		removePublish: async (target) => {
			await client.removeAppPublish(appId, target);
		},
		listTeams: async () => (client.getAccountInfo()?.organization?.teams ?? []).map((t) => ({ id: t.id, name: t.name })),
		getWhereLive: async () => toRungPins((await client.whereApp(appId)) as unknown as WirePin[], hasReviewLadder),
		loadBuildLog: async (version) => {
			const body = (await client.buildLog(appId, version)) as { log?: string } | undefined;
			return body?.log ?? '';
		},
		submitForReview: hasReviewLadder
			? async (version) => {
					await client.submitApp(appId, version);
				}
			: undefined,
		withdrawReview: hasReviewLadder
			? async (version) => {
					await client.withdrawApp(appId, version);
				}
			: undefined,
		getDeveloperId: async () => {
			const res = (await client.call('rrext_deploy_app', { subcommand: 'developer_status' })) as { developerId?: string | null } | undefined;
			return res?.developerId ?? '';
		},
		registerDeveloper: async (developerId) => {
			const res = (await client.call('rrext_deploy_app', { subcommand: 'developer_register', developerId })) as { developerId?: string } | undefined;
			return res?.developerId ?? developerId;
		},

		// ── Dashboard + review thread ────────────────────────────────────
		loadHistory: async () => walkDeploymentHistory(async (page, pageSize) => (await client.deploy.history(appId, { page, pageSize })) as { rows?: WireHistoryRow[]; total?: number } | undefined),
		sendReply: async (message, version) => {
			await client.replyApp(appId, message, version);
		},

		// ── Store — the listing IS the .appdev package.json appManifest ──
		loadListing: async () => {
			try {
				return projectListing(await readAppPackage(folder));
			} catch {
				return null;
			}
		},
		saveListing: async (draft) => {
			const pkg = await readAppPackage(folder);
			applyListing(pkg, draft);
			await writeAppPackage(folder, pkg);
		},
		runPreflight: async () => {
			// The SHARED tiered bar (one implementation for every host), fed
			// with this host's IO: store-VFS file existence + the live
			// dependency probe (the hard gate for Node-only packages).
			let pkg;
			try {
				pkg = await readAppPackage(folder);
			} catch {
				return runListingPreflight(null, { fileExists: async () => false });
			}
			return runListingPreflight(projectListing(pkg), {
				fileExists: (rel) => appFileExists(folder, rel),
				dependencies: (pkg.dependencies as Record<string, string> | undefined) ?? {},
				probeDependency: (name, range) => probePackage({ name, version: range }),
			});
		},
		// Manifest-asset previews ride the store VFS. The native pickers stay
		// unimplemented — a store-backed file picker is Phase 2 UI.
		readAppTextFile: async (relPath) => await readAppText(folder, relPath),
		readAppImageDataUri: async (relPath) => await readAppImageDataUri(client, folder, relPath),
	};
}
