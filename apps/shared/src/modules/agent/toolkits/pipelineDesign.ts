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
// PIPELINE DESIGN TOOLS — list_components, describe_component, validate_pipeline
// =============================================================================

/**
 * The tools the model designs a pipeline with. They take the MCP names and
 * argument names (`packages/ai/src/ai/modules/mcp/tools/introspection.py`) so the
 * pipeline skills, which name those tools throughout, read correctly. Results are
 * text and cut when long. The catalog and component schemas are static node
 * metadata, so they are shown as is; validate results go through the secret
 * stripper. `validate_pipeline` also takes `path`, so the model checks a `.pipe`
 * file it saved without pasting it back.
 *
 * `validatePipeline` is shared: running a pipeline and the validate that every
 * save of a `.pipe` file runs (`validateSaved`, `validateNote`) validate the
 * same way.
 */

import type { RocketRideClient } from 'rocketride';

import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import { AgentTool, AgentToolkit } from '../tools';
import { clip, isJsonObject, messageOf, pipelineArg, requireClient, toolText, type ClientGetter, type JsonObject } from './common';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The longest a component's summary runs in the list, in characters. */
const SUMMARY_MAX_CHARS = 100;

/** The message when a describe call has no name. */
const NEED_NAME = 'Pass name: a component name from list_components.';

// =============================================================================
// LIST
// =============================================================================

/**
 * A component's category tags as text.
 *
 * @param classType - The service's `classType`.
 * @returns For example `[source, agent]`; empty when there are no tags.
 */
function categoryOf(classType: unknown): string {
	const tags = Array.isArray(classType) ? classType.filter((tag): tag is string => typeof tag === 'string') : [];
	return tags.length > 0 ? ` [${tags.join(', ')}]` : '';
}

/**
 * The first sentence of a component's description, on one line and cut short.
 * The full text stays out of the list: 200 of them would fill the result.
 *
 * @param description - The service's `description`, text or lines of text.
 * @returns The summary; empty when there is no description.
 */
function summaryOf(description: unknown): string {
	const joined = Array.isArray(description) ? description.join(' ') : description;
	const text = typeof joined === 'string' ? joined.replace(/\s+/g, ' ').trim() : '';
	const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
	return sentence.length > SUMMARY_MAX_CHARS ? `${sentence.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…` : sentence;
}

/**
 * Turns the engine's catalog into one line per component. The icon table and
 * every config detail stay out; `describe_component` has those.
 *
 * @param services - The `services` map from `getServices()`.
 * @returns The list text.
 */
function listText(services: unknown): string {
	const entries = Object.entries(isJsonObject(services) ? services : {})
		.filter((entry): entry is [string, JsonObject] => isJsonObject(entry[1]))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	if (entries.length === 0) return 'The engine lists no components.';

	const lines = entries.map(([name, service]) => {
		const summary = summaryOf(service.description);
		return `- ${name}${categoryOf(service.classType)}${summary ? `: ${summary}` : ''}`;
	});
	const count = `${entries.length} component${entries.length === 1 ? '' : 's'}`;
	return `${count} (describe_component gives one component's lanes and config):\n${lines.join('\n')}`;
}

// =============================================================================
// VALIDATE
// =============================================================================

/**
 * Names the components whose provider the engine has no service for. The engine
 * checks a whole pipeline's structure but never looks a provider up, so a
 * misspelt one validates clean and fails at run time. The names come from the
 * engine's own catalog, so this adds no rule of ours.
 *
 * @param client - The connected client.
 * @param pipeline - The flat pipeline config.
 * @returns One error per unknown provider; empty when all are known, there is nothing to check, or the catalog is empty.
 */
async function unknownProviders(client: RocketRideClient, pipeline: JsonObject): Promise<string[]> {
	const components = Array.isArray(pipeline.components) ? pipeline.components.filter(isJsonObject) : [];
	if (components.length === 0) return [];

	const { services } = await client.getServices();
	const known = new Set(Object.keys(services ?? {}));
	if (known.size === 0) return [];

	return components.filter((c) => typeof c.provider === 'string' && c.provider !== '' && !known.has(c.provider)).map((c) => `${typeof c.id === 'string' ? `${c.id}: ` : ''}unknown provider '${String(c.provider)}' — pick a name from list_components`);
}

/**
 * One engine error or warning as a line.
 *
 * @param entry - The engine's entry.
 * @returns The message, led by the component id when the engine gave one.
 */
function entryText(entry: { message: string; id?: string }): string {
	return entry.id ? `${entry.id}: ${entry.message}` : entry.message;
}

/**
 * Validates a pipeline against the engine's own rules. Providers the engine
 * does not know are reported first, without calling the engine, because the
 * engine would pass them; fix the names, then validate again for the rest.
 *
 * @param client - The connected client.
 * @param pipeline - The flat pipeline config (see `pipelineArg`).
 * @returns The errors and warnings as lines; no errors means the pipeline is valid.
 */
export async function validatePipeline(client: RocketRideClient, pipeline: JsonObject): Promise<{ errors: string[]; warnings: string[] }> {
	const unknown = await unknownProviders(client, pipeline);
	if (unknown.length > 0) return { errors: unknown, warnings: [] };

	// The engine's reply also echoes the pipeline with its secure values
	// encrypted. That echo is the model's own input, so it is not passed on.
	const result = await client.validate({ pipeline });
	return { errors: result.errors.map(entryText), warnings: result.warnings.map(entryText) };
}

// =============================================================================
// VALIDATE ON SAVE — the note a save of a `.pipe` file appends
// =============================================================================

