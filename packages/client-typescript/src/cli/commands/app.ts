/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * App lifecycle commands — the terminal twin of the App Builder:
 * `app create/verify/deploy/publish/unpublish/disable/versions/where/log/
 * submit/withdraw/reply` and `app developer status/register`.
 *
 * `app create` is a DEV-workspace operation (vendors from the development
 * server, reads the developer id off the development account). `app
 * verify` needs no connection. Every other verb is a DEPLOYMENT-TARGET verb
 * (ROCKETRIDE_DEPLOY_* pair, hard stop when absent).
 *
 * `[app]` arguments take an app folder, an app id (`personal.clock`), its
 * name part (`clock`), its folder name (`clock-ui`), or nothing (the
 * current directory is the app). A lone number is read as the version, so
 * `rocketride app publish 3` works from inside an app folder.
 */

import { Command } from 'commander';
import type { RocketRideClient } from '../../client/client';
import { parseRegistryVersion, pickPublishVersion } from '../../client/deploy-helpers';
import { addConnectionOptions, addDeployConnectionOptions, connectClient, connectDeploy, disconnectAll, formatWhen, onInterrupt, runCliCommand } from '../common';
import { openBrowser } from './auth';
import type { ConnectionOptions } from '../common';
import type { Output } from '../output';
import { toHttpBase } from '../../../../client-common/typescript/src/provision';

// =============================================================================
// APP CREATE
// =============================================================================

/** Parsed `app create` options. */
export interface AppCreateOptions extends ConnectionOptions {
	template?: string;
	name?: string;
	developer?: string;
	sidebar?: boolean;
	statusFooter?: boolean;
	docTabs?: boolean;
	workspace?: string;
	install?: boolean;
}

/**
 * Resolves the app id namespace for `app create` the way the App Builder's
 * New App wizard does: an explicit `--developer` wins; otherwise the
 * development account's `organization.developerId`; otherwise
 * DEFAULT_DEVELOPER_ID with a warning naming both ways out. Scaffolding
 * stays offline-capable — a missing key or an unreachable server is a
 * warning, never a failure.
 *
 * @param options - Parsed command options (`--developer`, dev pair).
 * @param out - Command output (warnings go to stderr).
 * @returns The developer id to scaffold under.
 */
async function resolveCreateDeveloperId(options: AppCreateOptions, out: Output): Promise<string> {
	const { DEFAULT_DEVELOPER_ID, resolveDeveloperId } = await import('../../app-pack/index.js');
	if (options.developer) return options.developer;

	const fallback = (why: string): string => {
		out.warn(`${why}; using '${DEFAULT_DEVELOPER_ID}' (run 'rocketride login', or pass --developer <id>)`);
		return DEFAULT_DEVELOPER_ID;
	};

	// step: no key = no account to ask
	if (!options.apikey) return fallback('no account credentials (ROCKETRIDE_APIKEY) to read a developer id from');

	// step: the developer id rides the auth response — one connect, no extra
	// call, closed before the scaffold so no idle socket outlives the read
	let developerId: string | null;
	try {
		developerId = resolveDeveloperId(await connectClient(options));
	} catch (err) {
		return fallback(`could not read the developer id from ${options.uri} (${err instanceof Error ? err.message : String(err)})`);
	} finally {
		await disconnectAll();
	}
	if (!developerId) return fallback('the connected account has no registered developer id');
	return developerId;
}

/**
 * The `app create` body: resolve the developer id, scaffold through the
 * SDK's one scaffold, and report.
 *
 * @param slug - The app-name slug.
 * @param options - Parsed command options.
 * @param out - Command output.
 * @returns The exit code.
 */
