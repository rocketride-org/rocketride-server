// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Host-side helpers for the Voice Builder flow.
 *
 * Provider secrets stay in the VS Code extension host. The webview records a
 * short push-to-talk audio turn, sends the encoded audio here, and receives only
 * the transcript plus the sanitized project edit.
 */

export interface IVoiceBuilderConfig {
	enabled: boolean;
	plannerBaseUrl: string;
	plannerModel: string;
}

export interface IVoiceBuilderSecrets {
	deepgramApiKey: string;
	plannerApiKey: string;
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

export interface IVoiceProjectEditRequest {
	transcript: string;
	currentProject: Record<string, any>;
	services: Record<string, unknown>;
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

type FetchLike = typeof fetch;

const DEFAULT_AUDIO_MIME_TYPE = 'audio/webm';
const DEEPGRAM_PRERECORDED_URL = 'https://api.deepgram.com/v1/listen';
const VOICE_PROVIDER_TIMEOUT_MS = 20000;

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, '');
}

function getRevision(project: Record<string, any> | undefined): number {
	return typeof project?.docRevision === 'number' ? project.docRevision : 0;
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

function createTimeoutController(): { controller: AbortController; clear: () => void } {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), VOICE_PROVIDER_TIMEOUT_MS);
	return { controller, clear: () => clearTimeout(timeoutId) };
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

export function getVoiceBuilderStatus(config: IVoiceBuilderConfig, secrets: Partial<IVoiceBuilderSecrets>): IVoiceBuilderStatus {
	if (!config.enabled) {
		return { enabled: false, errors: ['Voice Builder is disabled'], model: config.plannerModel || undefined };
	}

	const errors: string[] = [];
	if (!secrets.deepgramApiKey) errors.push('Deepgram API key not configured');
	if (!secrets.plannerApiKey) errors.push('Planner API key not configured');
	if (!config.plannerBaseUrl) errors.push('Planner base URL not configured');
	if (!config.plannerModel) errors.push('Planner model not configured');

	return {
		enabled: errors.length === 0,
		errors,
		model: config.plannerModel || undefined,
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

export function buildVoicePlannerMessages(request: IVoiceProjectEditRequest): Array<{ role: 'system' | 'user'; content: string }> {
	return [
		{
			role: 'system',
			content: [
				'You are RocketRide Voice Builder.',
				'Update a RocketRide .pipe project from one transcribed voice command.',
				'Return JSON only with this shape: {"project": <full updated project>, "summary": "short change summary"}.',
				'The project must keep the same project_id.',
				'Use only providers present in the service catalog or already present in the project.',
				'Preserve existing component IDs unless the user explicitly asks to delete or replace those components.',
			].join(' '),
		},
		{
			role: 'user',
			content: JSON.stringify({
				transcript: request.transcript,
				currentProject: request.currentProject,
				availableServices: summarizeServices(request.services),
			}),
		},
	];
}

export async function transcribeVoiceRecording(request: IVoiceRecordingRequest, secrets: IVoiceBuilderSecrets, fetchImpl: FetchLike = fetch): Promise<string> {
	if (!request.audioBase64) throw new Error('Voice recording is empty');
	if (!secrets.deepgramApiKey) throw new Error('Deepgram API key not configured');

	const audio = Buffer.from(request.audioBase64, 'base64');
	if (audio.length === 0) throw new Error('Voice recording is empty');

	const url = new URL(DEEPGRAM_PRERECORDED_URL);
	url.searchParams.set('model', 'nova-2');
	url.searchParams.set('smart_format', 'true');

	const { controller, clear } = createTimeoutController();
	let res: Response;
	try {
		res = await fetchImpl(url.toString(), {
			method: 'POST',
			headers: {
				Authorization: `Token ${secrets.deepgramApiKey}`,
				'Content-Type': request.mimeType || DEFAULT_AUDIO_MIME_TYPE,
			},
			body: audio as any,
			signal: controller.signal,
		});
	} catch (error) {
		if (isAbortError(error)) throw new Error('Voice transcription timed out');
		throw error;
	} finally {
		clear();
	}

	if (!res.ok) {
		throw new Error(`Voice transcription failed: ${await res.text()}`);
	}

	const body = (await res.json()) as {
		results?: {
			channels?: Array<{
				alternatives?: Array<{ transcript?: string }>;
			}>;
		};
	};
	const transcript = body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
	if (!transcript) throw new Error('Voice transcription returned no text');
	return transcript;
}

export async function generateVoiceProjectEdit(request: IVoiceProjectEditRequest, config: IVoiceBuilderConfig, secrets: IVoiceBuilderSecrets, fetchImpl: FetchLike = fetch): Promise<IVoiceProjectEditResponse> {
	if (!request.transcript.trim()) throw new Error('Transcript is empty');
	if (!secrets.plannerApiKey) throw new Error('Planner API key not configured');
	if (!config.plannerBaseUrl) throw new Error('Planner base URL not configured');
	if (!config.plannerModel) throw new Error('Planner model not configured');

	const { controller, clear } = createTimeoutController();
	let res: Response;
	try {
		res = await fetchImpl(`${trimTrailingSlash(config.plannerBaseUrl)}/chat/completions`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${secrets.plannerApiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: config.plannerModel,
				messages: buildVoicePlannerMessages(request),
				temperature: 0.2,
				max_tokens: 3000,
			}),
			signal: controller.signal,
		});
	} catch (error) {
		if (isAbortError(error)) throw new Error('Voice planner timed out');
		throw error;
	} finally {
		clear();
	}

	if (!res.ok) {
		throw new Error(`Voice planner failed: ${await res.text()}`);
	}

	const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	const content = body.choices?.[0]?.message?.content ?? '';
	if (!content) throw new Error('Voice planner returned empty content');

	const parsed = extractJsonObject(content);
	const project = parsed.project as Record<string, any> | undefined;
	if (!project) throw new Error('Voice planner response did not include a project');

	return {
		project: sanitizeVoiceProjectEdit(request.currentProject, project),
		summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
	};
}

export async function processVoiceBuilderRecording(request: IVoiceBuilderProcessRequest, config: IVoiceBuilderConfig, secrets: IVoiceBuilderSecrets, fetchImpl: FetchLike = fetch): Promise<IVoiceBuilderProcessResponse> {
	const status = getVoiceBuilderStatus(config, secrets);
	if (!status.enabled) throw new Error(status.errors[0] ?? 'Voice Builder is not configured');

	const transcript = await transcribeVoiceRecording(request, secrets, fetchImpl);
	const edit = await generateVoiceProjectEdit({ transcript, currentProject: request.currentProject, services: request.services }, config, secrets, fetchImpl);
	return { transcript, ...edit };
}
