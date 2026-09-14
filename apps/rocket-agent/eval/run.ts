#!/usr/bin/env node
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
 * Eval suite CLI (Phase 5, Task 5.1b).
 *
 *   tsx eval/run.ts --mode replay                  # keyless, deterministic — the regression gate
 *   tsx eval/run.ts --mode live                     # real provider + real key — the GA gate (passRate >= 0.8)
 *   tsx eval/run.ts --mode live --record             # real provider, persists transcripts for future replay
 *   tsx eval/run.ts --mode replay --brief webhook-transform --report out.json
 *
 * Exit codes:
 *  - live mode: 1 when `report.gate === false` (passRate < 0.8) — the GA gate.
 *  - replay mode: replay pins the model's recorded behavior, so a brief legitimately failing
 *    scoring is expected to reproduce identically run over run — it is NOT the GA gate. Exit 1
 *    only on an infrastructure error (thrown, caught below) or when passRate drops below the
 *    last committed `eval/replay-baseline.json` (regression, not absolute gate).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BRIEFS } from './src/briefs';
import { runSuite } from './src/runner';
import type { SuiteReport } from './src/types';

interface CliArgs {
	mode: 'replay' | 'live';
	record: boolean;
	brief?: string;
	report: string;
}

function parseArgs(argv: string[]): CliArgs {
	const out: CliArgs = { mode: 'replay', record: false, report: 'eval-report.json' };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--mode') out.mode = argv[++i] as 'replay' | 'live';
		else if (arg === '--record') out.record = true;
		else if (arg === '--brief') out.brief = argv[++i];
		else if (arg === '--report') out.report = argv[++i];
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (out.mode !== 'replay' && out.mode !== 'live') throw new Error(`--mode must be "replay" or "live", got "${out.mode}"`);
	return out;
}

const BASELINE_PATH = path.join(__dirname, 'replay-baseline.json');

/** Default engine/mcp MCP endpoint — matches the engine/mcp/qdrant docker-compose overlay `.github/workflows/rocket-agent-eval-live.yml` brings up, and that workflow's own `RR_MCP_UPSTREAM` env value. Overridable so a local dev pointing docker-compose at a different port doesn't need to edit code. */
const DEFAULT_LIVE_MCP_UPSTREAM = 'http://localhost:8080/mcp';

/**
 * A CLI-level decision, pulled out as a pure function so it's unit-testable without any I/O: what
 * should `main()`'s exit code be for a finished `SuiteReport`, and why. `gate` (live mode's GA
 * gate, computed in score.ts) is never touched here — this only decides what run.ts itself does
 * with the report.
 */
export function evaluateExitCode(mode: 'replay' | 'live', report: SuiteReport, baseline: { passRate: number } | undefined): { failed: boolean; reason?: string } {
	if (mode === 'live') {
		// Belt-and-suspenders against the exact defect this function exists to prevent: live mode's
		// own engine wiring guard (runner.ts's startEngineForBrief) already makes a stub-backed live
		// run impossible, so this should be unreachable — but a silently-wrong GA number is bad
		// enough that "impossible" gets checked again here, at the one place the number is reported.
		if (report.approximatedCount > 0) {
			return { failed: true, reason: `${report.approximatedCount} brief(s) used an APPROXIMATED validate_pipeline verdict in LIVE mode — this must never happen (see startEngineForBrief's guard); the GA passRate is not trustworthy` };
		}
		if (!report.gate) return { failed: true, reason: `GA gate FAILED — passRate ${report.passRate.toFixed(3)} < 0.8` };
		return { failed: false };
	}
	// replay mode: NOT the GA gate — but an approximation-based run is not a clean regression
	// baseline either, and must never be read as one. Fail loudly rather than silently comparing
	// (or letting a human silently commit) a number that isn't a real regression signal.
	if (report.approximatedCount > 0) {
		return {
			failed: true,
			reason: `${report.approximatedCount}/${report.results.length} brief(s) used an APPROXIMATED validate_pipeline verdict (no matching recorded engine verdict for that pipe digest) — this replay run is NOT a clean regression baseline and must not be compared against or committed as one. Re-record the missing verdict(s) with --mode live --record.`,
		};
	}
	if (!baseline) return { failed: false, reason: 'no committed replay baseline yet — skipping regression check' };
	if (report.passRate < baseline.passRate) {
		return { failed: true, reason: `replay REGRESSION: passRate ${report.passRate.toFixed(3)} < committed baseline ${baseline.passRate.toFixed(3)}` };
	}
	return { failed: false };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const briefs = args.brief ? BRIEFS.filter((b) => b.id === args.brief) : BRIEFS;
	if (args.brief && briefs.length === 0) throw new Error(`unknown brief id "${args.brief}" — expected one of: ${BRIEFS.map((b) => b.id).join(', ')}`);

	// live mode ONLY: the real engine's MCP endpoint. Read from RR_MCP_UPSTREAM — the SAME env var
	// name `.github/workflows/rocket-agent-eval-live.yml` already sets when it invokes
	// `eval:live` (matching that, rather than inventing a second differently-named var, is what
	// actually closes the gap: no workflow change needed). Never consulted in replay mode, which
	// always uses the keyless stub engine.
	const liveMcpUpstream = args.mode === 'live' ? (process.env.RR_MCP_UPSTREAM || DEFAULT_LIVE_MCP_UPSTREAM) : undefined;
	if (args.mode === 'live') console.log(`[eval] live mode: routing MCP tool calls to ${liveMcpUpstream}`);

	const report = await runSuite({ mode: args.mode, record: args.record, briefs, liveMcpUpstream });
	fs.writeFileSync(path.resolve(args.report), JSON.stringify(report, null, 2), 'utf8');

	const passCount = report.results.filter((r) => r.pass).length;
	console.log(`[eval] ${args.mode} mode: ${passCount}/${report.results.length} briefs passed (passRate ${report.passRate.toFixed(3)}, approximatedCount ${report.approximatedCount}) -> ${args.report}`);
	for (const r of report.results.filter((res) => !res.pass)) {
		console.log(`  FAIL ${r.briefId}: ${r.structuralFailures.slice(0, 3).join('; ') || (r.validatePass ? 'scoring failure' : 'validate_pipeline verdict was false')}`);
	}

	const baseline = fs.existsSync(BASELINE_PATH) ? (JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as { passRate: number }) : undefined;
	const decision = evaluateExitCode(args.mode, report, baseline);
	if (decision.reason) (decision.failed ? console.error : console.log)(`[eval] ${decision.reason}`);
	if (decision.failed) process.exitCode = 1;
}

// Guarded like src/index.ts's own entrypoint: `evaluateExitCode` (and, transitively, the rest of
// this module) is imported directly by tests — running `main()` as an import side effect would
// invoke the full CLI (spawn opencode, hit the network, write eval-report.json) just from a test
// importing a pure function.
if (require.main === module) {
	main().catch((err) => {
		console.error('[eval] fatal', err);
		process.exitCode = 1;
	});
}