export async function executeAppCreate(slug: string, options: AppCreateOptions, out: Output): Promise<number> {
	const developerId = await resolveCreateDeveloperId(options, out);
	const { createAppWorkspace } = await import('../../app-pack/index.js');
	const serverBaseUrl = options.uri ? toHttpBase(String(options.uri)) : undefined;
	const created = await createAppWorkspace(options.workspace ?? process.cwd(), slug, {
		template: options.template as 'Blank' | 'Dashboard' | undefined,
		displayName: options.name,
		developerId,
		sidebar: Boolean(options.sidebar),
		statusFooter: options.statusFooter !== false,
		docTabs: Boolean(options.docTabs),
		install: options.install !== false,
		serverBaseUrl,
		onProgress: (line: string) => out.line(`  ${line}`),
	});
	out.line(`Created ${created.appId} at ${created.folder}`);
	out.line(`Open ${created.folder}/${slug}.rrapp in VS Code for the App Builder, or edit ${created.folder}/src/App.tsx directly.`);
	out.result({ appId: created.appId, folder: created.folder });
	return 0;
}

// =============================================================================
// SHARED
// =============================================================================

/** Options every `[app]` verb carries. */
export interface AppVerbOptions extends ConnectionOptions {
	workspace?: string;
}

/**
 * Splits `[app] [version]`: a lone numeric first argument is the version
 * (the app then comes from the current directory).
 *
 * @param app - The first positional (app reference or version).
 * @param version - The second positional.
 * @returns The app reference and version text, either possibly undefined.
 */
export function splitAppVersion(app?: string, version?: string): { app?: string; version?: string } {
	if (app !== undefined && version === undefined && /^v?\d+$/i.test(app)) return { version: app };
	return { app, version };
}

/**
 * Normalizes a publish target: '@me', '@public', '@team/<name-or-id>'. The
 * leading '@' may be omitted.
 *
 * @param target - The typed target.
 * @returns The wire target.
 * @throws Error on anything else.
 */
export function normalizePublishTarget(target: string): string {
	const wire = target.startsWith('@') ? target : `@${target}`;
	if (wire === '@me' || wire === '@public' || /^@team\/.+/.test(wire)) return wire;
	throw new Error(`Unknown publish target '${target}' — use @me, @team/<name>, or @public`);
}

/**
 * Resolves an `[app]` argument to its app id (and working copy, if local).
 *
 * @param ref - The typed reference (undefined = the current directory).
 * @param options - Carries `--workspace`.
 * @returns The resolved app.
 */
async function resolveApp(ref: string | undefined, options: AppVerbOptions): Promise<{ appId: string; folder?: string }> {
	const { findApp } = await import('../../app-pack/index.js');
	const found = await findApp(options.workspace ?? process.cwd(), ref);
	return { appId: found.appId, folder: found.app?.folder };
}

/**
 * The version a verb acts on: the typed one, else the newest version that
 * has not failed (the same pick the App Builder's rail makes by default).
 *
 * @param client - Connected deploy client.
 * @param appId - App id.
 * @param version - The typed version text, if any.
 * @returns The registry version.
 * @throws Error when no usable version exists.
 */
async function resolveVersion(client: RocketRideClient, appId: string, version: string | undefined): Promise<number> {
	if (version !== undefined) return parseRegistryVersion(version);
	const picked = pickPublishVersion(await client.listDeployments(appId));
	if (!picked) throw new Error(`${appId} has no deployed version that can be published — run 'rocketride app deploy' first`);
	return picked.registryVersion;
}

/**
 * Waits for a version's server build — publish and store submission both
 * refuse a version that is still building. Progress narrates on `out`.
 *
 * @param client - Connected deploy client.
 * @param appId - App id.
 * @param registryVersion - The version whose build to wait for.
 * @param out - Command output.
 */
async function waitForBuild(client: RocketRideClient, appId: string, registryVersion: number, out: Output): Promise<void> {
	await client.waitForAppBuild(appId, registryVersion, {
		onStatus: (status) => {
			if (status !== 'ok') out.line(`  build v${registryVersion}: ${status || 'pending'}...`);
		},
	});
}

/**
 * Waits for a version's server build, then binds it to the target — the
 * App Builder's Publish button. Build progress narrates on `out`.
 *
 * @param client - Connected deploy client.
 * @param appId - App id.
 * @param registryVersion - The version to publish.
 * @param target - Wire target ('@me', '@team/<x>', '@public').
 * @param out - Command output.
 * @returns The binding row.
 */
