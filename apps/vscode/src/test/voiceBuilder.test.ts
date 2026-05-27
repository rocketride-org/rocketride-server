// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	buildVoiceBuilderPipeline,
	extractJsonObject,
	getVoiceBuilderStatus,
	parseVoicePipelineResult,
	processVoiceBuilderRecording,
	sanitizeVoiceProjectEdit,
} from '../providers/voice/voiceBuilder';

const SERVICES = {
	llm_gemini: {
		title: 'Gemini',
		classType: ['llm'],
		lanes: { questions: ['answers'] },
	},
	llm_anthropic: {
		title: 'Anthropic',
		classType: ['llm'],
		lanes: { questions: ['answers'] },
	},
	webhook: {
		title: 'Web Hook',
		classType: ['source'],
		lanes: { _source: ['audio'] },
	},
};

const CURRENT_PROJECT = {
	project_id: 'project-1',
	components: [
		{
			id: 'chat_1',
			provider: 'chat',
			config: { hideForm: true, mode: 'Source', parameters: {}, type: 'chat' },
		},
	],
};

test('extractJsonObject parses a plain JSON object', () => {
	assert.deepEqual(extractJsonObject('{"project":{"components":[]},"summary":"done"}'), {
		project: { components: [] },
		summary: 'done',
	});
});

test('extractJsonObject parses a fenced JSON object', () => {
	const content = ['Here is the edit:', '```json', '{"project":{"components":[{"id":"llm"}]}}', '```'].join('\n');
	assert.deepEqual(extractJsonObject(content), {
		project: { components: [{ id: 'llm' }] },
	});
});

test('extractJsonObject ignores braces inside string values', () => {
	const content = '{"project":{"components":[]},"summary":"Added {Gemini} node"} trailing text';
	assert.deepEqual(extractJsonObject(content), {
		project: { components: [] },
		summary: 'Added {Gemini} node',
	});
});

test('sanitizeVoiceProjectEdit strips viewport and increments document revision', () => {
	const currentProject = {
		project_id: 'project-1',
		docRevision: 7,
		components: [{ id: 'chat', provider: 'chat' }],
	};
	const generatedProject = {
		project_id: 'project-1',
		docRevision: 2,
		viewport: { x: 10, y: 20, zoom: 1 },
		components: [{ id: 'chat', provider: 'chat' }, { id: 'llm', provider: 'llm_gemini' }],
	};

	const sanitized = sanitizeVoiceProjectEdit(currentProject, generatedProject);

	assert.equal(sanitized.project_id, 'project-1');
	assert.equal(sanitized.docRevision, 8);
	assert.equal('viewport' in sanitized, false);
	assert.deepEqual(sanitized.components, generatedProject.components);
});

test('sanitizeVoiceProjectEdit rejects missing components', () => {
	assert.throws(
		() => sanitizeVoiceProjectEdit({ project_id: 'project-1', components: [] }, { project_id: 'project-1' }),
		/return project components/
	);
});

test('sanitizeVoiceProjectEdit rejects project_id changes', () => {
	assert.throws(
		() => sanitizeVoiceProjectEdit({ project_id: 'project-1', components: [] }, { project_id: 'project-2', components: [] }),
		/change project_id/
	);
});

test('getVoiceBuilderStatus is disabled when the feature flag is off', () => {
	const status = getVoiceBuilderStatus(
		{ enabled: false, llmProvider: 'llm_gemini', llmProfile: 'gemini-2_5-flash' },
		{ llmApiKey: 'provider-key' },
		CURRENT_PROJECT,
		SERVICES
	);

	assert.equal(status.enabled, false);
	assert.deepEqual(status.errors, ['Voice Builder is disabled']);
});

test('getVoiceBuilderStatus reports missing LLM provider', () => {
	const status = getVoiceBuilderStatus(
		{ enabled: true, llmProvider: '', llmProfile: '' },
		{ llmApiKey: '' },
		{ project_id: 'project-1', components: [] },
		SERVICES
	);

	assert.equal(status.enabled, false);
	assert.deepEqual(status.errors, ['Select a Voice Builder LLM provider or add a configured LLM node to this pipeline']);
});

test('getVoiceBuilderStatus is enabled when a configured provider is selected', () => {
	const status = getVoiceBuilderStatus(
		{ enabled: true, llmProvider: 'llm_gemini', llmProfile: 'gemini-2_5-flash' },
		{ llmApiKey: 'provider-key' },
		CURRENT_PROJECT,
		SERVICES
	);

	assert.equal(status.enabled, true);
	assert.equal(status.model, 'llm_gemini');
	assert.deepEqual(status.errors, []);
});

