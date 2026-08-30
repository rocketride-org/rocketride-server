// =============================================================================
// TEST-UI — Pre-built chaos scenarios
// =============================================================================

import type { ChaosScenario } from './types';

export const SCENARIOS: ChaosScenario[] = [
	{
		id: 'thundering-herd',
		name: 'Thundering Herd',
		description: '64 pipelines start simultaneously, all sending data within 50ms. Tests connection pool exhaustion and task queue saturation.',
		tags: [
			{ label: 'stress', color: 'stress' },
			{ label: 'connection', color: 'conn' },
		],
		config: { pipelines: 64, sendsPerPipeline: 20, rampUp: 'instant', randomDelay: 50, killProbability: 0, payloadSize: 'medium' },
		run: async (engine) => engine.start({ pipelines: 64, sendsPerPipeline: 20, rampUp: 'instant', randomDelay: 50, killProbability: 0, corruptionLevel: 'off', payloadSize: 'medium', payloadType: 'text' }),
	},
	{
		id: 'whack-a-mole',
		name: 'Whack-a-Mole',
		description: 'Start 16 pipelines, randomly kill 15% every 5s, immediately restart them. Tests cleanup, resource leaks, and ghost tasks.',
		tags: [
			{ label: 'chaos', color: 'chaos' },
			{ label: 'stress', color: 'stress' },
		],
		config: { pipelines: 16, sendsPerPipeline: 100, rampUp: 'linear', randomDelay: 200, killProbability: 15, payloadSize: 'medium' },
		run: async (engine) => engine.start({ pipelines: 16, sendsPerPipeline: 100, rampUp: 'linear', randomDelay: 200, killProbability: 15, corruptionLevel: 'off', payloadSize: 'medium', payloadType: 'text' }),
	},
	{
		id: 'data-flood',
		name: 'Data Flood',
		description: 'Single pipeline, 1000 concurrent sends with payloads from 1B to 100MB. Tests backpressure, memory, and data integrity.',
		tags: [
			{ label: 'stress', color: 'stress' },
			{ label: 'data', color: 'data' },
		],
		config: { pipelines: 1, sendsPerPipeline: 1000, rampUp: 'instant', randomDelay: 0, killProbability: 0, payloadSize: 'mixed', payloadType: 'mixed' },
		run: async (engine) => engine.start({ pipelines: 1, sendsPerPipeline: 1000, rampUp: 'instant', randomDelay: 0, killProbability: 0, corruptionLevel: 'off', payloadSize: 'mixed', payloadType: 'mixed' }),
	},
	{
		id: 'garbage-in',
		name: 'Garbage In',
		description: 'Send malformed JSON, binary noise, null bytes, enormous strings, deeply nested objects. Tests input validation and error handling.',
		tags: [
			{ label: 'chaos', color: 'chaos' },
			{ label: 'data', color: 'data' },
		],
		config: { pipelines: 8, sendsPerPipeline: 50, rampUp: 'instant', randomDelay: 100, killProbability: 0, payloadSize: 'mixed', payloadType: 'malformed', corruptionLevel: 'extreme' },
		run: async (engine) => engine.start({ pipelines: 8, sendsPerPipeline: 50, rampUp: 'instant', randomDelay: 100, killProbability: 0, corruptionLevel: 'extreme', payloadSize: 'mixed', payloadType: 'malformed' }),
	},
	{
		id: 'connection-chaos',
		name: 'Connection Chaos',
		description: 'Rapid connect/disconnect cycles, auth during data transfer, multiple clients sharing tokens, concurrent logins.',
		tags: [
			{ label: 'chaos', color: 'chaos' },
			{ label: 'connection', color: 'conn' },
		],
		config: { pipelines: 8, sendsPerPipeline: 30, rampUp: 'burst', randomDelay: 300, killProbability: 25 },
		run: async (engine) => engine.start({ pipelines: 8, sendsPerPipeline: 30, rampUp: 'burst', randomDelay: 300, killProbability: 25, corruptionLevel: 'off', payloadSize: 'medium', payloadType: 'text' }),
	},
	{
		id: 'file-store-blitz',
		name: 'File Store Blitz',
		description: 'Concurrent reads/writes to same files, directory creation races, handle exhaustion, read-after-delete.',
		tags: [
			{ label: 'chaos', color: 'chaos' },
			{ label: 'data', color: 'data' },
		],
		config: { pipelines: 4, sendsPerPipeline: 10, rampUp: 'instant', randomDelay: 50 },
		run: async (engine) => engine.start({ pipelines: 4, sendsPerPipeline: 10, rampUp: 'instant', randomDelay: 50, killProbability: 0, corruptionLevel: 'off', payloadSize: 'tiny', payloadType: 'text' }),
	},
	{
		id: 'seq-collision',
		name: 'SEQ Collision',
		description: 'Multiple clients with independent seq counters sharing a task via useExisting. Tests DAP multiplexing under seq collision.',
		tags: [
			{ label: 'chaos', color: 'chaos' },
			{ label: 'connection', color: 'conn' },
		],
		config: { pipelines: 4, sendsPerPipeline: 50, rampUp: 'instant', randomDelay: 10, killProbability: 0 },
		run: async (engine) => engine.start({ pipelines: 4, sendsPerPipeline: 50, rampUp: 'instant', randomDelay: 10, killProbability: 0, corruptionLevel: 'off', payloadSize: 'medium', payloadType: 'text' }),
	},
	{
		id: 'full-api-sweep',
		name: 'Full API Sweep',
		description: 'Methodically call every single SDK method with valid args. Tests coverage and error handling across the entire surface.',
		tags: [{ label: 'api', color: 'api' }],
		config: { pipelines: 0, sendsPerPipeline: 0, rampUp: 'instant', randomDelay: 0, killProbability: 0 },
		run: async (engine) => engine.start({ pipelines: 0, sendsPerPipeline: 0, rampUp: 'instant', randomDelay: 0, killProbability: 0, corruptionLevel: 'off', payloadSize: 'tiny', payloadType: 'text' }),
	},
];
