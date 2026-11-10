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
// RUN OUTPUT: the runner runs the saved pipeline, not the agent
// =============================================================================

/**
 * run_output (L3 only) starts the pipeline the agent saved, sends the input
 * the scenario names, and checks what comes back. It never trusts the
 * agent's own test run. A check is pending, never passed, when the pipeline
 * uses a Variable the engine does not have.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { RocketRideClient } from 'rocketride';

import { expectationFailures, type PipelineOutput } from './expect';
import type { RunOutputResult, ScenarioCheck } from './types';

const load = createRequire(__filename);

/** The longest one send may take. */
const SEND_LIMIT_MS = 180_000;

/** A file's mimetype by its extension. */
const MIMETYPES: Record<string, string> = { '.txt': 'text/plain', '.wav': 'audio/wav', '.png': 'image/png', '.pdf': 'application/pdf' };

/** The sources a `send` keyed `upload` may use, in this order: a prompt that only says "upload" fits either. */
const UPLOAD_SOURCES = ['dropper', 'webhook'];

interface Send {
	file?: string;
	text?: string;
	mimetype?: string;
}

/** Every string in a value. */
function texts(v: unknown): string[] {
	if (typeof v === 'string') return [v];
	if (Array.isArray(v)) return v.flatMap(texts);
	if (v && typeof v === 'object') return Object.values(v).flatMap(texts);
	return [];
}

/** A result's answers and text, by the lane types it declares. */
function outputs(result: Record<string, unknown> | undefined): PipelineOutput {
	const out = { answers: [] as string[], text: [] as string[] };
	if (!result) return out;
	const types = (result.result_types ?? {}) as Record<string, string>;
	for (const [field, type] of Object.entries(types)) {
		if (type === 'answers') out.answers.push(...(Array.isArray(result[field]) ? (result[field] as unknown[]).map((a) => (typeof a === 'string' ? a : JSON.stringify(a))) : texts(result[field])));
		else if (type === 'text') out.text.push(...texts(result[field]));
	}
	if (!out.answers.length && Array.isArray(result.answers)) out.answers.push(...(result.answers as unknown[]).map((a) => (typeof a === 'string' ? a : JSON.stringify(a))));
	if (!out.text.length && result.text !== undefined) out.text.push(...texts(result.text));
	return out;
}

/** A run this trial started: `use` said it was not reused, and its start time tells it from a later run on the same token. */
export interface OwnedRun {
	token: string;
	startTime: number;
}

/**
 * Ends the trial's own runs, each only while a fresh status read shows it is
 * still the run the trial started.
 *
 * @param client - The connected client.
 * @param owned - The runs the trial started.
 * @param only - Which of them to end, by the status read; all when unset.
 */
export async function endOwnedRuns(client: RocketRideClient, owned: OwnedRun[], only?: (status: { project_id?: string; source?: string }) => boolean): Promise<void> {
	for (const run of owned) {
		try {
			const status = await client.getTaskStatus(run.token);
			if (Number(status.startTime) === run.startTime && (!only || only(status))) await client.terminate(run.token);
		} catch {
			// it ended already
		}
	}
}

