// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, getVoiceBuilderStatus, sanitizeVoiceProjectEdit } from '../providers/voice/voiceBuilder';

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
		{ enabled: false, plannerBaseUrl: 'https://api.openai.com/v1', plannerModel: 'gpt-4o-mini' },
		{ deepgramApiKey: 'dg-key', plannerApiKey: 'planner-key' }
	);

	assert.equal(status.enabled, false);
	assert.deepEqual(status.errors, ['Voice Builder is disabled']);
});

test('getVoiceBuilderStatus reports missing provider keys', () => {
	const status = getVoiceBuilderStatus(
		{ enabled: true, plannerBaseUrl: 'https://api.openai.com/v1', plannerModel: 'gpt-4o-mini' },
		{ deepgramApiKey: '', plannerApiKey: '' }
	);

	assert.equal(status.enabled, false);
	assert.deepEqual(status.errors, ['Deepgram API key not configured', 'Planner API key not configured']);
});

test('getVoiceBuilderStatus is enabled when configured', () => {
	const status = getVoiceBuilderStatus(
		{ enabled: true, plannerBaseUrl: 'https://api.openai.com/v1', plannerModel: 'gpt-4o-mini' },
		{ deepgramApiKey: 'dg-key', plannerApiKey: 'planner-key' }
	);

	assert.equal(status.enabled, true);
	assert.equal(status.model, 'gpt-4o-mini');
	assert.deepEqual(status.errors, []);
});
