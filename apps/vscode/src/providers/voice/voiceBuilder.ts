// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Host-side helpers for the Voice Builder flow.
 *
 * The webview records one short push-to-talk audio turn. The extension host
 * sends that audio through a temporary RocketRide pipeline so transcription and
 * planning use existing RocketRide nodes instead of provider-specific host
 * integrations.
 */

import type { PIPELINE_RESULT, PipelineComponent, PipelineConfig } from 'rocketride';

export interface IVoiceBuilderConfig {
	enabled: boolean;
	llmProvider: string;
	llmProfile: string;
}

export interface IVoiceBuilderSecrets {
	llmApiKey: string;
}

export interface IVoiceBuilderStatus {
	enabled: boolean;
	errors: string[];
	model?: string;
}

export interface IVoiceRecordingRequest {
	audioBase64: string;
	mimeType?: string;
}

export interface IVoiceProjectEditResponse {
	project: Record<string, any>;
	summary?: string;
}

export interface IVoiceBuilderProcessRequest extends IVoiceRecordingRequest {
	currentProject: Record<string, any>;
	services: Record<string, unknown>;
}

export interface IVoiceBuilderProcessResponse extends IVoiceProjectEditResponse {
	transcript: string;
}

export interface IVoiceBuilderPipelineRequest {
	config: IVoiceBuilderConfig;
	secrets: Partial<IVoiceBuilderSecrets>;
	currentProject: Record<string, any>;
	services: Record<string, unknown>;
}

export interface IVoiceBuilderClient {
	use(options: { pipeline: PipelineConfig; source?: string; ttl?: number; pipelineTraceLevel?: 'none' | 'metadata' | 'summary' | 'full'; name?: string; args?: string[] }): Promise<Record<string, unknown> & { token: string }>;
	send(token: string, data: string | Uint8Array, objinfo?: Record<string, unknown>, mimetype?: string): Promise<PIPELINE_RESULT | undefined>;
	terminate(token: string): Promise<void>;
}

const DEFAULT_AUDIO_MIME_TYPE = 'audio/webm';
const MISSING_LLM_MESSAGE = 'Select a Voice Builder LLM provider or add a configured LLM node to this pipeline';
const VOICE_PIPELINE_TTL_SECONDS = 120;

