#!/usr/bin/env node
/**
 * Pipeline test harness CLI.
 *
 * Subcommands:
 *   smoke         Run all pipelines/smoke/*.json against a spawned server.
 *   integration   Run all pipelines/integration/*.json.
 *   all           Run smoke + integration.
 *
 * Phase 1 scope: smoke only. Trace files persist; no markdown report yet.
 */

import { existsSync, readdirSync } from 'fs';
import { basename, join } from 'path';

import { RocketRideClient } from 'rocketride';

import { loadConfig, type HarnessConfig } from './config';
import { TraceCollector } from './runner/collector';
import { ensureRunDir, isoStamp } from './runner/persist';
import { runPipeline, type PipelineDef } from './runner/runPipeline';
import type { TraceFile } from './runner/schema';
import { startHarnessServer } from './server/lifecycle';

const DEFAULT_INPUT = 'hello from harness';

type TierName = 'smoke' | 'integration';

function discoverPipelines(pipelinesDir: string, tier: TierName): PipelineDef[] {
	const tierDir = join(pipelinesDir, tier);
	if (!existsSync(tierDir)) return [];
	const files = readdirSync(tierDir)
		.filter((f) => f.endsWith('.json'))
		.sort();

	return files.map((file) => ({
		slug: `${tier}/${basename(file, '.json')}`,
		filePath: join(tierDir, file),
		input: { mimeType: 'text/plain', data: DEFAULT_INPUT },
	}));
}

async function runTier(config: HarnessConfig, runDir: string, tier: TierName): Promise<TraceFile[]> {
	const pipelines = discoverPipelines(config.pipelinesDir, tier);
	if (pipelines.length === 0) {
		process.stdout.write(`[harness] no pipelines under ${tier}/, skipping tier\n`);
		return [];
	}

	process.stdout.write(`[harness] starting server (mode=${config.serverMode}, mockLlm=${config.mockLlm})\n`);
	const server = await startHarnessServer(config);
	process.stdout.write(`[harness] server ready at ${server.url}\n`);

	const traces: TraceFile[] = [];

	try {
		for (const def of pipelines) {
			process.stdout.write(`[harness] run ${def.slug}\n`);
			const collector = new TraceCollector({
				token: '',
				timeoutMs: config.pipelineTimeoutSec * 1000,
			});

			const client = new RocketRideClient({
				uri: server.url,
				auth: config.apiKey,
				onEvent: collector.onEvent,
			});

			try {
				await client.connect();
				const trace = await runPipeline(client, collector, def, {
					runDir,
					timeoutMs: config.pipelineTimeoutSec * 1000,
				});
				traces.push(trace);
				process.stdout.write(`[harness]   result=${trace.result} nodes=${trace.exercised_nodes.length}\n`);
				if (config.bail && trace.result !== 'pass') {
					process.stdout.write(`[harness] bail=true, stopping after ${def.slug}\n`);
					break;
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				process.stderr.write(`[harness]   ${def.slug} threw: ${message}\n`);
				if (config.bail) break;
			} finally {
				if (client.isConnected()) {
					await client.disconnect();
				}
			}
		}
	} finally {
		process.stdout.write('[harness] stopping server\n');
		await server.stop();
	}

	return traces;
}

async function main(): Promise<number> {
	const [subcommand = 'smoke'] = process.argv.slice(2);
	const config = loadConfig();

	if (subcommand !== 'smoke' && subcommand !== 'integration' && subcommand !== 'all') {
		process.stderr.write(`[harness] unknown subcommand: ${subcommand}\n`);
		process.stderr.write('[harness] usage: rocketride-harness <smoke|integration|all>\n');
		return 2;
	}

	const stamp = isoStamp();
	const runDir = ensureRunDir(config.runsDir, stamp);
	process.stdout.write(`[harness] run dir: ${runDir}\n`);

	const tiers: TierName[] = subcommand === 'all' ? ['smoke', 'integration'] : [subcommand];
	const allTraces: TraceFile[] = [];

	for (const tier of tiers) {
		const traces = await runTier(config, runDir, tier);
		allTraces.push(...traces);
	}

	const passes = allTraces.filter((t) => t.result === 'pass').length;
	const failures = allTraces.length - passes;
	process.stdout.write(`[harness] done: ${passes} pass / ${failures} non-pass / ${allTraces.length} total\n`);
	return failures > 0 ? 1 : 0;
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		process.stderr.write(`[harness] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
		process.exit(1);
	});
