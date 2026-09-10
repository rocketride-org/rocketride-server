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
 * Node distribution commands: `node versions/deploy/where/disable/remove`.
 *
 * Publishing a node version is NOT here — it rides the generic rail as
 * `deploy add <file> --kind node`, which carries the zip. These are the
 * verbs that control one once it is on the registry, the same split apps
 * use: one door to put code on the server, one surface to control it.
 *
 * All of them are DEPLOYMENT-TARGET verbs: they read the ROCKETRIDE_DEPLOY_*
 * pair, and an absent pair is a stop rather than a fall back to the
 * development connection.
 */

import { Command } from 'commander';
import { RocketRideClient } from '../../client/client';
import { Output } from '../output';
import { addDeployConnectionOptions, connectClient, runCliCommand, ConnectionOptions } from '../common';
import { NO_DEPLOY_TARGET_MESSAGE } from '../env';

/**
 * Connect for a lifecycle verb, or stop.
 *
 * An absent deployment target is an explicit stop: these verbs must never
 * fall back to the development connection as a guess about where a node was
 * meant to go.
 *
 * @param options - Parsed connection options.
 * @param out - The command's output channel.
 * @returns A connected client, or null once the failure is reported.
 */
async function connectDeploy(options: ConnectionOptions, out: Output): Promise<RocketRideClient | null> {
	if (!options.uri) {
		out.fail(NO_DEPLOY_TARGET_MESSAGE);
		return null;
	}
	return connectClient(options);
}

/**
 * One audience, rendered the way a person reads it back.
 *
 * @param audience - The audience object a binding carries.
 * @returns '@me', '@team/<id>' or '@public'.
 */
function formatAudience(audience: Record<string, unknown> | undefined): string {
	const type = String(audience?.type || '');
	if (type === 'user') return '@me';
	if (type === 'public') return '@public';
	if (type === 'team') return `@team/${String(audience?.id || '')}`;
	return type || '?';
}

/**
 * Register the `node` command group on the program.
 *
 * @param program - The root commander program.
 */
export function registerNodeCommands(program: Command): void {
	const nodeCmd = program.command('node').description('Node distribution operations (deployment target)');

	// ── node versions ────────────────────────────────────────────────────
	const versionsCmd = nodeCmd
		.command('versions <nodeId>')
		.description("List a node's registry versions, newest first")
		.action(async (nodeId, options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const body = await client.deploy.nodeVersions(nodeId);
				const rows = body.versions || [];
				if (rows.length === 0) {
					out.line(`No versions published for ${nodeId}`);
				} else {
					out.line(`${rows.length} version(s) of ${nodeId}:`);
					for (const row of rows) {
						// The registry number is the handle every other verb
						// takes; the node's own version is display only, and
						// two rows can carry the same one.
						const own = row.nodeVersion ? `  (${String(row.nodeVersion)})` : '';
						const who = row.author ? `  by ${String(row.author)}` : '';
						const note = row.message ? `  ${String(row.message)}` : '';
						out.line(`v${String(row.registryVersion ?? '?')}${own}  ${String(row.state ?? '')}${who}${note}`);
					}
				}
				out.result({ versions: rows });
				return 0;
			});
		});
	addDeployConnectionOptions(versionsCmd);

	// ── node deploy ──────────────────────────────────────────────────────
	const deployCmd = nodeCmd
		.command('deploy <nodeId> <version>')
		.description('Point an audience at a registry version (first release, update and rollback are all this)')
		.option('--target <target>', "'@me', '@team/<name-or-id>' or '@public'", '@me')
		.action(async (nodeId, version, options) => {
			await runCliCommand(options, async (out) => {
				const registryVersion = Number(version);
				if (!Number.isInteger(registryVersion)) {
					return out.fail(`'${String(version)}' is not a registry version number`, 'use the number from `node versions`');
				}
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const body = await client.deploy.nodeDeploy(nodeId, registryVersion, options.target);
				out.line(`${nodeId} v${registryVersion} → ${formatAudience(body.audience as Record<string, unknown>)}`);
				out.result(body);
				return 0;
			});
		});
	addDeployConnectionOptions(deployCmd);

	// ── node where ───────────────────────────────────────────────────────
	const whereCmd = nodeCmd
		.command('where <nodeId>')
		.description('Show which audience holds which version')
		.action(async (nodeId, options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const body = await client.deploy.nodeWhere(nodeId);
				const pins = body.pins || [];
				if (pins.length === 0) {
					out.line(`${nodeId} is not reachable by anyone yet`);
				} else {
					for (const pin of pins) {
						out.line(`${formatAudience(pin.audience as Record<string, unknown>)}  v${String(pin.version ?? '?')}  ${String(pin.state ?? '')}`);
					}
				}
				out.result({ pins });
				return 0;
			});
		});
	addDeployConnectionOptions(whereCmd);

	// ── node disable / node remove ───────────────────────────────────────
	// Both act on the BINDING, never the version: a published version is
	// immutable and stays on the registry, which is what keeps rollback
	// possible after a withdrawal.
	for (const mode of ['disable', 'remove'] as const) {
		const withdrawCmd = nodeCmd
			.command(`${mode} <nodeId>`)
			.description(mode === 'disable' ? 'Stop serving one binding (reversible — deploy again and it is back)' : 'Take a binding out of the listing')
			.option('--target <target>', "Audience to withdraw from, or '@all' for every one it has", '@me')
			.action(async (nodeId, options) => {
				await runCliCommand(options, async (out) => {
					const client = await connectDeploy(options, out);
					if (!client) return 1;
					const body = await client.deploy.nodeWithdraw(nodeId, options.target, mode);
					const audiences = body.audiences as Record<string, unknown>[] | undefined;
					if (audiences) {
						// '@all' answers with every audience it withdrew from.
						out.line(audiences.length === 0 ? `${nodeId} had no bindings to withdraw` : `${mode}d ${nodeId} for ${audiences.map(formatAudience).join(', ')}`);
					} else {
						out.line(`${mode}d ${nodeId} for ${formatAudience(body.audience as Record<string, unknown>)}`);
					}
					out.result(body);
					return 0;
				});
			});
		addDeployConnectionOptions(withdrawCmd);
	}
}