export async function publishWhenBuilt(client: RocketRideClient, appId: string, registryVersion: number, target: string, out: Output): Promise<Record<string, unknown>> {
	await waitForBuild(client, appId, registryVersion, out);
	const { publish } = await client.publishApp(appId, registryVersion, target);
	out.line(`Published ${appId} v${registryVersion} to ${target}.`);
	return publish;
}

// =============================================================================
// VERBS
// =============================================================================

/** Parsed `app deploy` options. */
export interface AppDeployOptions extends AppVerbOptions {
	comment?: string;
	verbose?: boolean;
	publish?: string;
}

/**
 * `app deploy`: pack the app's source, deploy it as the next registry
 * version, and optionally publish it once the server build finishes.
 *
 * @param ref - The `[app]` argument.
 * @param options - Parsed command options.
 * @param out - Command output.
 * @returns The exit code.
 */
export async function executeAppDeploy(ref: string | undefined, options: AppDeployOptions, out: Output): Promise<number> {
	const target = options.publish !== undefined ? normalizePublishTarget(options.publish) : undefined;
	const { appId, folder } = await resolveApp(ref, options);
	if (!folder) return out.fail(`${appId} has no working copy here to deploy`, 'pass the app folder');
	const client = await connectDeploy(options, out);
	if (!client) return 1;

	const result = await client.deploy.addApp(folder, {
		workspaceRoot: options.workspace ?? process.cwd(),
		comment: options.comment,
		onProgress: options.verbose ? (line: string) => out.line(`  ${line}`) : undefined,
	});
	// The app branch answers with the new rail entry
	const entry = result.artifact as { registryVersion?: number; appVersion?: string; buildStatus?: string } | undefined;
	const registryVersion = Number(entry?.registryVersion);
	out.line(`Deployed ${appId} v${entry?.registryVersion ?? '?'}${entry?.appVersion ? ` (app ${entry.appVersion})` : ''}; server build ${entry?.buildStatus || 'queued'}.`);

	let publish: Record<string, unknown> | undefined;
	if (target) {
		publish = await publishWhenBuilt(client, appId, parseRegistryVersion(registryVersion), target, out);
	} else {
		out.line(`Deploying activates nothing — publish it with: rocketride app publish ${appId} ${entry?.registryVersion ?? '<version>'} --to @me`);
	}
	out.result({ appId, registryVersion: entry?.registryVersion, appVersion: entry?.appVersion, buildStatus: entry?.buildStatus, ...(publish && { publish }) });
	return 0;
}

/** Parsed `app publish` options. */
export interface AppPublishOptions extends AppVerbOptions {
	to?: string;
}

/**
 * `app publish`: bind a version (default: the newest that has not failed,
 * waiting for its build) to an audience (default '@me').
 *
 * @param appArg - The `[app]` argument.
 * @param versionArg - The `[version]` argument.
 * @param options - Parsed command options.
 * @param out - Command output.
 * @returns The exit code.
 */
export async function executeAppPublish(appArg: string | undefined, versionArg: string | undefined, options: AppPublishOptions, out: Output): Promise<number> {
	const { app, version } = splitAppVersion(appArg, versionArg);
	const target = normalizePublishTarget(options.to ?? '@me');
	const { appId } = await resolveApp(app, options);
	const client = await connectDeploy(options, out);
	if (!client) return 1;
	const registryVersion = await resolveVersion(client, appId, version);
	const publish = await publishWhenBuilt(client, appId, registryVersion, target, out);
	out.result({ appId, registryVersion, target, publish });
	return 0;
}

/**
 * `app unpublish` / `app disable`: stop serving to an audience (remove
 * hides the binding, disable keeps it listed as switched off).
 *
 * @param verb - Which binding change.
 * @param ref - The `[app]` argument.
 * @param options - Parsed command options (`--from`).
 * @param out - Command output.
 * @returns The exit code.
 */
