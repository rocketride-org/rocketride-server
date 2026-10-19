// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// TOOLS/PIPELINES — .pipe parsing (pure; the ONE parser for every surface)
// =============================================================================
//
// Moved from the VS Code extension (shared/util/pipelineParser.ts) per the
// sidebar-as-controller architecture: what a `.pipe` file IS belongs to the
// pipelines tool, not to a host. Pure string-in/result-out — callers read
// the file through whatever access they have (workspace-FS capability in a
// controller, vscode.workspace in the canvas editor's host flows).
// =============================================================================

/** One component of a pipeline definition. */
export interface PipelineComponent {
	id: string;
	type?: string;
	name?: string;
	description?: string;
	provider?: string;
	config?: Record<string, unknown>;
	inputs?: string[];
	outputs?: string[];
}

/** A parsed pipeline definition (the `.pipe` JSON body). */
export interface Pipeline {
	name?: string;
	description?: string;
	version?: string;
	components: PipelineComponent[];
	connections?: Array<{
		from: string;
		to: string;
		fromPort?: string;
		toPort?: string;
	}>;
	source?: string;
	project_id?: string;
}

/** One source component, parsed for the sidebar/run surfaces. */
export interface ParsedSourceComponent {
	id: string;
	provider?: string;
	name?: string;
	description?: string;
	warnings: string[];
	icon: string;
}

/** The parse result for one `.pipe` / `.pipe.json` file. */
export interface ParsedPipelineFile {
	filePath: string;
	isValid: boolean;
	pipeline?: Pipeline;
	sourceComponents: ParsedSourceComponent[];
	projectId?: string;
	errors: string[];
}

/**
 * Lightweight service definition used for source-component detection and
 * display titles. Mirrors the service catalog's `classType`/`title` without
 * pulling in UI-specific types.
 */
export interface ServiceClassInfo {
	classType?: string[];
	title?: string;
}

/**
 * Parses pipeline content.
 *
 * @param content - Raw JSON text of the pipeline file.
 * @param filePath - File path (diagnostics / map key).
 * @param services - Optional service catalog for classType source detection.
 * @returns The parse result (never throws).
 */
export function parsePipelineContent(content: string, filePath: string, services?: Record<string, ServiceClassInfo>): ParsedPipelineFile {
	const result: ParsedPipelineFile = {
		filePath,
		isValid: false,
		sourceComponents: [],
		errors: [],
	};

	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		// Handle the nested { pipeline: {...} } wrapper shape.
		const pipelineData = (parsed.pipeline && typeof parsed.pipeline === 'object' && !Array.isArray(parsed.pipeline) ? parsed.pipeline : parsed) as unknown;

		const validation = validatePipelineStructure(pipelineData);
		result.errors = validation.errors;
		result.isValid = validation.isValid;
		result.projectId = (pipelineData as Pipeline).project_id;

		if (result.isValid) {
			result.pipeline = pipelineData as Pipeline;
			result.sourceComponents = getSourceComponents(result.pipeline, services).map(parseSourceComponent);
		}
	} catch (jsonError) {
		result.errors.push(`Invalid JSON: ${jsonError instanceof Error ? jsonError.message : 'Unknown JSON error'}`);
	}

	return result;
}

/** Parses one source component into the structured row shape. */
function parseSourceComponent(component: PipelineComponent): ParsedSourceComponent {
	// Name and description are optional; UIs default to provider title.
	return {
		id: component.id,
		...(component.provider !== undefined ? { provider: component.provider } : {}),
		...(component.name !== undefined ? { name: component.name } : {}),
		...(component.description !== undefined ? { description: component.description } : {}),
		warnings: [],
		icon: 'default',
	};
}

/** Validates the pipeline structure (components array, ids, providers). */
function validatePipelineStructure(data: unknown): { isValid: boolean; errors: string[] } {
	const errors: string[] = [];

	if (!data || typeof data !== 'object') {
		errors.push('Pipeline file must contain a valid object');
		return { isValid: false, errors };
	}

	const record = data as Record<string, unknown>;
	if (!record.components || !Array.isArray(record.components)) {
		errors.push('Pipeline must have a "components" array');
	} else {
		record.components.forEach((component: unknown, index: number) => {
			const comp = component as Record<string, unknown>;
			if (!comp.id || typeof comp.id !== 'string') {
				errors.push(`Component at index ${index} must have an "id" field`);
			}
			if (!comp.provider || typeof comp.provider !== 'string') {
				errors.push(`Component at index ${index} must have a "provider" field`);
			}
		});

		const componentIds = record.components.map((c: unknown) => (c as Record<string, unknown>).id).filter(Boolean);
		const duplicates = componentIds.filter((id: unknown, index: number) => componentIds.indexOf(id) !== index);
		if (duplicates.length > 0) {
			errors.push(`Duplicate component IDs found: ${(duplicates as string[]).join(', ')}`);
		}
	}

	return { isValid: errors.length === 0, errors };
}

/**
 * Source components of a pipeline. A component is a source when its config
 * carries `mode: "Source"` (written by the engine at execution time), OR
 * its provider's catalog entry has `classType` containing 'source' — the
 * second check matters because canvas-saved files lack the mode flag.
 *
 * @param pipeline - The parsed pipeline.
 * @param services - Optional service catalog.
 * @returns The source components.
 */
export function getSourceComponents(pipeline: Pipeline, services?: Record<string, ServiceClassInfo>): PipelineComponent[] {
	return pipeline.components.filter((c) => {
		if (c.config && typeof c.config === 'object' && 'mode' in c.config && c.config.mode === 'Source') return true;
		if (services && c.provider && services[c.provider]?.classType?.includes('source')) return true;
		return false;
	});
}

/**
 * Finds a component by id.
 *
 * @param pipeline - The parsed pipeline.
 * @param componentId - The component id.
 * @returns The component, or undefined.
 */
export function findComponent(pipeline: Pipeline, componentId: string): PipelineComponent | undefined {
	return pipeline.components.find((c) => c.id === componentId);
}