/**
 * Saving a `.pipe` file returns what validate says, so the model sees the
 * result of its own edit at once and fixes it without asking. The host's
 * after-save hook runs `validateSaved`, keeps the result for its finish rule,
 * and appends `validateNote` (see run.ts). A validate that cannot run says why
 * and never fails the save.
 */

/** What a cut error list in a save's note tells the model to do. */
const SAVE_CLIP_HINT = 'fix the first errors and save again to see the rest';

/** What the validate a save ran found: the errors (none means valid), or why it could not run. */
export type SaveValidation = { errors: string[] } | { failed: string };

/**
 * Validates a saved pipeline file the way `validate_pipeline` does. Never throws.
 *
 * @param client - The host's client getter.
 * @param vfs - The workspace view the file was saved to.
 * @param path - The pipeline file's workspace path.
 * @returns The errors, or why validate could not run.
 */
export async function validateSaved(client: ClientGetter, vfs: IWorkspaceFileSystem, path: string): Promise<SaveValidation> {
	try {
		const { pipeline } = await pipelineArg({ path }, vfs);
		const { errors } = await validatePipeline(requireClient(client), pipeline);
		return { errors };
	} catch (err) {
		return { failed: messageOf(err) };
	}
}

/**
 * The validate note for a saved pipeline file.
 *
 * @param validation - What the validate on save found.
 * @returns The text to append: `validate_pipeline: OK`, the errors as lines, or why validate could not run.
 */
export function validateNote(validation: SaveValidation): string {
	if ('failed' in validation) return `\n\nvalidate_pipeline: could not run (${validation.failed})`;
	const { errors } = validation;
	if (errors.length === 0) return '\n\nvalidate_pipeline: OK';
	const lines = errors.map((e) => `- ${e}`).join('\n');
	return `\n\nvalidate_pipeline: ${errors.length} ${errors.length === 1 ? 'error' : 'errors'}:\n${clip(lines, SAVE_CLIP_HINT)}`;
}

// =============================================================================
// TOOLKIT
// =============================================================================

/** The pipeline design toolkit: `list_components`, `describe_component` and `validate_pipeline`. */
export class PipelineDesignToolkit extends AgentToolkit {
	readonly name = 'pipeline-design';
	readonly instructions = "Use list_components to find what exists, describe_component for one component's lanes and config, and validate_pipeline to check a pipeline, because only the engine knows its rules.";

	/** Returns the connected client, or null. */
	private readonly client: ClientGetter;
	/** The workspace view a `path` is read from. */
	private readonly vfs: IWorkspaceFileSystem;

	/**
	 * Builds the toolkit.
	 *
	 * @param client - The host's client getter.
	 * @param vfs - The workspace view.
	 */
	constructor(client: ClientGetter, vfs: IWorkspaceFileSystem) {
		super();
		this.client = client;
		this.vfs = vfs;
	}

	/**
	 * The three design tools.
	 *
	 * @returns The group's tools.
	 */
	tools(): AgentTool[] {
		return [
			new AgentTool({
				name: 'list_components',
				description: ['List the components on this engine: name, category and a one-line summary.', '- Needs a connected RocketRide engine.', '- Gives no lanes or config; call describe_component for those.', '- A long list is cut, and the notice says so.'].join('\n'),
				parameters: { type: 'object', properties: {}, additionalProperties: false },
				execute: async () => {
					const { services } = await requireClient(this.client).getServices();
					return clip(listText(services), 'describe_component takes any component name, listed or not');
				},
			}),
			new AgentTool({
				name: 'describe_component',
				description: ['Describe one component: metadata, lanes and config schema.', '- Pass a name from list_components; an unknown name fails.', '- A long definition is cut, and the notice says so.'].join('\n'),
				parameters: {
					type: 'object',
					properties: { name: { type: 'string', description: 'Component name from list_components' } },
					required: ['name'],
					additionalProperties: false,
				},
				execute: async (args) => {
					const name = typeof args.name === 'string' ? args.name.trim() : '';
					if (!name) throw new Error(NEED_NAME);

					const client = requireClient(this.client);
					let service: unknown;
					try {
						service = await client.getService(name);
					} catch (err) {
						throw new Error(`Cannot describe '${name}': ${messageOf(err)}. Call list_components for valid names.`);
					}
					// Static node metadata with no user data in it, so it is not redacted: redaction
					// would also hide the type and title of every field whose name looks secret.
					const definition = JSON.stringify({ ...(isJsonObject(service) ? service : {}), ok: true }, null, 1);
					return clip(definition, 'the rest of this definition is not available; validate_pipeline reports what a config is missing');
				},
			}),
			new AgentTool({
				name: 'validate_pipeline',
				description: ["Validate a pipeline against the engine's own rules, and check every component exists. Does not run it.", '- Pass exactly one of path (a .pipe file in the workspace) or pipeline (the pipeline object).', '- Needs a connected RocketRide engine.', '- Returns ok, errors and warnings; unknown components are reported first, then validate again for the rest.', '- A pipeline is ready to run when errors is empty.'].join('\n'),
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace path of a .pipe file, for example pipelines/chat.pipe' },
						pipeline: { type: 'object', description: 'The pipeline object, flat or wrapped as in a .pipe file' },
					},
					additionalProperties: false,
				},
				execute: async (args) => {
					const { pipeline } = await pipelineArg(args, this.vfs);
					const { errors, warnings } = await validatePipeline(requireClient(this.client), pipeline);
					return toolText({ ok: errors.length === 0, errors, warnings }, 'fix the first errors and validate again to see the rest');
				},
			}),
		];
	}
}