export async function executeAppUnbind(verb: 'unpublish' | 'disable', ref: string | undefined, options: AppVerbOptions & { from?: string }, out: Output): Promise<number> {
	if (!options.from) return out.fail(`--from <target> is required`, 'e.g. --from @me');
	const target = normalizePublishTarget(options.from);
	const { appId } = await resolveApp(ref, options);
	const client = await connectDeploy(options, out);
	if (!client) return 1;
	const { publish } = verb === 'unpublish' ? await client.removeAppPublish(appId, target) : await client.disableAppPublish(appId, target);
	out.line(`${verb === 'unpublish' ? 'Unpublished' : 'Disabled'} ${appId} on ${target}.`);
	out.result({ appId, target, publish });
	return 0;
}

/**
 * `app versions`: the version rail, newest first.
 *
 * @param ref - The `[app]` argument.
 * @param options - Parsed command options.
 * @param out - Command output.
 * @returns The exit code.
 */
export async function executeAppVersions(ref: string | undefined, options: AppVerbOptions, out: Output): Promise<number> {
	const { appId } = await resolveApp(ref, options);
	const client = await connectDeploy(options, out);
	if (!client) return 1;
	const rows = await client.listDeployments(appId);
	if (rows.length === 0) out.line(`${appId} has no deployed versions`);
	for (const row of rows) {
		const rungs = row.rungs.length > 0 ? `  live: ${row.rungs.join(', ')}` : '';
		out.line(`v${row.registryVersion}  ${row.appVersion || '-'}  ${row.state || '-'}  build ${row.buildStatus || '-'}  ${formatWhen(row.publishedAt)}${rungs}${row.message ? `  ${row.message}` : ''}`);
	}
	out.result({ appId, versions: rows });
	return 0;
}

/**
 * `app where`: which audiences serve which version.
 *
 * @param ref - The `[app]` argument.
 * @param options - Parsed command options.
 * @param out - Command output.
 * @returns The exit code.
 */
export async function executeAppWhere(ref: string | undefined, options: AppVerbOptions, out: Output): Promise<number> {
	const { appId } = await resolveApp(ref, options);
	const client = await connectDeploy(options, out);
	if (!client) return 1;
	const pins = await client.whereApp(appId);
	if (pins.length === 0) out.line(`${appId} is not published anywhere`);
	for (const pin of pins) {
		out.line(`${pin.rung}${pin.handle ? ` (${pin.handle})` : ''}  v${pin.version}  ${pin.appVersion || '-'}  ${pin.state || '-'}`);
	}
	out.result({ appId, pins });
	return 0;
}

/**
 * `app log`: one version's server build log (default: the newest version).
 *
 * @param appArg - The `[app]` argument.
 * @param versionArg - The `[version]` argument.
 * @param options - Parsed command options.
 * @param out - Command output.
 * @returns The exit code.
 */
export async function executeAppLog(appArg: string | undefined, versionArg: string | undefined, options: AppVerbOptions, out: Output): Promise<number> {
	const { app, version } = splitAppVersion(appArg, versionArg);
	const { appId } = await resolveApp(app, options);
	const client = await connectDeploy(options, out);
	if (!client) return 1;
	let registryVersion: number;
	if (version !== undefined) {
		registryVersion = parseRegistryVersion(version);
	} else {
		const newest = Math.max(0, ...(await client.listDeployments(appId)).map((r) => r.registryVersion));
		if (newest === 0) return out.fail(`${appId} has no deployed versions`);
		registryVersion = newest;
	}
	const result = await client.buildLog(appId, registryVersion);
	out.line(result.log || `(no build log for v${registryVersion})`);
	out.result(result);
	return 0;
}

/**
 * `app submit` / `app withdraw`: enter or leave store review.
 *
 * @param verb - Which review transition.
 * @param appArg - The `[app]` argument.
 * @param versionArg - The `[version]` argument.
 * @param options - Parsed command options.
 * @param out - Command output.
 * @returns The exit code.
 */
