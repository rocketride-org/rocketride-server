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
// PIPELINE SAVE VALIDATION — the validate every save of a .pipe file runs
// =============================================================================

/**
 * Saving a `.pipe` file returns what validate says, so the model fixes its own edit at once. A validate that
 * cannot run says why and never fails the save. Every save validates through `validatePipeline`.
 */

import type { RocketRideClient } from 'rocketride';

import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import { clip, isJsonObject, messageOf, pipelineArg, requireClient, type ClientGetter, type JsonObject } from './common';

// =============================================================================
// VALIDATE
// =============================================================================

/**
 * Names the components whose provider the engine has no service for. The engine never looks a provider up,
 * so a misspelt one validates clean and fails at run time. The names come from the engine's own catalog.
 */
async function unknownProviders(client: RocketRideClient, pipeline: JsonObject): Promise<string[]> {
	const components = Array.isArray(pipeline.components) ? pipeline.components.filter(isJsonObject) : [];
	if (components.length === 0) return [];

	const { services } = await client.getServices();
	const known = new Set(Object.keys(services ?? {}));
	if (known.size === 0) return [];

	return components.filter((c) => typeof c.provider === 'string' && c.provider !== '' && !known.has(c.provider)).map((c) => `${typeof c.id === 'string' ? `${c.id}: ` : ''}unknown provider '${String(c.provider)}' — rocketride_client getServices lists the valid names`);
}

/** One engine error or warning as a line, led by the component id when the engine gave one. */
function entryText(entry: { message: string; id?: string }): string {
	return entry.id ? `${entry.id}: ${entry.message}` : entry.message;
}

/**
 * Validates a pipeline against the engine's own rules. Unknown providers are reported first, without calling
 * the engine, because the engine would pass them. No errors means the pipeline is valid.
 */
async function validatePipeline(client: RocketRideClient, pipeline: JsonObject): Promise<{ errors: string[]; warnings: string[] }> {
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

const SAVE_CLIP_HINT = 'fix the first errors and save again to see the rest';

/** What the validate a save ran found: the errors (none means valid), or why it could not run. */
export type SaveValidation = { errors: string[] } | { failed: string };

/**
 * Validates a saved pipeline file against the engine's own rules. Never throws.
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
 * @param hide - Hides the values the run's file tools hid, before the cut.
 * @returns The text to append: `validate: OK`, the errors as lines, or why validate could not run.
 */
export function validateNote(validation: SaveValidation, hide: (text: string) => string): string {
	if ('failed' in validation) return `\n\nvalidate: could not run (${validation.failed})`;
	const { errors } = validation;
	if (errors.length === 0) return '\n\nvalidate: OK';
	const lines = errors.map((e) => `- ${e}`).join('\n');
	return `\n\nvalidate: ${errors.length} ${errors.length === 1 ? 'error' : 'errors'}:\n${clip(hide(lines), SAVE_CLIP_HINT)}`;
}
