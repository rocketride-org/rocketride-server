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
 * Deploy lifecycle commands: `deploy add/list/get/versions/history/
 * publish/run/artifact/enable/disable/remove/log` plus the `deploy
 * schedule` subgroup.
 *
 * CLI verbs follow the platform vocabulary — deploy = version to server,
 * publish = bind to a rung — regardless of SDK method names. Every verb
 * here targets the DEPLOYMENT connection (ROCKETRIDE_DEPLOY_* pair) and
 * hard-stops when it is absent: the development connection is never a
 * deploy fallback.
 */

import * as fs from 'fs';
import { Command } from 'commander';
import { RocketRideClient } from '../../client/client';
import { Deployment, DeployHistoryEntry } from '../../client/types';
import { Output } from '../output';
import { addDeployConnectionOptions, connectClient, runCliCommand, formatWhen, ConnectionOptions } from '../common';
import { NO_DEPLOY_TARGET_MESSAGE } from '../env';

/**
 * Connect to the deployment target, enforcing the hard stop.
 *
 * @param options - Parsed command options.
 * @param out - The command's output channel.
 * @returns The connected client, or null after reporting the stop.
 */
async function connectDeploy(options: ConnectionOptions, out: Output): Promise<RocketRideClient | null> {
	if (!options.uri) {
		out.fail(NO_DEPLOY_TARGET_MESSAGE);
		return null;
	}
	return connectClient(options);
}

/**
 * Print one deployment row as a compact human line block.
 *
 * @param out - The output channel.
 * @param deployment - The row to print.
 */
function printDeployment(out: Output, deployment: Deployment): void {
	out.line(`${deployment.projectId ?? '?'}  v${deployment.version ?? '?'}  ${deployment.state ?? '?'}  ${deployment.pipelineName ?? ''}`.trimEnd());
	if (deployment.teamId) {
		out.line(`  Team: ${deployment.teamId}`);
	}
	if (deployment.deployedAt) {
		out.line(`  Deployed: ${formatWhen(deployment.deployedAt)}`);
	}
}

/**
 * Print one history row; rows are self-describing by contract.
 *
 * @param out - The output channel.
 * @param entry - The audit-trail row.
 */
function printHistoryEntry(out: Output, entry: DeployHistoryEntry): void {
	const actor = entry.actor as { name?: string; email?: string } | undefined;
	const who = actor?.name || actor?.email || '';
	const version = entry.version !== undefined ? ` v${entry.version}` : '';
	const team = entry.teamId ? ` team ${entry.teamId}` : '';
	out.line(`${formatWhen(entry.at)}  ${entry.action ?? '?'}${version}${team}${who ? `  by ${who}` : ''}`);
	const data = entry.data as { message?: string; comment?: string } | undefined;
	if (data?.comment) {
		out.line(`  ${data.comment}`);
	}
	if (data?.message) {
		out.line(`  ${data.message}`);
	}
}

/**
 * Register the `deploy` command group on the program.
 *
 * @param program - The root commander program.
 */