export async function executeAppReview(verb: 'submit' | 'withdraw', appArg: string | undefined, versionArg: string | undefined, options: AppVerbOptions, out: Output): Promise<number> {
	const { app, version } = splitAppVersion(appArg, versionArg);
	const { appId } = await resolveApp(app, options);
	const client = await connectDeploy(options, out);
	if (!client) return 1;
	const registryVersion = await resolveVersion(client, appId, version);
	// step: the server refuses to submit a version that is still building
	// (right after `app deploy`, the newest one is) — wait like publish does
	if (verb === 'submit') await waitForBuild(client, appId, registryVersion, out);
	const { artifact } = verb === 'submit' ? await client.submitApp(appId, registryVersion) : await client.withdrawApp(appId, registryVersion);
	out.line(`${verb === 'submit' ? 'Submitted' : 'Withdrew'} ${appId} v${registryVersion}${verb === 'submit' ? ' for store review' : ' from review'} (state ${String(artifact?.state ?? '?')}).`);
	out.result({ appId, registryVersion, artifact });
	return 0;
}

/**
 * `app reply`: a developer message on the app's review thread.
 *
 * @param appArg - The `[app]` argument.
 * @param versionArg - The `[version]` argument (the version the message
 *   refers to; positional like `submit`/`withdraw` — a `--version` option
 *   would be taken by the root program's own version flag).
 * @param options - Parsed command options (`--message`).
 * @param out - Command output.
 * @returns The exit code.
 */
export async function executeAppReply(appArg: string | undefined, versionArg: string | undefined, options: AppVerbOptions & { message?: string }, out: Output): Promise<number> {
	if (!options.message?.trim()) return out.fail('--message <text> is required');
	const { app, version } = splitAppVersion(appArg, versionArg);
	const { appId } = await resolveApp(app, options);
	const client = await connectDeploy(options, out);
	if (!client) return 1;
	const registryVersion = version !== undefined ? parseRegistryVersion(version) : undefined;
	const result = await client.replyApp(appId, options.message, registryVersion);
	out.line(`Replied on ${appId}'s review thread.`);
	out.result(result);
	return 0;
}

/**
 * `app verify`: the local, no-connection precheck — pack readiness, plus
 * the store-submission bar with `--store`.
 *
 * @param ref - The `[app]` argument.
 * @param options - Parsed command options (`--store`).
 * @param out - Command output.
 * @returns The exit code.
 */
export async function executeAppVerify(ref: string | undefined, options: AppVerbOptions & { store?: boolean }, out: Output): Promise<number> {
	const { verifyAppSource, preflightApp } = await import('../../app-pack/index.js');
	const { folder } = await resolveApp(ref, options);
	if (!folder) return out.fail(`"${ref}" has no working copy here to verify`, 'pass the app folder');
	const workspaceRoot = options.workspace ?? process.cwd();
	const report = verifyAppSource(workspaceRoot, folder);
	for (const check of report.checks) {
		out.line(`${check.ok ? 'OK  ' : 'FAIL'}  ${check.id}: ${check.note}`);
	}

	// step: the store tier — what a public submission adds on top
	let storeOk = true;
	const store = options.store ? (await preflightApp(folder, workspaceRoot)).filter((c) => c.tier === 'store') : [];
	for (const check of store) {
		out.line(`${check.state === 'fail' ? 'FAIL' : check.state === 'warn' ? 'WARN' : 'OK  '}  store ${check.id}: ${check.note ?? check.label}`);
		if (check.state === 'fail') storeOk = false;
	}

	const ok = report.ok && storeOk;
	out.line(ok ? `Ready to deploy${options.store ? ' and submit' : ''}: ${report.fileCount} files, ${report.uncompressedBytes} bytes uncompressed.` : 'Not ready - fix the FAIL lines above.');
	out.result({ ...report, ok, ...(options.store && { store }) });
	return ok ? 0 : 1;
}

/** Parsed `app dev` options. */
export interface AppDevOptions extends AppVerbOptions {
	open?: boolean;
	install?: boolean;
}

