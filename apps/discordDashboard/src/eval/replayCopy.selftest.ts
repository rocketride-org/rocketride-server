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
// REPLAY COPY SELF-TEST — the transform, checked against the real shipped pipe
// =============================================================================
//
// The app has no unit-test runner (it is a shell bundle, not a package with a
// test script), so this is the same shape as `src/eval/rules.selftest.ts`: a pure
// function that returns its failures, wired to nothing.
//
// It exists because of what the transform in `replayCopy.ts` is load-bearing FOR.
// A replay run exists to be safe to press: an edge left pointing at a component
// that is no longer there turns the copy into a pipeline that will not start, and
// a Slack instruction left in the agent's prompt turns a regression check into a
// page to real people. Neither failure is visible in the app until the run is
// already going, and both are a one-line change away at all times.
//
// So the cases run TWICE over the same rules: once over a hand-built four-component
// document, where every field can be asserted exactly, and once over
// `discord-ralph-slack.pipe` resolved with `DEFAULT_SETTINGS` — the real pipe, the
// worst case (it is the only one with Slack in it), and the one whose instruction
// array the two prompt rules are counted against.
// =============================================================================

import { assertReplayCopyIsolated, buildReplayCopy, describeReplayCopy, LIVE_PROJECT_IDS, REPLAY_COPY_PROJECT_ID, REPLAY_COPY_SOURCE, sanitizeShownReply } from './replayCopy';
import { PIPELINES, resolvePipeline } from '../pipeline/resolve';
import { CAPTURE_NODE_ID, DATA_PROJECT_ID, type DbConnection } from '../db/config';
import { DEFAULT_SETTINGS } from '../state/types';

// =============================================================================
// FIXTURES
// =============================================================================

/**
 * A hand-built live pipeline: a discord source, an agent, its Slack tool, and a
 * response.
 *
 * Small enough that every assertion below names a field, and shaped like the real
 * thing where it matters: the source is named by a top-level `source` field AND
 * by `config.mode`, the agent is wired by a data `input` while the tool is wired
 * by a `control` edge, and the agent's config carries the instruction list both at
 * the top level and inside a `default` block.
 *
 * @returns A fresh document, so a test that mutates one cannot affect the next.
 */
function handBuiltLive(): Record<string, unknown> {
	return {
		components: [
			{
				id: 'discord_1',
				provider: 'discord',
				name: 'Discord Bot',
				config: { mode: 'Source', type: 'discord', parameters: { botToken: 'x' } },
				ui: { position: { x: 10, y: 20 } },
			},
			{
				id: 'agent_crewai_1',
				provider: 'agent_crewai',
				name: 'Agent',
				config: {
					instructions: ['Answer the question.', 'SLACK PAGING — HARD RULE: call tool_slack_1_message_post before escalating.', '- "I was charged twice" → [calls tool_slack_1_message_post with text \'ping\'] Sorry about that. Escalated to the RocketRide team.'],
					default: {
						instructions: ['  SLACK PAGING — the same rule, indented, in the inactive profile.', 'Be brief. [calls tool_slack_1_message_post] Thanks.'],
					},
				},
				input: [
					{ lane: 'text', from: 'discord_1' },
					{ lane: 'image', from: 'discord_1' },
				],
			},
			{
				id: 'tool_slack_1',
				provider: 'tool_slack',
				name: 'Slack',
				config: { webhookUrl: 'https://example.invalid' },
				control: [{ classType: 'tool', from: 'agent_crewai_1' }],
			},
			{
				id: 'response_answers_1',
				provider: 'response_answers',
				name: 'Answers',
				config: { laneName: 'answers' },
				input: [
					{ lane: 'answers', from: 'agent_crewai_1' },
					{ lane: 'text', from: 'tool_slack_1' },
				],
			},
		],
		source: 'discord_1',
		project_id: 'live-project-id',
		version: 1,
	};
}

/**
 * The local dev connection, for the capture cases.
 *
 * The literals from `package.json`'s `contributes.configuration`. What they
 * are does not matter here — what matters is that a capture component built
 * from them never survives into a copy.
 */
const CONN: DbConnection = {
	provider: 'db_postgres',
	host: '127.0.0.1:55432',
	database: 'discord_dashboard',
	user: 'rr_discord',
	passwordVariable: 'ROCKETRIDE_DISCORD_PG_PASSWORD',
};

/** The components of a document, as a typed array. */
function componentsOf(pipeline: Record<string, unknown>): Record<string, unknown>[] {
	return Array.isArray(pipeline.components) ? (pipeline.components as Record<string, unknown>[]) : [];
}