function withLimit<T>(work: Promise<T>, what: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what} took longer than ${SEND_LIMIT_MS / 1000} s`)), SEND_LIMIT_MS);
		work.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(err: unknown) => {
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		);
	});
}

/**
 * Runs one run_output check.
 *
 * @param client - The connected client.
 * @param ck - The check.
 * @param tasksDir - The task set folder, which a `send` file is relative to.
 * @param finalFiles - The workspace after the run.
 * @param engineVariables - The Variable names the engine has.
 * @param owned - The runs the trial started. One of this pipeline and source is ended first, since the engine refuses a second start.
 * @returns The result.
 */
export async function runOutputCheck(client: RocketRideClient, ck: ScenarioCheck, tasksDir: string, finalFiles: Record<string, string>, engineVariables: string[], owned: OwnedRun[]): Promise<RunOutputResult> {
	const file = finalFiles[String(ck.path)];
	if (file === undefined) return { status: 'fail', detail: `${ck.path} was not saved` };
	let pipeline: Record<string, unknown>;
	try {
		pipeline = JSON.parse(file) as Record<string, unknown>;
	} catch {
		return { status: 'fail', detail: `${ck.path} is not JSON` };
	}
	const needed = [...new Set([...file.matchAll(/\$\{(ROCKETRIDE_[A-Z0-9_]+)\}/g)].map((m) => m[1]))].filter((v) => !engineVariables.includes(v));
	if (needed.length) return { status: 'pending', detail: `the engine has no ${needed.join(', ')}` };

	const comps = (pipeline.components ?? []) as Array<{ id: string; provider: string }>;
	const sourceOf = (provider: string) => comps.find((c) => c.provider === provider)?.id;
	const send = (ck.send ?? {}) as Record<string, Send | string>;
	let inputChars = 0;
	const out: PipelineOutput = { answers: [], text: [] };
	try {
		for (const [key, what] of Object.entries(send)) {
			const providers = key === 'chat' || key === 'then_chat' ? ['chat'] : key === 'upload' ? UPLOAD_SOURCES : [key];
			const source = providers.map(sourceOf).find(Boolean);
			if (!source) return { status: 'fail', detail: `the pipeline has no ${providers.join(' or ')} source` };
			const isChat = providers[0] === 'chat';
			await endOwnedRuns(client, owned, (s) => s.project_id === String(pipeline.project_id ?? '') && s.source === source);
			const started = await client.use({ pipeline: pipeline as never, source, useExisting: false });
			// step: every run started here is ended here, whatever the send does
			try {
				let result: Record<string, unknown> | undefined;
				if (isChat) {
					// loaded here so a webhook or dropper send needs no built client
					const { Question } = load('rocketride') as { Question: new () => { addQuestion: (q: string) => void } };
					const q = new Question();
					q.addQuestion(String(what));
					inputChars += String(what).length;
					result = (await withLimit(client.chat({ token: started.token, question: q as never }), 'chat')) as unknown as Record<string, unknown>;
				} else {
					const s = what as Send;
					const data = s.file ? fs.readFileSync(path.join(tasksDir, s.file)) : Buffer.from(String(s.text ?? ''), 'utf8');
					inputChars += data.length;
					const mimetype = s.mimetype ?? MIMETYPES[path.extname(s.file ?? '.txt')] ?? 'application/octet-stream';
					result = (await withLimit(client.send(started.token, new Uint8Array(data), { name: s.file ? path.basename(s.file) : 'input.txt' }, mimetype), 'send')) as unknown as Record<string, unknown>;
				}
				// step: a run that failed inside the engine says so in its result; report that, not an empty output
				const runError = result?.error;
				if (runError !== undefined && runError !== null && runError !== '') {
					let message = typeof runError === 'string' ? runError : JSON.stringify(runError);
					try {
						message = String((JSON.parse(message) as { message?: unknown }).message ?? message);
					} catch {
						// not JSON: the text is the message
					}
					return { status: 'fail', detail: `the run reported an error: ${message.slice(0, 300)}` };
				}
				const got = outputs(result);
				out.answers.push(...got.answers);
				out.text.push(...got.text);
			} finally {
				try {
					await client.terminate(started.token);
				} catch {
					// ended on its own
				}
			}
		}
	} catch (err) {
		return { status: 'fail', detail: `the run failed: ${String(err instanceof Error ? err.message : err).slice(0, 300)}` };
	}
	const fails = expectationFailures((ck.expect ?? {}) as Record<string, unknown>, out, inputChars);
	const excerpt = [...out.answers.map((a, i) => `answer ${i + 1}: ${a.slice(0, 100)}`), ...out.text.map((x, i) => `text ${i + 1}: ${x.slice(0, 100)}`)].join(' | ').slice(0, 600);
	return { status: fails.length ? 'fail' : 'pass', detail: fails.length ? fails.join('; ') : `${out.answers.length} answers, ${out.text.length} text items`, excerpt, output: out };
}
