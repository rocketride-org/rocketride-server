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
 * App lifecycle commands: `app create/deploy/verify`.
 *
 * `app deploy` is a DEPLOYMENT-TARGET verb (ROCKETRIDE_DEPLOY_* pair,
 * hard stop when absent). `app create` is a DEV-workspace operation that
 * vendors platform packages from the development server. `app verify`
 * needs no connection at all.
 */

import { Command } from 'commander';
import { addConnectionOptions, addDeployConnectionOptions, connectClient, runCliCommand } from '../common';
import { NO_DEPLOY_TARGET_MESSAGE } from '../env';
import { toHttpBase } from '../../../../client-common/typescript/src/provision';

/**
 * Register the `app` command group on the program.
 *
 * @param program - The root commander program.
 */
export function registerAppCommands(program: Command): void {
	const appCmd = program.command('app').description('App lifecycle operations');

	// ── app deploy ───────────────────────────────────────────────────────
	// Deployment-target verb: reads the ROCKETRIDE_DEPLOY_* pair and an
	// absent pair is an explicit stop — lifecycle verbs must never fall
	// back to the development connection as a guess.
	const deployCmd = appCmd
		.command('deploy <folder>')
		.description("Pack an app folder's source and deploy it as the next registry version")
		.option('--workspace <dir>', 'Workspace root the zip is rooted at; include entries resolve against it (default: current directory)')
		.option('--comment <text>', 'What-changed note kept in the registry')
		.option('--verbose', 'Narrate every pack step (include checks, per-file adds, totals)')
		.action(async (folder, options) => {
			await runCliCommand(options, async (out) => {
				if (!options.uri) {
					return out.fail(NO_DEPLOY_TARGET_MESSAGE);
				}
				const client = await connectClient(options);
				const result = await client.deploy.addApp(folder, {
					workspaceRoot: options.workspace,
					comment: options.comment,
					onProgress: options.verbose ? (line: string) => out.line(`  ${line}`) : undefined,
				});
				const artifact = result.artifact as { projectId?: string; version?: number; name?: string } | undefined;
				out.line(`Deployed app version v${artifact?.version ?? '?'}${artifact?.name ? ` (${artifact.name})` : ''}`);
				if (artifact?.projectId) {
					out.line(`Project: ${artifact.projectId}`);
				}
				out.line('Deploying activates nothing - publish a rung to serve it.');
				out.result({ projectId: artifact?.projectId, version: artifact?.version, name: artifact?.name });
				return 0;
			});
		});
	addDeployConnectionOptions(deployCmd);

	// ── app create ───────────────────────────────────────────────────────
	// Scaffold a new app — the programmatic twin of the App Builder
	// wizard. A DEV-workspace operation: vendoring reads the DEVELOPMENT
	// server (ROCKETRIDE_URI), no DAP connection needed.
	const createCmd = appCmd
		.command('create <slug>')
		.description('Scaffold a new app under ./apps/<slug> (same templates as the App Builder wizard)')
		.option('--template <name>', 'Template: Blank or Dashboard', 'Blank')
		.option('--name <text>', 'Display name (default: title-cased slug)')
		.option('--developer <id>', "Developer id for <developerId>.<slug> (default: 'local')")
		.option('--sidebar', 'Two-column layout with a navigation sidebar')
		.option('--no-status-footer', 'Omit the bottom status bar')
		.option('--doc-tabs', 'Document tab strip (Documents + DocTabs)')
		.option('--workspace <dir>', 'Workspace root (default: current directory)')
		.option('--no-install', 'Skip the workspace pnpm install')
		.action(async (slug, options) => {
			await runCliCommand(options, async (out) => {
				const { createAppWorkspace } = await import('../../app-pack/index.js');
				const serverBaseUrl = options.uri ? toHttpBase(String(options.uri)) : undefined;
				const created = await createAppWorkspace(options.workspace ?? process.cwd(), slug, {
					template: options.template,
					displayName: options.name,
					developerId: options.developer,
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
			});
		});
	addConnectionOptions(createCmd);

	// ── app verify ───────────────────────────────────────────────────────
	// The no-side-effect precheck: everything `app deploy` needs, verified
	// locally with no server connection at all.
	appCmd
		.command('verify <folder>')
		.description('Pre-check an app folder for deploy: manifest, id grammar, assets, includes, pack dry run')
		.option('--workspace <dir>', 'Workspace root the pack would be rooted at (default: current directory)')
		.option('--json [file]', 'Output the result as a JSON value (to stdout, or to the given file)')
		.action(async (folder, options) => {
			await runCliCommand(options, async (out) => {
				const { verifyAppSource } = await import('../../app-pack/index.js');
				const report = verifyAppSource(options.workspace ?? process.cwd(), folder);
				for (const check of report.checks) {
					out.line(`${check.ok ? 'OK  ' : 'FAIL'}  ${check.id}: ${check.note}`);
				}
				out.line(report.ok ? `Ready to deploy: ${report.fileCount} files, ${report.uncompressedBytes} bytes uncompressed.` : 'Not ready - fix the FAIL lines above.');
				out.result(report);
				return report.ok ? 0 : 1;
			});
		});
}
