import type { RocketRideClient } from 'rocketride';
import type { Capabilities, Evaluation, EvaluationSpec, Revision, Run } from './types';

export class EvaluationApiError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly code?: string
	) {
		super(message);
		this.name = 'EvaluationApiError';
	}
}

export function evaluationBaseUrl(uri: string): string {
	if (!uri) throw new Error('Connect to a RocketRide server to use evaluations.');
	const url = new URL(uri);
	if (url.protocol === 'ws:') url.protocol = 'http:';
	if (url.protocol === 'wss:') url.protocol = 'https:';
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Evaluations require an HTTP or WebSocket server connection.');
	if (url.protocol === 'http:' && !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(url.hostname)) throw new Error('Remote evaluations require HTTPS. Plain HTTP is supported only for loopback development.');
	return `${url.origin}/evals/v1`;
}

/** Retrying a denied or missing resource cannot restore permission or existence. */
export function retryablePollError(error: unknown): boolean {
	return !(error instanceof EvaluationApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429);
}

/** Reads the current credential for each request; credentials never enter exported artifacts. */
export class EvaluationApi {
	constructor(private readonly client: Pick<RocketRideClient, 'getConnectionInfo' | 'getApiKey'>) {}
	async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		const response = await this.response(path, body, signal);
		try {
			return (await response.json()) as T;
		} catch {
			throw new EvaluationApiError('The server did not return evaluation JSON. Check that the managed evaluation API is enabled on this connection.', response.status);
		}
	}
	private async response(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
		const base = evaluationBaseUrl(this.client.getConnectionInfo().uri);
		const key = this.client.getApiKey();
		if (!key) throw new Error('Connect with a RocketRide credential to use evaluations.');
		const response = await fetch(`${base}${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: { Authorization: `Bearer ${key}`, Accept: 'application/json, application/xml, text/xml', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal,
			cache: 'no-store',
			redirect: 'error',
		});
		if (!response.ok) {
			const payload = await response.json().catch(() => null);
			const message = typeof payload?.error?.message === 'string' ? payload.error.message : `Evaluation request failed (${response.status}).`;
			throw new EvaluationApiError(message, response.status, typeof payload?.error?.code === 'string' ? payload.error.code : undefined);
		}
		return response;
	}
	async capabilities(signal?: AbortSignal): Promise<Capabilities> {
		const value = await this.request<Capabilities>('/capabilities', undefined, signal);
		if (!value || !Array.isArray(value.environments) || value.environments.some((item) => !item || typeof item.id !== 'string' || typeof item.label !== 'string' || typeof item.available !== 'boolean') || !Array.isArray(value.scorerKinds) || value.scorerKinds.some((item) => typeof item !== 'string') || typeof value.assistantAvailable !== 'boolean') throw new Error('The server returned an invalid evaluation capability response.');
		return value;
	}
	list(projectId: string, signal?: AbortSignal): Promise<{ evaluations: Evaluation[] }> {
		return this.request(`/evaluations?projectId=${encodeURIComponent(projectId)}`, undefined, signal);
	}
	detail(id: string, signal?: AbortSignal): Promise<{ evaluation: Evaluation; revisions: Revision[] }> {
		return this.request(`/evaluations/${encodeURIComponent(id)}`, undefined, signal);
	}
	runs(id: string, signal?: AbortSignal): Promise<{ runs: Run[] }> {
		return this.request(`/runs?evaluationId=${encodeURIComponent(id)}`, undefined, signal);
	}
	run(id: string, signal?: AbortSignal): Promise<{ run: Run }> {
		return this.request(`/runs/${encodeURIComponent(id)}`, undefined, signal);
	}
	save(spec: EvaluationSpec, current: Evaluation | null, signal?: AbortSignal): Promise<{ evaluation: Evaluation }> {
		return current ? this.request(`/evaluations/${encodeURIComponent(current.id)}/revisions`, { spec, expectedRevision: current.revision }, signal) : this.request('/evaluations', spec, signal);
	}
	async report(id: string, format: 'json' | 'junit', signal?: AbortSignal): Promise<Blob> {
		return (await this.response(`/runs/${encodeURIComponent(id)}/report?format=${format}`, undefined, signal)).blob();
	}
}

export function downloadArtifact(filename: string, content: Blob | string, type = 'application/json'): void {
	const url = URL.createObjectURL(typeof content === 'string' ? new Blob([content], { type }) : content);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
