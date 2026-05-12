#!/usr/bin/env node
/**
 * Pipeline test harness CLI.
 *
 * Subcommands:
 *   smoke                    Run pipelines/smoke/*.json against a spawned server.
 *   integration              Run pipelines/integration/*.json.
 *   all                      Run smoke + integration.
 *   report <run-dir>         Re-render report.md from existing trace JSONs.
 *   scaffold-exclusions      Emit a starter coverage-exclusions.json from /services.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

import { RocketRideClient } from 'rocketride';

import { loadConfig, type HarnessConfig } from './config';
import { diffCoverage } from './coverage/diff';
import { loadExclusions, validateExclusions, writeStarterExclusions } from './coverage/exclusions';
import { fetchServices } from './coverage/services';
import { renderMarkdown, writeReports } from './report/markdown';
import { emptyCoverageFrom, type PipelineSummary, type RunReport } from './report/schema';
import { TraceCollector } from './runner/collector';
import { ensureRunDir, isoStamp, loadTraces, pipelineSlugToFile } from './runner/persist';
import { runPipeline, type PipelineDef } from './runner/runPipeline';
import type { TraceFile } from './runner/schema';
import { startHarnessServer, type ServerHandle } from './server/lifecycle';

const DEFAULT_INPUT = 'hello from harness';
const EXCLUSIONS_FILENAME = 'coverage-exclusions.json';

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

async function runTier(config: HarnessConfig, runDir: string, server: ServerHandle, tier: TierName): Promise<TraceFile[]> {
	const pipelines = discoverPipelines(config.pipelinesDir, tier);
	if (pipelines.length === 0) {
		process.stdout.write(`[harness] no pipelines under ${tier}/, skipping tier\n`);
		return [];
	}

	const traces: TraceFile[] = [];

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

	return traces;
}

function tracePathFor(trace: TraceFile): string {
	return `traces/${pipelineSlugToFile(trace.pipeline)}`;
}

function summarizePipeline(trace: TraceFile): PipelineSummary {
	const duration = Date.parse(trace.run_ended) - Date.parse(trace.run_started);
	return {
		pipeline: trace.pipeline,
		result: trace.result,
		duration_ms: Number.isFinite(duration) ? duration : 0,
		exercised_nodes: trace.exercised_nodes,
		error_message: trace.error?.message,
		infra_signature: trace.infra_signature,
		trace_path: tracePathFor(trace),
	};
}

function aggregateSummary(traces: TraceFile[]): RunReport['summary'] {
	const summary = { pass: 0, logic_failure: 0, infra_failure: 0, timeout: 0, total: traces.length };
	for (const t of traces) {
		summary[t.result] += 1;
	}
	return summary;
}

async function buildCoverage(
	config: HarnessConfig,
	server: ServerHandle,
	traces: TraceFile[],
): Promise<{ coverage?: RunReport['coverage']; skipped?: { reason: string } }> {
	try {
		const registry = await fetchServices(server.url, config.apiKey);
		const exclusionsPath = join(config.pipelinesDir, '..', EXCLUSIONS_FILENAME);
		const exclusionsFile = loadExclusions(exclusionsPath);
		const validation = validateExclusions(exclusionsFile, registry.names);

		if (validation.stale.length > 0) {
			process.stderr.write(`[harness] warning: stale exclusions ignored (not in /services): ${validation.stale.join(', ')}\n`);
		}
		if (validation.thinReason.length > 0) {
			process.stderr.write(`[harness] warning: thin-reason exclusions ignored (need >=3 words): ${validation.thinReason.join(', ')}\n`);
		}

		const exercised = new Set<string>();
		for (const t of traces) {
			for (const n of t.exercised_nodes) exercised.add(n);
		}

		const diff = diffCoverage({
			knownNodes: registry.names,
			exercisedNodes: exercised,
			excluded: validation.excluded,
		});

		return { coverage: emptyCoverageFrom(diff, validation.staleWarnings) };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[harness] coverage skipped: ${reason}\n`);
		return { skipped: { reason } };
	}
}

function buildReport(args: {
	config: HarnessConfig;
	server: ServerHandle;
	tier: string;
	traces: TraceFile[];
	runStarted: Date;
	runEnded: Date;
	coverage?: RunReport['coverage'];
	skippedCoverage?: { reason: string };
}): RunReport {
	const pipelines = args.traces.map(summarizePipeline);
	return {
		schema_version: 1,
		run_started: args.runStarted.toISOString(),
		run_ended: args.runEnded.toISOString(),
		duration_ms: args.runEnded.getTime() - args.runStarted.getTime(),
		tier: args.tier,
		mock_llm: args.config.mockLlm,
		server: { mode: args.server.mode, url: args.server.url, port: args.server.port },
		summary: aggregateSummary(args.traces),
		coverage: args.coverage,
		pipelines,
		skipped_coverage: args.skippedCoverage,
	};
}

async function runTiersCommand(tiers: TierName[], config: HarnessConfig, tierLabel: string): Promise<number> {
	const runStarted = new Date();
	const stamp = isoStamp(runStarted);
	const runDir = ensureRunDir(config.runsDir, stamp);
	process.stdout.write(`[harness] run dir: ${runDir}\n`);

	process.stdout.write(`[harness] starting server (mode=${config.serverMode}, mockLlm=${config.mockLlm})\n`);
	const server = await startHarnessServer(config);
	process.stdout.write(`[harness] server ready at ${server.url}\n`);

	const allTraces: TraceFile[] = [];

	try {
		for (const tier of tiers) {
			const traces = await runTier(config, runDir, server, tier);
			allTraces.push(...traces);
			if (config.bail && traces.some((t) => t.result !== 'pass')) break;
		}

		const coverage = await buildCoverage(config, server, allTraces);
		const runEnded = new Date();
		const report = buildReport({
			config,
			server,
			tier: tierLabel,
			traces: allTraces,
			runStarted,
			runEnded,
			coverage: coverage.coverage,
			skippedCoverage: coverage.skipped,
		});

		const paths = writeReports(runDir, report);
		process.stdout.write(`[harness] report: ${paths.md}\n`);

		const failures = report.summary.logic_failure + report.summary.timeout;
		const gaps = report.coverage?.gap_count ?? 0;
		process.stdout.write(
			`[harness] done: ${report.summary.pass} pass / ${failures} non-pass / ${report.summary.total} total; gaps=${gaps}\n`,
		);
		return failures > 0 || gaps > 0 ? 1 : 0;
	} finally {
		process.stdout.write('[harness] stopping server\n');
		await server.stop();
	}
}

async function reportCommand(runDir: string, config: HarnessConfig): Promise<number> {
	if (!existsSync(join(runDir, 'traces'))) {
		process.stderr.write(`[harness] no traces/ directory under ${runDir}\n`);
		return 2;
	}
	const traces = loadTraces(runDir);
	const existingJsonPath = join(runDir, 'report.json');
	const previous = existsSync(existingJsonPath)
		? (JSON.parse(readFileSync(existingJsonPath, 'utf8')) as RunReport)
		: undefined;

	const runStarted = previous ? new Date(previous.run_started) : new Date(traces[0]?.run_started ?? Date.now());
	const runEnded = previous ? new Date(previous.run_ended) : new Date(traces[traces.length - 1]?.run_ended ?? Date.now());

	const report: RunReport = {
		schema_version: 1,
		run_started: runStarted.toISOString(),
		run_ended: runEnded.toISOString(),
		duration_ms: runEnded.getTime() - runStarted.getTime(),
		tier: previous?.tier ?? 'unknown',
		mock_llm: previous?.mock_llm ?? config.mockLlm,
		server: previous?.server ?? { mode: 'external', url: config.serverUrl, port: 0 },
		summary: aggregateSummary(traces),
		coverage: previous?.coverage,
		pipelines: traces.map(summarizePipeline),
		skipped_coverage: previous?.skipped_coverage,
	};

	const paths = writeReports(runDir, report);
	process.stdout.write(`[harness] re-rendered: ${paths.md}\n`);
	return 0;
}

async function scaffoldExclusionsCommand(config: HarnessConfig): Promise<number> {
	process.stdout.write(`[harness] starting server to fetch /services\n`);
	const server = await startHarnessServer(config);
	try {
		const registry = await fetchServices(server.url, config.apiKey);
		const outPath = join(config.pipelinesDir, '..', EXCLUSIONS_FILENAME);
		writeStarterExclusions(outPath, registry.names, 'TODO-owner');
		process.stdout.write(`[harness] wrote starter exclusions for ${registry.names.size} nodes to ${outPath}\n`);
		return 0;
	} finally {
		await server.stop();
	}
}

async function main(): Promise<number> {
	const [subcommand = 'smoke', ...rest] = process.argv.slice(2);
	const config = loadConfig();

	switch (subcommand) {
		case 'smoke':
			return runTiersCommand(['smoke'], config, 'smoke');
		case 'integration':
			return runTiersCommand(['integration'], config, 'integration');
		case 'all':
			return runTiersCommand(['smoke', 'integration'], config, 'all');
		case 'report': {
			const runDir = rest[0];
			if (!runDir) {
				process.stderr.write('[harness] usage: rocketride-harness report <run-dir>\n');
				return 2;
			}
			return reportCommand(runDir, config);
		}
		case 'scaffold-exclusions':
			return scaffoldExclusionsCommand(config);
		default:
			process.stderr.write(`[harness] unknown subcommand: ${subcommand}\n`);
			process.stderr.write('[harness] usage: rocketride-harness <smoke|integration|all|report|scaffold-exclusions>\n');
			return 2;
	}
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		process.stderr.write(`[harness] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
		process.exit(1);
	});

// Re-export for unit tests in later phases.
export { renderMarkdown };