function getRevision(project: Record<string, any> | undefined): number {
	return typeof project?.docRevision === 'number' ? project.docRevision : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function hasClassType(service: unknown, classType: string): boolean {
	if (!isRecord(service)) return false;
	const rawClassType = service.classType;
	return Array.isArray(rawClassType) && rawClassType.includes(classType);
}

function isLlmProvider(provider: string, services: Record<string, unknown>): boolean {
	const service = services[provider];
	if (service) return hasClassType(service, 'llm');
	return provider.startsWith('llm_');
}

function summarizeServices(services: Record<string, unknown>): Array<Record<string, unknown>> {
	return Object.entries(services).map(([provider, raw]) => {
		const service = raw as Record<string, unknown>;
		return {
			provider,
			title: service.title,
			classType: service.classType,
			lanes: service.lanes,
		};
	});
}

function findProjectLlmComponent(currentProject: Record<string, any>, services: Record<string, unknown>): PipelineComponent | undefined {
	const components = Array.isArray(currentProject.components) ? (currentProject.components as PipelineComponent[]) : [];
	return components.find((component) => isLlmProvider(component.provider, services));
}

function createSelectedLlmComponent(config: IVoiceBuilderConfig, secrets: Partial<IVoiceBuilderSecrets>, services: Record<string, unknown>): PipelineComponent {
	const provider = config.llmProvider.trim();
	if (!provider) throw new Error(MISSING_LLM_MESSAGE);
	if (!isLlmProvider(provider, services)) throw new Error('Voice Builder provider must be an LLM');

	const profile = config.llmProfile.trim();
	const llmConfig: Record<string, unknown> = { parameters: {} };
	const apiKey = secrets.llmApiKey?.trim();
	if (profile) {
		llmConfig.profile = profile;
		llmConfig[profile] = apiKey ? { apikey: apiKey } : {};
	} else if (apiKey) {
		llmConfig.apikey = apiKey;
	}

	return {
		id: 'voice_builder_llm',
		provider,
		config: llmConfig,
		input: [{ lane: 'questions', from: 'voice_builder_prompt' }],
		ui: { position: { x: 680, y: 180 }, measured: { width: 150, height: 66 }, nodeType: 'default', formDataValid: true },
	};
}

function createProjectLlmComponent(currentProject: Record<string, any>, services: Record<string, unknown>): PipelineComponent {
	const projectLlm = findProjectLlmComponent(currentProject, services);
	if (!projectLlm) throw new Error(MISSING_LLM_MESSAGE);

	return {
		...deepClone(projectLlm),
		id: 'voice_builder_llm',
		input: [{ lane: 'questions', from: 'voice_builder_prompt' }],
		control: undefined,
		ui: { position: { x: 680, y: 180 }, measured: { width: 150, height: 66 }, nodeType: 'default', formDataValid: true },
	};
}

function resolveVoiceLlmComponent(request: IVoiceBuilderPipelineRequest): PipelineComponent {
	if (request.config.llmProvider.trim()) {
		return createSelectedLlmComponent(request.config, request.secrets, request.services);
	}
	return createProjectLlmComponent(request.currentProject, request.services);
}

function buildPlannerInstructions(currentProject: Record<string, any>, services: Record<string, unknown>): string[] {
	return [
		'You are RocketRide Voice Builder.',
		'The incoming text is a transcribed voice command for editing a RocketRide .pipe project.',
		'Return JSON only with this shape: {"project": <full updated project>, "summary": "short change summary"}.',
		'The project must keep the same project_id.',
		'The project must include a components array.',
		'Use only providers present in the service catalog or already present in the project.',
		'Preserve existing component IDs unless the user explicitly asks to delete or replace those components.',
		`Current project JSON: ${JSON.stringify(currentProject)}`,
		`Available services JSON: ${JSON.stringify(summarizeServices(services))}`,
	];
}

export function getVoiceBuilderStatus(config: IVoiceBuilderConfig, secrets: Partial<IVoiceBuilderSecrets>, currentProject: Record<string, any> = {}, services: Record<string, unknown> = {}): IVoiceBuilderStatus {
	if (!config.enabled) {
		return { enabled: false, errors: ['Voice Builder is disabled'], model: config.llmProvider || undefined };
	}

	const errors: string[] = [];
	const provider = config.llmProvider.trim();
	if (provider) {
		if (!isLlmProvider(provider, services)) errors.push('Voice Builder provider must be an LLM');
	} else if (!findProjectLlmComponent(currentProject, services)) {
		errors.push(MISSING_LLM_MESSAGE);
	}

	return {
		enabled: errors.length === 0,
		errors,
		model: provider || findProjectLlmComponent(currentProject, services)?.provider,
	};
}

export function extractJsonObject(content: string): Record<string, unknown> {
	const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const raw = (fence?.[1] ?? content).trim();
	const start = raw.indexOf('{');
	if (start === -1) throw new Error('LLM response did not contain JSON');

	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < raw.length; i++) {
		const ch = raw[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (inString && ch === '\\') {
			escape = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (!inString) {
			if (ch === '{') depth++;
			if (ch === '}') {
				depth--;
				if (depth === 0) {
					return JSON.parse(raw.slice(start, i + 1)) as Record<string, unknown>;
				}
			}
		}
	}

	throw new Error('LLM response contained incomplete JSON');
}

export function sanitizeVoiceProjectEdit(currentProject: Record<string, any>, generatedProject: Record<string, any>): Record<string, any> {
	if (!generatedProject || typeof generatedProject !== 'object') {
		throw new Error('Voice edit did not return a project');
	}
	if (!Array.isArray(generatedProject.components)) {
		throw new Error('Voice edit did not return project components');
	}
	if (generatedProject.project_id !== currentProject.project_id) {
		throw new Error('Voice edit attempted to change project_id');
	}

	const nextProject: Record<string, any> = {
		...currentProject,
		...generatedProject,
		project_id: currentProject.project_id,
		docRevision: Math.max(getRevision(currentProject) + 1, getRevision(generatedProject)),
	};

	delete nextProject.viewport;
	return nextProject;
}

export function buildVoiceBuilderPipeline(request: IVoiceBuilderPipelineRequest): PipelineConfig {
	const llm = resolveVoiceLlmComponent(request);
	const projectId = String(request.currentProject.project_id || 'voice-builder');

	return {
		project_id: `voice-builder-${projectId}`,
		source: 'voice_builder_webhook',
		version: 1,
		components: [
			{
				id: 'voice_builder_webhook',
				provider: 'webhook',
				config: { hideForm: true, mode: 'Source', parameters: {}, type: 'webhook' },
				ui: { position: { x: 20, y: 180 }, measured: { width: 150, height: 66 }, nodeType: 'default', formDataValid: true },
			},
			{
				id: 'voice_builder_transcribe',
				provider: 'audio_transcribe',
				config: {
					profile: 'default',
					default: {
						model: 'base',
						silence_threshold: 0.25,
						min_seconds: 1,
						max_seconds: 20,
						vad_level: 1,
					},
				},
				input: [{ lane: 'audio', from: 'voice_builder_webhook' }],
				ui: { position: { x: 240, y: 180 }, measured: { width: 150, height: 66 }, nodeType: 'default', formDataValid: true },
			},
			{
				id: 'voice_builder_prompt',
				provider: 'prompt',
				config: { instructions: buildPlannerInstructions(request.currentProject, request.services), parameters: {} },
				input: [{ lane: 'text', from: 'voice_builder_transcribe' }],
				ui: { position: { x: 460, y: 180 }, measured: { width: 150, height: 66 }, nodeType: 'default', formDataValid: true },
			},
			llm,
			{
				id: 'voice_builder_response',
				provider: 'response',
				config: {
					lanes: [
						{ laneId: 'text', laneName: 'transcript' },
						{ laneId: 'answers', laneName: 'planner' },
					],
				},
				input: [
					{ lane: 'text', from: 'voice_builder_transcribe' },
					{ lane: 'answers', from: 'voice_builder_llm' },
				],
				ui: { position: { x: 900, y: 180 }, measured: { width: 150, height: 66 }, nodeType: 'default', formDataValid: true },
			},
		],
	};
}

function resultValueToText(value: unknown): string {
	if (Array.isArray(value)) {
		return value.map((item) => resultValueToText(item)).filter(Boolean).join('\n').trim();
	}
	if (typeof value === 'string') return value.trim();
	if (value === null || value === undefined) return '';
	if (isRecord(value)) {
		for (const key of ['text', 'content', 'answer']) {
			if (typeof value[key] === 'string') return String(value[key]).trim();
		}
		return JSON.stringify(value);
	}
	return String(value).trim();
}

export function parseVoicePipelineResult(result: PIPELINE_RESULT | undefined, currentProject: Record<string, any>): IVoiceBuilderProcessResponse {
	if (!result) throw new Error('Voice Builder pipeline returned no result');

	const transcript = resultValueToText(result.transcript ?? result.text);
	if (!transcript) throw new Error('Voice Builder pipeline returned no transcript');

	const plannerContent = resultValueToText(result.planner ?? result.answers);
	if (!plannerContent) throw new Error('Voice Builder pipeline returned no planner output');

	const parsed = extractJsonObject(plannerContent);
	const project = parsed.project as Record<string, any> | undefined;
	if (!project) throw new Error('Voice planner response did not include a project');

	return {
		transcript,
		project: sanitizeVoiceProjectEdit(currentProject, project),
		summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
	};
}

export async function processVoiceBuilderRecording(request: IVoiceBuilderProcessRequest, config: IVoiceBuilderConfig, secrets: IVoiceBuilderSecrets, client: IVoiceBuilderClient): Promise<IVoiceBuilderProcessResponse> {
	const status = getVoiceBuilderStatus(config, secrets, request.currentProject, request.services);
	if (!status.enabled) throw new Error(status.errors[0] ?? 'Voice Builder is not configured');
	if (!request.audioBase64) throw new Error('Voice recording is empty');

	const audio = Buffer.from(request.audioBase64, 'base64');
	if (audio.length === 0) throw new Error('Voice recording is empty');

	const pipeline = buildVoiceBuilderPipeline({ config, secrets, currentProject: request.currentProject, services: request.services });
	let token: string | undefined;
	try {
		const task = await client.use({
			pipeline,
			source: pipeline.source,
			ttl: VOICE_PIPELINE_TTL_SECONDS,
			pipelineTraceLevel: 'summary',
			name: 'Voice Builder',
		});
		token = task.token;
		const result = await client.send(
			token,
			audio,
			{
				name: request.mimeType?.includes('webm') ? 'voice-command.webm' : 'voice-command.audio',
				size: audio.length,
			},
			request.mimeType || DEFAULT_AUDIO_MIME_TYPE
		);
		return parseVoicePipelineResult(result, request.currentProject);
	} finally {
		if (token) {
			await client.terminate(token).catch(() => undefined);
		}
	}
}