test('buildVoiceBuilderPipeline creates an audio transcribe pipeline around the selected LLM provider', () => {
	const pipeline = buildVoiceBuilderPipeline({
		config: { enabled: true, llmProvider: 'llm_gemini', llmProfile: 'gemini-2_5-flash' },
		secrets: { llmApiKey: 'provider-key' },
		currentProject: CURRENT_PROJECT,
		services: SERVICES,
	});

	assert.equal(pipeline.source, 'voice_builder_webhook');
	assert.equal(pipeline.project_id, 'voice-builder-project-1');
	assert.deepEqual(
		pipeline.components.map((component) => component.provider),
		['webhook', 'audio_transcribe', 'prompt', 'llm_gemini', 'response']
	);

	const transcribe = pipeline.components.find((component) => component.id === 'voice_builder_transcribe');
	assert.deepEqual(transcribe?.input, [{ lane: 'audio', from: 'voice_builder_webhook' }]);

	const llm = pipeline.components.find((component) => component.id === 'voice_builder_llm');
	assert.equal(llm?.provider, 'llm_gemini');
	assert.equal(llm?.config.profile, 'gemini-2_5-flash');
	assert.deepEqual(llm?.config['gemini-2_5-flash'], { apikey: 'provider-key' });
	assert.deepEqual(llm?.input, [{ lane: 'questions', from: 'voice_builder_prompt' }]);
});

test('buildVoiceBuilderPipeline clones the first project LLM when no provider is selected', () => {
	const currentProject = {
		project_id: 'project-1',
		components: [
			{ id: 'chat_1', provider: 'chat', config: {} },
			{
				id: 'llm_anthropic_1',
				provider: 'llm_anthropic',
				config: { profile: 'claude-sonnet-4-6', 'claude-sonnet-4-6': { apikey: '${ROCKETRIDE_ANTHROPIC_KEY}' }, parameters: {} },
			},
		],
	};

	const pipeline = buildVoiceBuilderPipeline({
		config: { enabled: true, llmProvider: '', llmProfile: '' },
		secrets: { llmApiKey: '' },
		currentProject,
		services: SERVICES,
	});

	const llm = pipeline.components.find((component) => component.id === 'voice_builder_llm');
	assert.equal(llm?.provider, 'llm_anthropic');
	assert.deepEqual(llm?.config, currentProject.components[1].config);
});

test('buildVoiceBuilderPipeline rejects a configured provider that is not an LLM', () => {
	assert.throws(
		() =>
			buildVoiceBuilderPipeline({
				config: { enabled: true, llmProvider: 'webhook', llmProfile: '' },
				secrets: { llmApiKey: '' },
				currentProject: CURRENT_PROJECT,
				services: SERVICES,
			}),
		/Voice Builder provider must be an LLM/
	);
});

test('parseVoicePipelineResult reads transcript and planner JSON from a RocketRide response', () => {
	const result = parseVoicePipelineResult(
		{
			name: 'voice',
			path: '',
			objectId: 'object-1',
			result_types: { transcript: 'text', planner: 'answers' },
			transcript: ['Add Gemini.'],
			planner: ['{"project":{"project_id":"project-1","components":[]},"summary":"Added Gemini"}'],
		},
		CURRENT_PROJECT
	);

	assert.equal(result.transcript, 'Add Gemini.');
	assert.equal(result.summary, 'Added Gemini');
	assert.deepEqual(result.project.components, []);
});

test('processVoiceBuilderRecording runs and terminates a temporary RocketRide pipeline', async () => {
	const calls: string[] = [];
	const client = {
		async use(options: any) {
			calls.push(`use:${options.pipeline.source}`);
			return { token: 'task-token' };
		},
		async send(token: string, data: Uint8Array, objinfo: Record<string, unknown>, mimeType?: string) {
			calls.push(`send:${token}:${mimeType}:${data.length}:${objinfo.name}`);
			return {
				name: 'voice',
				path: '',
				objectId: 'object-1',
				transcript: ['Add Gemini.'],
				planner: ['{"project":{"project_id":"project-1","components":[]},"summary":"Added Gemini"}'],
			};
		},
		async terminate(token: string) {
			calls.push(`terminate:${token}`);
		},
	};

	const result = await processVoiceBuilderRecording(
		{
			audioBase64: Buffer.from('audio').toString('base64'),
			mimeType: 'audio/webm',
			currentProject: CURRENT_PROJECT,
			services: SERVICES,
		},
		{ enabled: true, llmProvider: 'llm_gemini', llmProfile: 'gemini-2_5-flash' },
		{ llmApiKey: 'provider-key' },
		client
	);

	assert.equal(result.transcript, 'Add Gemini.');
	assert.deepEqual(calls, ['use:voice_builder_webhook', 'send:task-token:audio/webm:5:voice-command.webm', 'terminate:task-token']);
});