/**
 * `app dev`: the App Builder's dev loop in the foreground — serve the app
 * with `rsbuild dev`, point your personal dev overlay at it, and print the
 * preview URL. The preview updates on every save (rsbuild HMR/live reload).
 * Ctrl+C stops the server and drops the overlay. Uses the DEVELOPMENT
 * connection — dev bundles never touch the deployment target.
 *
 * @param ref - The `[app]` argument.
 * @param options - Parsed command options.
 * @param out - Command output.
 * @returns The exit code.
 */
export async function executeAppDev(ref: string | undefined, options: AppDevOptions, out: Output): Promise<number> {
	const { findApp } = await import('../../app-pack/index.js');
	const { DevSession, devPreviewUrl } = await import('../../app-dev/index.js');
	const workspaceRoot = options.workspace ?? process.cwd();
	const { app } = await findApp(workspaceRoot, ref);
	if (!app) return out.fail(`"${ref}" has no working copy here to serve`, 'pass the app folder');

	// step: one connection for the whole session — the overlay registration
	// lives as long as it, and a reconnect re-registers the running server
	let session: InstanceType<typeof DevSession> | null = null;
	const client = await connectClient(options, undefined, {
		persist: true,
		onConnected: async () => {
			await session?.reregister();
		},
	});

	const previewUrl = devPreviewUrl(toHttpBase(String(options.uri)), app.id);
	session = new DevSession({
		app,
		workspaceRoot,
		client,
		install: options.install !== false,
		onLine: (line) => out.line(`  ${line}`),
		onState: (state, detail) => {
			if (state === 'installing') out.line('Installing workspace dependencies (pnpm install)...');
			else if (state === 'ok') out.line(`Built${detail?.durationMs !== undefined ? ` in ${(detail.durationMs / 1000).toFixed(1)}s` : ''} — preview updates live.`);
			else if (state === 'error' && detail?.reason) out.warn(detail.reason);
		},
	});

	out.line(`Starting the dev server for ${app.id} (${app.folder})...`);
	const origin = await session.start();
	out.line(`Dev server: ${origin}`);
	out.line(`Preview:    ${previewUrl}`);
	out.line('Edit and save to update the preview. Press Ctrl+C to stop.');
	out.result({ appId: app.id, devOrigin: origin, previewUrl });
	if (options.open) openBrowser(previewUrl);

	// step: run until Ctrl+C, then stop the tree and drop the overlay
	await new Promise<void>((resolve) => {
		onInterrupt(() => {
			out.line('Stopping the dev server...');
			void session?.stop().finally(resolve);
		});
	});
	return 0;
}

// =============================================================================
// REGISTRATION
// =============================================================================

/**
 * Register the `app` command group on the program.
 *
 * @param program - The root commander program.
 */