/** One component by id, or undefined. */
function componentById(pipeline: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
	return componentsOf(pipeline).find((component) => component.id === id);
}

/** Every `from` on a component's `input` and `control` lists. */
function edgesOf(component: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const key of ['input', 'control']) {
		const edges = component[key];
		if (!Array.isArray(edges)) continue;
		for (const edge of edges) {
			if (edge !== null && typeof edge === 'object' && !Array.isArray(edge)) {
				out.push(String((edge as Record<string, unknown>).from ?? ''));
			}
		}
	}
	return out;
}

/** The agent's active-profile instruction list. */
function instructionsOf(component: Record<string, unknown> | undefined): string[] {
	const config = (component?.config ?? {}) as Record<string, unknown>;
	return Array.isArray(config.instructions) ? (config.instructions as string[]) : [];
}

// =============================================================================
// API
// =============================================================================

/**
 * Run every case.
 *
 * @returns One message per failing assertion; empty when the transform, the
 *          guard, the description and the sanitizer all still behave.
 */
export function runReplayCopySelfTest(): string[] {
	const failures: string[] = [];

	/** Assert two scalars are equal. */
	const eq = (name: string, actual: unknown, expected: unknown): void => {
		if (actual !== expected) failures.push(`${name}: expected ${String(expected)}, got ${String(actual)}`);
	};

	/** Assert a condition holds. */
	const ok = (name: string, condition: boolean): void => {
		if (!condition) failures.push(`${name}: expected to hold, did not`);
	};

	/** Assert a call throws, and say so when it does not. */
	const throws = (name: string, run: () => void): void => {
		try {
			run();
		} catch {
			return;
		}
		failures.push(`${name}: expected to throw, did not`);
	};

	/** Assert a call does NOT throw, and report the reason when it does. */
	const passes = (name: string, run: () => void): void => {
		try {
			run();
		} catch (err) {
			failures.push(`${name}: threw ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	// =========================================================================
	// THE HAND-BUILT DOCUMENT
	// =========================================================================

	const live = handBuiltLive();
	const copy = buildReplayCopy(live);

	// --- the input is not mutated --------------------------------------------
	eq('buildReplayCopy: the live document keeps its project id', live.project_id, 'live-project-id');
	eq('buildReplayCopy: the live document keeps its source', live.source, 'discord_1');
	eq('buildReplayCopy: the live document keeps its components', componentsOf(live).length, 4);

	// --- 1. the source -------------------------------------------------------
	eq('buildReplayCopy: the discord component is gone', componentById(copy, 'discord_1'), undefined);
	const source = componentById(copy, REPLAY_COPY_SOURCE);
	eq('buildReplayCopy: the source is a webhook', source?.provider, 'webhook');
	eq('buildReplayCopy: the source is named', source?.name, 'Test webhook');
	const sourceConfig = (source?.config ?? {}) as Record<string, unknown>;
	eq('buildReplayCopy: the source is a Source', sourceConfig.mode, 'Source');
	eq('buildReplayCopy: the source is typed webhook', sourceConfig.type, 'webhook');
	eq('buildReplayCopy: the source hides its form', sourceConfig.hideForm, true);
	ok('buildReplayCopy: the source keeps the original position', JSON.stringify(source?.ui) === JSON.stringify({ position: { x: 10, y: 20 } }));
	eq('buildReplayCopy: the top-level source field is repointed', copy.source, REPLAY_COPY_SOURCE);
	const agent = componentById(copy, 'agent_crewai_1');
	ok('buildReplayCopy: the agent’s lanes are repointed', JSON.stringify(edgesOf(agent ?? {})) === JSON.stringify([REPLAY_COPY_SOURCE, REPLAY_COPY_SOURCE]));

	// --- 2. the Slack component and its edges --------------------------------
	eq('buildReplayCopy: the Slack component is gone', componentById(copy, 'tool_slack_1'), undefined);
	eq('buildReplayCopy: three components survive', componentsOf(copy).length, 3);
	const response = componentById(copy, 'response_answers_1');
	ok('buildReplayCopy: the edge fed by Slack is dropped', JSON.stringify(edgesOf(response ?? {})) === JSON.stringify(['agent_crewai_1']));

	// --- 3. the prompts ------------------------------------------------------
	const handInstructions = instructionsOf(agent);
	eq('buildReplayCopy: the Slack rule is dropped', handInstructions.length, 2);
	eq('buildReplayCopy: the first instruction is untouched', handInstructions[0], 'Answer the question.');
	ok('buildReplayCopy: the example keeps its reply text', handInstructions[1].includes('Escalated to the RocketRide team.'));
	ok('buildReplayCopy: the example loses the Slack call', !handInstructions[1].includes('tool_slack'));
	const agentConfig = (agent?.config ?? {}) as Record<string, unknown>;
	const inactive = (agentConfig.default ?? {}) as Record<string, unknown>;
	const inactiveInstructions = Array.isArray(inactive.instructions) ? (inactive.instructions as string[]) : [];
	eq('buildReplayCopy: the inactive profile loses its rule too', inactiveInstructions.length, 1);
	ok('buildReplayCopy: the inactive profile loses its Slack call', inactiveInstructions[0] === 'Be brief. Thanks.');

	// --- 4. the identity -----------------------------------------------------
	eq('buildReplayCopy: the project id is the copy’s', copy.project_id, REPLAY_COPY_PROJECT_ID);
	ok('buildReplayCopy: the copy’s project id is not a live one', !LIVE_PROJECT_IDS.includes(REPLAY_COPY_PROJECT_ID));

	// =========================================================================
	// THE GUARD
	// =========================================================================

	passes('assertReplayCopyIsolated: a clean copy passes', () => assertReplayCopyIsolated(copy, ['live-project-id', ...LIVE_PROJECT_IDS]));

	throws('assertReplayCopyIsolated: a live project id', () => assertReplayCopyIsolated({ ...copy, project_id: 'live-project-id' }, ['live-project-id']));

	throws('assertReplayCopyIsolated: a discord component', () => assertReplayCopyIsolated({ ...copy, components: [...componentsOf(copy), { id: 'discord_9', provider: 'discord' }] }, LIVE_PROJECT_IDS));

	throws('assertReplayCopyIsolated: a tool_discord component', () => assertReplayCopyIsolated({ ...copy, components: [...componentsOf(copy), { id: 'td_1', provider: 'tool_discord' }] }, LIVE_PROJECT_IDS));

	throws('assertReplayCopyIsolated: a tool_slack component', () => assertReplayCopyIsolated({ ...copy, components: [...componentsOf(copy), { id: 'ts_1', provider: 'tool_slack' }] }, LIVE_PROJECT_IDS));

	throws('assertReplayCopyIsolated: a surviving Slack instruction', () => assertReplayCopyIsolated(buildReplayCopyWithText(copy, 'call tool_slack_1_message_post'), LIVE_PROJECT_IDS));

	throws('assertReplayCopyIsolated: a surviving Slack rule', () => assertReplayCopyIsolated(buildReplayCopyWithText(copy, 'SLACK PAGING — HARD RULE'), LIVE_PROJECT_IDS));

	throws('assertReplayCopyIsolated: no webhook source', () =>
		assertReplayCopyIsolated(
			{
				...copy,
				source: 'agent_crewai_1',
			},
			LIVE_PROJECT_IDS
		)
	);

	// =========================================================================
	// THE DESCRIPTION
	// =========================================================================

	const described = describeReplayCopy(copy);
	eq('describeReplayCopy: project id', described.projectId, REPLAY_COPY_PROJECT_ID);
	eq('describeReplayCopy: source', described.source, REPLAY_COPY_SOURCE);
	eq('describeReplayCopy: component count', described.componentCount, 3);
	ok('describeReplayCopy: providers list the webhook', described.providers.includes('webhook'));
	ok('describeReplayCopy: providers do not list discord', !described.providers.includes('discord'));
	eq('describeReplayCopy: all three forbidden providers are absent', described.removed.length, 3);

	// =========================================================================
	// CAPTURE — the component, its wiring and its keys
	// =========================================================================

	/** The hand-built live pipe with capture added, as the bot would run it. */
	const withCapture = (): Record<string, unknown> => {
		const live = handBuiltLive();
		const components = componentsOf(live);
		const source = components[0];
		source.config = {
			...((source.config ?? {}) as Record<string, unknown>),
			parameters: {
				...(((source.config ?? {}) as Record<string, unknown>).parameters as Record<string, unknown>),
				captureEvents: true,
				captureNodeId: CAPTURE_NODE_ID,
				captureSource: 'discord:discord_1+tool_slack',
			},
		};
		components.push({
			id: CAPTURE_NODE_ID,
			provider: 'db_postgres',
			name: 'Dashboard database',
			config: {
				profile: 'default',
				default: { host: CONN.host, table: 'dd_events', allow_execute: true },
				parameters: {},
			},
			control: [{ classType: 'tool', from: 'discord_1' }],
		});
		return live;
	};

	const captureCopy = buildReplayCopy(withCapture());

	eq('buildReplayCopy: the capture component is gone', componentById(captureCopy, CAPTURE_NODE_ID), undefined);
	eq('buildReplayCopy: only the three survivors remain', componentsOf(captureCopy).length, 3);
	ok('buildReplayCopy: no db_postgres component survives', !componentsOf(captureCopy).some((component) => component.provider === 'db_postgres'));
	{
		const source = componentById(captureCopy, REPLAY_COPY_SOURCE);
		const config = (source?.config ?? {}) as Record<string, unknown>;
		const parameters = (config.parameters ?? {}) as Record<string, unknown>;
		eq('buildReplayCopy: the source loses captureEvents', parameters.captureEvents, undefined);
		eq('buildReplayCopy: the source loses captureNodeId', parameters.captureNodeId, undefined);
		eq('buildReplayCopy: the source loses captureSource', parameters.captureSource, undefined);
	}
	ok('buildReplayCopy: no capture key survives anywhere', !JSON.stringify(captureCopy).includes('captureEvents') && !JSON.stringify(captureCopy).includes('captureNodeId') && !JSON.stringify(captureCopy).includes('captureSource'));
	passes('assertReplayCopyIsolated: the capture copy passes', () => assertReplayCopyIsolated(captureCopy, LIVE_PROJECT_IDS));

	// A database wired to the copy's OWN source is a capture component by
	// construction, whatever its config says — and the guard says so.
	throws('assertReplayCopyIsolated: a db component wired to the source', () =>
		assertReplayCopyIsolated(
			{
				...captureCopy,
				components: [
					...componentsOf(captureCopy),
					{
						id: CAPTURE_NODE_ID,
						provider: 'db_postgres',
						control: [{ classType: 'tool', from: REPLAY_COPY_SOURCE }],
					},
				],
			},
			LIVE_PROJECT_IDS
		)
	);

	throws('assertReplayCopyIsolated: a rocketride_sql component wired to the source', () =>
		assertReplayCopyIsolated(
			{
				...captureCopy,
				components: [
					...componentsOf(captureCopy),
					{
						id: 'capture_cloud',
						provider: 'rocketride_sql',
						control: [{ classType: 'tool', from: REPLAY_COPY_SOURCE }],
					},
				],
			},
			LIVE_PROJECT_IDS
		)
	);

	// The component can be gone while a node is still told to write to it.
	throws('assertReplayCopyIsolated: a surviving captureEvents', () => {
		const poisoned = JSON.parse(JSON.stringify(captureCopy)) as Record<string, unknown>;
		const source = componentById(poisoned, REPLAY_COPY_SOURCE);
		const config = (source?.config ?? {}) as Record<string, unknown>;
		config.parameters = { ...((config.parameters ?? {}) as Record<string, unknown>), captureEvents: true };
		assertReplayCopyIsolated(poisoned, LIVE_PROJECT_IDS);
	});

	// The data pipe is a live task like any other: a copy that took its id
	// would restart the dashboard's own database connection.
	ok('LIVE_PROJECT_IDS: the data pipe is guarded', LIVE_PROJECT_IDS.includes(DATA_PROJECT_ID));
	throws('assertReplayCopyIsolated: the data pipe’s project id', () => assertReplayCopyIsolated({ ...captureCopy, project_id: DATA_PROJECT_ID }, LIVE_PROJECT_IDS));

	// =========================================================================
	// THE SANITIZER — the node's own cases
	// =========================================================================

	const markers = ['Escalated to the RocketRide team.'];

	eq('sanitizeShownReply: a plain answer is untouched', sanitizeShownReply('Just install it.', markers), 'Just install it.');
	eq('sanitizeShownReply: empty stays empty', sanitizeShownReply('', markers), '');
	eq('sanitizeShownReply: whitespace is trimmed to empty', sanitizeShownReply('   \n ', markers), '');
	eq('sanitizeShownReply: only what follows the last Final Answer', sanitizeShownReply('Thought: hmm\nFinal Answer: one\nFinal Answer: two', markers), 'two');
	eq('sanitizeShownReply: an empty tail keeps the whole text', sanitizeShownReply('All of it. Final Answer:   ', markers), 'All of it. Final Answer:');
	eq('sanitizeShownReply: scratchpad with no marker is suppressed', sanitizeShownReply('Thought: I should search the docs', markers), '');
	eq('sanitizeShownReply: Action Input counts as scratchpad', sanitizeShownReply('Action Input: {"q": "x"}', markers), '');
	eq('sanitizeShownReply: scratchpad carrying a marker becomes the hand-off line', sanitizeShownReply('Thought: cannot answer. Escalated to the RocketRide team.', markers), "Thanks for flagging this — I've looped in the team to take a look. Escalated to the RocketRide team.");

	// =========================================================================
	// THE REAL PIPE — discord-ralph-slack.pipe, resolved as the bot would run it
	// =========================================================================

	const liveRalph = resolvePipeline(PIPELINES.ralphSlack, DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
	const liveRalphProjectId = String(liveRalph.project_id ?? '');
	const ralphCopy = buildReplayCopy(liveRalph);
	const ralphComponents = componentsOf(ralphCopy);

	ok('ralphSlack copy: no forbidden provider survives', !ralphComponents.some((component) => ['discord', 'tool_discord', 'tool_slack'].includes(String(component.provider ?? ''))));
	eq('ralphSlack copy: the webhook source is present', componentById(ralphCopy, REPLAY_COPY_SOURCE)?.provider, 'webhook');
	eq('ralphSlack copy: the source field is repointed', ralphCopy.source, REPLAY_COPY_SOURCE);
	eq('ralphSlack copy: the project id is the copy’s', ralphCopy.project_id, REPLAY_COPY_PROJECT_ID);
	ok('ralphSlack copy: the project id differs from the live pipe’s', liveRalphProjectId.length > 0 && ralphCopy.project_id !== liveRalphProjectId);
	eq('ralphSlack copy: one component fewer than the live pipe', ralphComponents.length, componentsOf(liveRalph).length - 1);

	// EVERY edge points at a component that exists. This is the assertion that
	// catches a swap or a removal that forgot its wiring — the failure that makes
	// a copy refuse to start.
	const ralphIds = new Set(ralphComponents.map((component) => String(component.id ?? '')));
	const dangling: string[] = [];
	for (const component of ralphComponents) {
		for (const from of edgesOf(component)) {
			if (!ralphIds.has(from)) dangling.push(`${String(component.id ?? '?')} ← ${from}`);
		}
	}
	eq(`ralphSlack copy: no dangling edge (${dangling.join(', ')})`, dangling.length, 0);

	// The two prompt rules, counted. 55 instructions ship; the SLACK PAGING rule
	// is one of them, and nothing else may be dropped.
	const ralphAgent = componentById(ralphCopy, 'agent_crewai_1');
	const ralphInstructions = instructionsOf(ralphAgent);
	const liveInstructions = instructionsOf(componentById(liveRalph, 'agent_crewai_1'));
	eq('ralphSlack copy: the live pipe still ships 55 instructions', liveInstructions.length, 55);
	eq('ralphSlack copy: exactly the Slack rule is dropped', ralphInstructions.length, 54);
	ok('ralphSlack copy: no instruction starts with SLACK PAGING', !ralphInstructions.some((entry) => entry.trimStart().startsWith('SLACK PAGING')));

	// The escalation EXAMPLE survives as an example: its reply text is what teaches
	// the wording `classifyRalphReply` then scores an escalation by.
	const doubleCharge = ralphInstructions.find((entry) => entry.includes('charged twice'));
	ok('ralphSlack copy: the double-charge example survives', doubleCharge !== undefined);
	ok('ralphSlack copy: the double-charge example keeps the escalation line', (doubleCharge ?? '').includes('Escalated to the RocketRide team.'));
	ok('ralphSlack copy: the double-charge example has no Slack call', !(doubleCharge ?? '').includes('tool_slack'));

	// And the whole document passes the guard it will be run through.
	passes('ralphSlack copy: passes the isolation guard', () => assertReplayCopyIsolated(ralphCopy, LIVE_PROJECT_IDS));

	// =========================================================================
	// THE REAL PIPE, AS THE BOT ACTUALLY RUNS IT — capture and all
	// =========================================================================
	//
	// The copy above was resolved without a connection, so it never had a
	// capture component to lose. This one is the document the bot really
	// starts: Slack, capture, and only the discord source told to write.

	const liveCapturing = resolvePipeline(PIPELINES.ralphSlack, DEFAULT_SETTINGS, {
		conn: CONN,
	}) as unknown as Record<string, unknown>;

	ok('resolvePipeline: the bot pipe gains a capture component', componentById(liveCapturing, CAPTURE_NODE_ID)?.provider === 'db_postgres');
	{
		const capture = componentById(liveCapturing, CAPTURE_NODE_ID);
		const froms = Array.isArray(capture?.control) ? (capture?.control as Record<string, unknown>[]).map((edge) => String(edge.from ?? '')) : [];
		ok(`resolvePipeline: the discord source may write (${froms.join(', ')})`, froms.includes('discord_1'));
		eq('resolvePipeline: only the discord source may write', froms.length, 1);
		const source = componentById(liveCapturing, 'discord_1');
		const parameters = ((source?.config ?? {}) as Record<string, unknown>).parameters as Record<string, unknown>;
		eq('resolvePipeline: the source captures', parameters?.captureEvents, true);
		eq("resolvePipeline: the source names the app's capture table", parameters?.captureTable, 'dd_events');
		eq('resolvePipeline: the source knows where', parameters?.captureNodeId, CAPTURE_NODE_ID);
		eq('resolvePipeline: the source says it pages Slack', parameters?.captureSource, 'discord:discord_1+tool_slack');
		// The capture keys must not have cost the source its own settings.
		eq('resolvePipeline: the source keeps its reply mode', parameters?.replyMode, 'thread');
		const slack = componentById(liveCapturing, 'tool_slack_1');
		const slackConfig = (slack?.config ?? {}) as Record<string, unknown>;
		eq('resolvePipeline: the Slack tool is left alone', slackConfig.captureEvents, undefined);
		eq('resolvePipeline: the Slack tool gets no capture node', slackConfig.captureNodeId, undefined);
		eq('resolvePipeline: the Slack tool keeps its webhook', typeof slackConfig.webhookUrl, 'string');
	}

	// Capture off is capture absent, whatever a connection says.
	{
		const quiet = resolvePipeline(PIPELINES.ralphSlack, { ...DEFAULT_SETTINGS, advanced: { ...DEFAULT_SETTINGS.advanced, captureToDatabase: false } }, { conn: CONN }) as unknown as Record<string, unknown>;
		eq('resolvePipeline: capture off adds no component', componentById(quiet, CAPTURE_NODE_ID), undefined);
		ok('resolvePipeline: capture off writes no keys', !JSON.stringify(quiet).includes('captureEvents'));
	}

	const capturingCopy = buildReplayCopy(liveCapturing);
	eq('ralphSlack+capture copy: the capture component is gone', componentById(capturingCopy, CAPTURE_NODE_ID), undefined);
	eq('ralphSlack+capture copy: two components fewer than the live pipe', componentsOf(capturingCopy).length, componentsOf(liveCapturing).length - 2);
	ok('ralphSlack+capture copy: no capture key survives', !JSON.stringify(capturingCopy).includes('captureEvents'));
	// Every edge still points at something that exists — the assertion that
	// catches a removal that forgot its wiring.
	{
		const ids = new Set(componentsOf(capturingCopy).map((component) => String(component.id ?? '')));
		const broken: string[] = [];
		for (const component of componentsOf(capturingCopy)) {
			for (const from of edgesOf(component)) {
				if (!ids.has(from)) broken.push(`${String(component.id ?? '?')} ← ${from}`);
			}
		}
		eq(`ralphSlack+capture copy: no dangling edge (${broken.join(', ')})`, broken.length, 0);
	}
	passes('ralphSlack+capture copy: passes the isolation guard', () => assertReplayCopyIsolated(capturingCopy, LIVE_PROJECT_IDS));

	return failures;
}

// =============================================================================
// FIXTURE HELPERS
// =============================================================================

/**
 * A copy with one extra string smuggled into an agent instruction.
 *
 * The guard reads EVERY string in the document, so the cheapest way to prove that
 * is to put the forbidden text somewhere the provider check cannot see it.
 *
 * @param copy - A clean copy.
 * @param text - The string to smuggle in.
 * @returns A document that should fail {@link assertReplayCopyIsolated}.
 */
function buildReplayCopyWithText(copy: Record<string, unknown>, text: string): Record<string, unknown> {
	const poisoned = JSON.parse(JSON.stringify(copy)) as Record<string, unknown>;
	const agent = componentById(poisoned, 'agent_crewai_1');
	const config = (agent?.config ?? {}) as Record<string, unknown>;
	const instructions = Array.isArray(config.instructions) ? (config.instructions as string[]) : [];
	config.instructions = [...instructions, text];
	return poisoned;
}