export function registerDeployCommands(program: Command): void {
	const deployCmd = program.command('deploy').description('Deploy lifecycle operations (deployment target)');

	// ── deploy add ───────────────────────────────────────────────────────
	const addCmd = deployCmd
		.command('add <file>')
		.description('Deploy an artifact file as the next registry version (deploying activates nothing)')
		.option('--kind <kind>', 'Artifact kind: pipe or node', 'pipe')
		.option('--comment <text>', 'What-changed note kept in the registry')
		.option('--deploy-to <teamId>', 'Also point this team at the new version in the same call')
		.action(async (file, options) => {
			await runCliCommand(options, async (out) => {
				if (options.kind !== 'pipe' && options.kind !== 'node') {
					return out.fail(`Unknown artifact kind '${options.kind}'`, "use 'pipe' or 'node' (apps deploy via 'rocketride app deploy')");
				}
				if (!fs.existsSync(file)) {
					return out.fail(`Artifact file not found: ${file}`);
				}
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				let result;
				if (options.kind === 'pipe') {
					const pipeline = JSON.parse(fs.readFileSync(file, 'utf-8'));
					result = await client.deploy.add({ kind: 'pipe', pipeline, comment: options.comment, deployTo: options.deployTo });
				} else {
					result = await client.deploy.add({ kind: 'node', data: fs.readFileSync(file), comment: options.comment, deployTo: options.deployTo });
				}
				const artifact = result.artifact as { projectId?: string; version?: number; name?: string } | undefined;
				out.line(`Deployed ${options.kind} version v${artifact?.version ?? '?'}${artifact?.name ? ` (${artifact.name})` : ''}`);
				if (artifact?.projectId) {
					out.line(`Project: ${artifact.projectId}`);
				}
				out.line('Deploying activates nothing - publish a rung to serve it.');
				out.result({ projectId: artifact?.projectId, version: artifact?.version, name: artifact?.name });
				return 0;
			});
		});
	addDeployConnectionOptions(addCmd);

	// ── deploy list ──────────────────────────────────────────────────────
	const listCmd = deployCmd
		.command('list')
		.description('List deployments')
		.option('--team <teamId>', 'Scope to one team')
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const envelope = await client.deploy.list({ teamId: options.team });
				const rows = envelope.rows || [];
				if (rows.length === 0) {
					out.line('No deployments found');
				} else {
					out.line(`Found ${rows.length} deployment(s) (of ${envelope.total}):`);
					out.line('');
					for (const row of rows) {
						printDeployment(out, row);
						out.line('');
					}
				}
				out.result({ deployments: rows, total: envelope.total });
				return 0;
			});
		});
	addDeployConnectionOptions(listCmd);

	// ── deploy get ───────────────────────────────────────────────────────
	const getCmd = deployCmd
		.command('get <project>')
		.description("Show one deployment's state")
		.option('--team <teamId>', 'Team the deployment belongs to', '')
		.action(async (project, options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const deployment = await client.deploy.get(project, options.team);
				printDeployment(out, deployment);
				const schedules = deployment.schedules || {};
				for (const [sourceId, schedule] of Object.entries(schedules)) {
					const state = schedule.paused ? 'paused' : schedule.cron ? 'active' : 'none';
					out.line(`  Schedule ${sourceId}: ${schedule.cron ?? '-'} (${state})`);
				}
				out.result({ deployment });
				return 0;
			});
		});
	addDeployConnectionOptions(getCmd);

	// ── deploy versions ──────────────────────────────────────────────────
	const versionsCmd = deployCmd
		.command('versions <project>')
		.description("List a project's registry versions")
		.action(async (project, options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const envelope = await client.deploy.versions(project);
				const rows = envelope.rows || [];
				if (rows.length === 0) {
					out.line('No versions found');
				} else {
					out.line(`Found ${rows.length} version(s) (of ${envelope.total}):`);
					for (const row of rows) {
						const publishedBy = row.publishedBy as { name?: string; email?: string } | undefined;
						const who = publishedBy?.name || publishedBy?.email || '';
						out.line(`v${row.version ?? '?'}  ${formatWhen(row.publishedAt)}${who ? `  by ${who}` : ''}${row.comment ? `  ${row.comment}` : ''}`);
					}
				}
				out.result({ versions: rows, total: envelope.total });
				return 0;
			});
		});
	addDeployConnectionOptions(versionsCmd);

	// ── deploy history ───────────────────────────────────────────────────
	const historyCmd = deployCmd
		.command('history <project>')
		.description("Show a project's deploy/publish audit trail")
		.option('--team <teamId>', 'Scope to one team')
		.action(async (project, options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const envelope = await client.deploy.history(project, { teamId: options.team });
				const rows = envelope.rows || [];
				if (rows.length === 0) {
					out.line('No history found');
				} else {
					for (const row of rows) {
						printHistoryEntry(out, row);
					}
				}
				out.result({ history: rows, total: envelope.total });
				return 0;
			});
		});
	addDeployConnectionOptions(historyCmd);

	// ── deploy publish ───────────────────────────────────────────────────
	// The rung bind: points a team at an existing registry version. The
	// SDK method is named `deploy.deploy` for legacy reasons; the CLI verb
	// follows the platform vocabulary.
	const publishCmd = deployCmd
		.command('publish <project> <version>')
		.description('Bind a team to a registry version (first publish, update, promote, rollback)')
		.option('--team <teamId>', 'Team to bind', '')
		.action(async (project, version, options) => {
			await runCliCommand(options, async (out) => {
				const versionNum = parseInt(version, 10);
				if (!Number.isInteger(versionNum) || versionNum < 1) {
					return out.fail(`'${version}' is not a valid version number`);
				}
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const deployment = await client.deploy.deploy(project, versionNum, options.team);
				out.line(`Published ${project} v${versionNum}${options.team ? ` to team ${options.team}` : ''}.`);
				printDeployment(out, deployment);
				out.result({ deployment });
				return 0;
			});
		});
	addDeployConnectionOptions(publishCmd);

	// ── deploy run ───────────────────────────────────────────────────────
	const runCmd = deployCmd
		.command('run <project> <source>')
		.description("Trigger a deployment's source to run now")
		.option('--team <teamId>', 'Team whose deployment runs', '')
		.action(async (project, source, options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const result = await client.deploy.run(project, source, options.team);
				out.line(`Run started for ${project}/${source}${result.token ? ` (token ${result.token})` : ''}.`);
				out.result(result);
				return 0;
			});
		});
	addDeployConnectionOptions(runCmd);

	// ── deploy artifact ──────────────────────────────────────────────────
	const artifactCmd = deployCmd
		.command('artifact <project> <version>')
		.description("Fetch one registry version's artifact JSON")
		.action(async (project, version, options) => {
			await runCliCommand(options, async (out) => {
				const versionNum = parseInt(version, 10);
				if (!Number.isInteger(versionNum) || versionNum < 1) {
					return out.fail(`'${version}' is not a valid version number`);
				}
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const artifact = await client.deploy.artifact(project, versionNum);
				if (!out.jsonRequested) {
					process.stdout.write(JSON.stringify(artifact, null, 2) + '\n');
				}
				out.result(artifact);
				return 0;
			});
		});
	addDeployConnectionOptions(artifactCmd);

	// ── deploy enable / disable / remove ─────────────────────────────────
	for (const [verb, description] of [
		['enable', 'Enable a disabled deployment'],
		['disable', 'Disable a deployment (whole-deployment kill switch)'],
		['remove', 'Remove a deployment (registry versions and audit history survive)'],
	] as const) {
		const cmd = deployCmd
			.command(`${verb} <project>`)
			.description(description)
			.option('--team <teamId>', 'Team the deployment belongs to', '')
			.action(async (project, options) => {
				await runCliCommand(options, async (out) => {
					const client = await connectDeploy(options, out);
					if (!client) return 1;
					const deployment = await client.deploy[verb](project, options.team);
					out.line(`Deployment ${project} ${verb}d.`);
					out.result({ deployment });
					return 0;
				});
			});
		addDeployConnectionOptions(cmd);
	}

	// ── deploy log ───────────────────────────────────────────────────────
	// Fronts the build.log read verb: error detail for a failed app build
	// lives in the scrubbed build.log beside the artifact.
	const logCmd = deployCmd
		.command('log <appId> <version>')
		.description("Read an app version's build log")
		.action(async (appId, version, options) => {
			await runCliCommand(options, async (out) => {
				const versionNum = parseInt(version, 10);
				if (!Number.isInteger(versionNum) || versionNum < 1) {
					return out.fail(`'${version}' is not a valid version number`);
				}
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const result = await client.buildLog(appId, versionNum);
				if (!out.jsonRequested) {
					process.stdout.write((result.log || '') + '\n');
				}
				out.result(result);
				return 0;
			});
		});
	addDeployConnectionOptions(logCmd);

	// ── deploy schedule ──────────────────────────────────────────────────
	const scheduleCmd = deployCmd.command('schedule').description('Per-source schedule operations');

	const scheduleSetCmd = scheduleCmd
		.command('set <project> <source> <cron>')
		.description("Set a source's schedule (5-field cron), or 'none' to clear it")
		.option('--team <teamId>', 'Team the deployment belongs to', '')
		.option('--ttl <seconds>', 'Run window in seconds (fixed window)')
		.action(async (project, source, cron, options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const schedule = cron === 'none' ? null : cron;
				const deployment = await client.deploy.setSchedule(project, source, schedule, options.team, {
					ttl: options.ttl !== undefined ? parseInt(options.ttl, 10) : undefined,
				});
				out.line(schedule ? `Schedule set for ${project}/${source}: ${schedule}` : `Schedule cleared for ${project}/${source}.`);
				out.result({ deployment });
				return 0;
			});
		});
	addDeployConnectionOptions(scheduleSetCmd);

	for (const [verb, methodName, description] of [
		['pause', 'pauseSchedule', "Pause a source's schedule (cron/ttl kept, never fires)"],
		['resume', 'resumeSchedule', "Resume a source's paused schedule"],
	] as const) {
		const cmd = scheduleCmd
			.command(`${verb} <project> <source>`)
			.description(description)
			.option('--team <teamId>', 'Team the deployment belongs to', '')
			.action(async (project, source, options) => {
				await runCliCommand(options, async (out) => {
					const client = await connectDeploy(options, out);
					if (!client) return 1;
					const deployment = await client.deploy[methodName](project, source, options.team);
					out.line(`Schedule ${verb}d for ${project}/${source}.`);
					out.result({ deployment });
					return 0;
				});
			});
		addDeployConnectionOptions(cmd);
	}

	const schedulePreviewCmd = scheduleCmd
		.command('preview <cron>')
		.description('Validate a cron expression and show its next occurrences')
		.option('--count <num>', 'Number of occurrences to show', '5')
		.action(async (cron, options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectDeploy(options, out);
				if (!client) return 1;
				const preview = await client.deploy.preview(cron, parseInt(options.count, 10));
				if (preview.valid === false) {
					out.line(`Invalid: ${preview.error || 'unknown reason'}`);
					out.result(preview);
					return 1;
				}
				out.line(`Valid. Next ${preview.next?.length ?? 0} occurrence(s):`);
				for (const when of preview.next || []) {
					out.line(`  ${formatWhen(when)}`);
				}
				out.result(preview);
				return 0;
			});
		});
	addDeployConnectionOptions(schedulePreviewCmd);
}
