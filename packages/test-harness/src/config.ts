/**
 * Centralized environment variable access for the harness.
 *
 * Single reader of process.env. Everything else takes a typed HarnessConfig.
 */

export type HarnessTier = 'smoke' | 'integration' | 'all';
export type HarnessServerMode = 'spawn' | 'external';

export type HarnessConfig = {
	tier: HarnessTier;
	mockLlm: boolean;
	serverMode: HarnessServerMode;
	serverUrl: string;
	apiKey: string;
	pipelineTimeoutSec: number;
	retainRuns: number;
	bail: boolean;
	runsDir: string;
	pipelinesDir: string;
};

function readBool(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const v = raw.trim().toLowerCase();
	if (v === '1' || v === 'true' || v === 'yes') return true;
	if (v === '0' || v === 'false' || v === 'no') return false;
	return fallback;
}

function readInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) ? n : fallback;
}

function readTier(): HarnessTier {
	const raw = (process.env.HARNESS_TIER ?? 'smoke').toLowerCase();
	if (raw === 'smoke' || raw === 'integration' || raw === 'all') return raw;
	return 'smoke';
}

function readServerMode(): HarnessServerMode {
	const raw = (process.env.HARNESS_SERVER_MODE ?? 'spawn').toLowerCase();
	return raw === 'external' ? 'external' : 'spawn';
}

export function loadConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
	const packageRoot = require('path').resolve(__dirname, '..');
	const projectRoot = require('path').resolve(packageRoot, '..', '..');

	const base: HarnessConfig = {
		tier: readTier(),
		mockLlm: readBool('HARNESS_MOCK_LLM', true),
		serverMode: readServerMode(),
		serverUrl: process.env.HARNESS_SERVER_URL ?? 'http://localhost:5565',
		apiKey: process.env.ROCKETRIDE_APIKEY ?? 'MYAPIKEY',
		pipelineTimeoutSec: readInt('HARNESS_PIPELINE_TIMEOUT_S', 60),
		retainRuns: readInt('HARNESS_RETAIN_RUNS', 20),
		bail: readBool('HARNESS_BAIL', false),
		runsDir: process.env.HARNESS_RUNS_DIR ?? require('path').join(projectRoot, '.harness-runs'),
		pipelinesDir: process.env.HARNESS_PIPELINES_DIR ?? require('path').join(packageRoot, 'pipelines'),
	};

	return { ...base, ...overrides };
}