export function registerAppCommands(program: Command): void {
	const appCmd = program
		.command('app')
		.description('Build, preview, deploy, and publish apps (the App Builder from the terminal)')
		.addHelpText(
			'after',
			`
[app] is an app folder (apps/clock-ui), an app id (personal.clock), its name
(clock), its folder name (clock-ui), or nothing (the current folder). A lone
number is read as the version: 'rocketride app publish 3'.

Connections: create and dev use the development connection (ROCKETRIDE_URI);
every other verb except verify uses the deployment target
(ROCKETRIDE_DEPLOY_URI) and never falls back to the development connection.

Examples:
  rocketride app create clock                        new app in ./apps/clock-ui
  rocketride app dev clock --open                    live preview; Ctrl+C stops
  rocketride app verify clock --store                local checks, incl. the store bar
  rocketride app deploy clock --publish @me          deploy, wait for the build, publish
  rocketride app versions clock                      version rail and where each is live
  rocketride app publish clock 2 --to @team/QA       publish a version to a team
  rocketride app unpublish clock --from @me          take it off your desktop
  rocketride app developer status                    your org's developer id

Removing an app: there is no hard delete; unpublish removes an audience binding
and keeps every version and its history. 'app where' lists each audience still
serving the app; a team or @public binding can keep it on your desktop.`,
		);
	const workspaceOption = '--workspace <dir>';
	const workspaceHelp = 'Workspace root apps are found in and the deploy zip is rooted at (default: current directory)';

	// ── app create ───────────────────────────────────────────────────────
	// Scaffold a new app — the same SDK scaffold as the App Builder wizard.
	// A DEV-workspace operation: vendoring reads the DEVELOPMENT server
	// (ROCKETRIDE_URI) and the developer id comes from that account.
	const createCmd = appCmd
		.command('create <slug>')
		.description('Scaffold a new app under ./apps/<slug>-ui (same scaffold as the App Builder wizard)')
		.option('--template <name>', 'Template: Blank or Dashboard', 'Blank')
		.option('--name <text>', 'Display name (default: title-cased slug)')
		.option('--developer <id>', "Developer id for <developerId>.<slug> (default: the connected account's, else 'local')")
		.option('--sidebar', 'Two-column layout with a navigation sidebar')
		.option('--no-status-footer', 'Omit the bottom status bar')
		.option('--doc-tabs', 'Document tab strip (Documents + DocTabs)')
		.option('--workspace <dir>', 'Workspace root (default: current directory)')
		.option('--no-install', 'Skip the workspace pnpm install')
		.action(async (slug, options) => {
			await runCliCommand(options, (out) => executeAppCreate(slug, options, out));
		});
	addConnectionOptions(createCmd);

	// ── app dev ──────────────────────────────────────────────────────────
	// The dev loop on the DEVELOPMENT connection (your personal overlay):
	// serve, register, print the preview URL, stop on Ctrl+C.
	const devCmd = appCmd
		.command('dev [app]')
		.description('Serve an app with live preview: rsbuild dev + your personal dev overlay (Ctrl+C stops)')
		.option('--open', 'Open the preview in your browser')
		.option('--no-install', 'Skip the workspace pnpm install')
		.option(workspaceOption, 'Workspace root the app is found in and pnpm install runs at (default: current directory)')
		.action(async (app, options) => {
			await runCliCommand(options, (out) => executeAppDev(app, options, out));
		});
	addConnectionOptions(devCmd);

	// ── app verify ───────────────────────────────────────────────────────
	// The no-side-effect precheck: everything `app deploy` needs, verified
	// locally with no server connection at all.
	appCmd
		.command('verify [app]')
		.description('Pre-check an app for deploy: manifest, id grammar, assets, includes, pack dry run')
		.option('--store', 'Also check the public store-submission bar (description, pricing plans)')
		.option(workspaceOption, workspaceHelp)
		.option('--json [file]', 'Output the result as a JSON value (to stdout, or to the given file)')
		.action(async (app, options) => {
			await runCliCommand(options, (out) => executeAppVerify(app, options, out));
		});

	// ── app deploy ───────────────────────────────────────────────────────
	// Deployment-target verbs below: read the ROCKETRIDE_DEPLOY_* pair; an
	// absent pair is an explicit stop — never a fallback to the dev pair.
	const deployCmd = appCmd
		.command('deploy [app]')
		.description("Pack an app's source and deploy it as the next registry version")
		.option('--comment <text>', 'What-changed note kept in the registry')
		.option('--publish <target>', 'After the server build finishes, publish to @me, @team/<name>, or @public')
		.option('--verbose', 'Narrate every pack step (include checks, per-file adds, totals)')
		.option(workspaceOption, workspaceHelp)
		.action(async (app, options) => {
			await runCliCommand(options, (out) => executeAppDeploy(app, options, out));
		});
	addDeployConnectionOptions(deployCmd);

	// ── app publish ──────────────────────────────────────────────────────
	const publishCmd = appCmd
		.command('publish [app] [version]')
		.description('Publish a version to an audience (default: newest version, to @me; waits for its build)')
		.option('--to <target>', '@me, @team/<name>, or @public', '@me')
		.option(workspaceOption, workspaceHelp)
		.action(async (app, version, options) => {
			await runCliCommand(options, (out) => executeAppPublish(app, version, options, out));
		});
	addDeployConnectionOptions(publishCmd);

	// ── app unpublish / disable ──────────────────────────────────────────
	for (const [verb, description] of [
		['unpublish', 'Remove an app from an audience; --from @me takes it off your desktop (versions and history survive; publish again to restore)'],
		['disable', "Switch an audience off but keep it listed as disabled (publish again to re-enable)"],
	] as const) {
		const cmd = appCmd
			.command(`${verb} [app]`)
			.description(description)
			.option('--from <target>', '@me, @team/<name>, or @public')
			.option(workspaceOption, workspaceHelp)
			.action(async (app, options) => {
				await runCliCommand(options, (out) => executeAppUnbind(verb, app, options, out));
			});
		addDeployConnectionOptions(cmd);
	}

	// ── app versions / where ─────────────────────────────────────────────
	const versionsCmd = appCmd
		.command('versions [app]')
		.description("List an app's deployed versions (newest first) with review state, build, and live audiences")
		.option(workspaceOption, workspaceHelp)
		.action(async (app, options) => {
			await runCliCommand(options, (out) => executeAppVersions(app, options, out));
		});
	addDeployConnectionOptions(versionsCmd);

	const whereCmd = appCmd
		.command('where [app]')
		.description('Show which audiences serve which version of an app')
		.option(workspaceOption, workspaceHelp)
		.action(async (app, options) => {
			await runCliCommand(options, (out) => executeAppWhere(app, options, out));
		});
	addDeployConnectionOptions(whereCmd);

	// ── app log ──────────────────────────────────────────────────────────
	const logCmd = appCmd
		.command('log [app] [version]')
		.description("Read a version's server build log (default: the newest version)")
		.option(workspaceOption, workspaceHelp)
		.action(async (app, version, options) => {
			await runCliCommand(options, (out) => executeAppLog(app, version, options, out));
		});
	addDeployConnectionOptions(logCmd);

	// ── app submit / withdraw / reply ────────────────────────────────────
	for (const [verb, description] of [
		['submit', 'Submit a version for store review (default: the newest version)'],
		['withdraw', 'Withdraw a version from store review (default: the newest version)'],
	] as const) {
		const cmd = appCmd
			.command(`${verb} [app] [version]`)
			.description(description)
			.option(workspaceOption, workspaceHelp)
			.action(async (app, version, options) => {
				await runCliCommand(options, (out) => executeAppReview(verb, app, version, options, out));
			});
		addDeployConnectionOptions(cmd);
	}

	const replyCmd = appCmd
		.command('reply [app] [version]')
		.description("Post a developer message on an app's store review thread (optionally about one version)")
		.option('-m, --message <text>', 'The message')
		.option(workspaceOption, workspaceHelp)
		.action(async (app, version, options) => {
			await runCliCommand(options, (out) => executeAppReply(app, version, options, out));
		});
	addDeployConnectionOptions(replyCmd);

	// ── app developer ────────────────────────────────────────────────────
	const developerCmd = appCmd.command('developer').description("Your organization's developer id (the <developerId> in app ids)");

	const developerStatusCmd = developerCmd
		.command('status')
		.description("Show the organization's registered developer id")
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const status = await client.developerStatus();
				out.line(status.developerId ? `Developer id: ${status.developerId}` : "No developer id registered — claim one with 'rocketride app developer register <id>'");
				out.result(status);
				return 0;
			});
		});
	addDeployConnectionOptions(developerStatusCmd);

	const developerRegisterCmd = developerCmd
		.command('register <id>')
		.description("Claim the organization's developer id (org admin; lowercase letters and underscores)")
		.action(async (id, options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const result = await client.registerDeveloper(id);
				out.line(`Registered developer id '${id}'. New apps are created as ${id}.<name>.`);
				out.result(result);
				return 0;
			});
		});
	addDeployConnectionOptions(developerRegisterCmd);
}
