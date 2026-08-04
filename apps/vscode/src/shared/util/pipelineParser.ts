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

/**
 * Pipeline File Parser - Parses .pipeline files and extracts pipeline definitions
 */

import * as fs from 'fs';

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

export interface ParsedSourceComponent {
	id: string;
	provider?: string;
	name?: string;
	description?: string;
	warnings: string[];
	icon: string;
}

export interface ParsedPipelineFile {
	filePath: string;
	isValid: boolean;
	pipeline?: Pipeline;
	sourceComponents: ParsedSourceComponent[];
	projectId?: string;
	errors: string[];
}

/**
 * Lightweight service definition used only for source-component detection.
 * Mirrors the `classType` array from the full service catalog without
 * pulling in UI-specific types.
 */
export interface ServiceClassInfo {
	classType?: string[];
}

export class PipelineFileParser {
	/**
	 * Parse a pipeline file from file system
	 *
	 * @param filePath  Absolute path to the .pipe / .pipe.json file
	 * @param services  Optional service catalog for classType-based source detection
	 */
	static async parseFile(filePath: string, services?: Record<string, ServiceClassInfo>): Promise<ParsedPipelineFile> {
		try {
			const content = await fs.promises.readFile(filePath, 'utf8');
			return this.parseContent(content, filePath, services);
		} catch (error) {
			return {
				filePath,
				isValid: false,
				sourceComponents: [],
				errors: [`Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`],
			};
		}
	}

	/**
	 * Parse pipeline content from string
	 *
	 * @param content   Raw JSON text of the pipeline file
	 * @param filePath  File path (used for diagnostics / map key)
	 * @param services  Optional service catalog for classType-based source detection
	 */
	static parseContent(content: string, filePath: string, services?: Record<string, ServiceClassInfo>): ParsedPipelineFile {
		const result: ParsedPipelineFile = {
			filePath,
			isValid: false,
			sourceComponents: [],
			errors: [],
		};

		try {
			// Try to parse as JSON
			const parsed = JSON.parse(content);

			// Handle the nested pipeline structure from your examples
			const pipelineData = parsed.pipeline || parsed;

			// Validate structure
			const validation = this.validatePipelineStructure(pipelineData);
			result.errors = validation.errors;
			result.isValid = validation.isValid;
			result.projectId = pipelineData.project_id;

			if (result.isValid) {
				result.pipeline = pipelineData;

				// Extract source components using both config.mode and service classType
				const sourceComponents = this.getSourceComponents(pipelineData, services);
				result.sourceComponents = sourceComponents.map((component) => this.parseSourceComponent(component));
			}
		} catch (jsonError) {
			result.errors.push(`Invalid JSON: ${jsonError instanceof Error ? jsonError.message : 'Unknown JSON error'}`);
		}

		return result;
	}

	/**
	 * Parse a source component and return structured data
	 */
	private static parseSourceComponent(component: PipelineComponent): ParsedSourceComponent {
		const warnings: string[] = [];

		// Name and description are optional; UI defaults to provider title/description

		return {
			id: component.id,
			provider: component.provider,
			name: component.name,
			description: component.description,
			warnings,
			icon: 'default', // Default icon, you'll replace this with SVG logic
		};
	}

	/**
	 * Validate pipeline structure
	 */
	private static validatePipelineStructure(data: unknown): { isValid: boolean; errors: string[] } {
		const errors: string[] = [];

		// Check if data is an object
		if (!data || typeof data !== 'object') {
			errors.push('Pipeline file must contain a valid object');
			return { isValid: false, errors };
		}

		const record = data as Record<string, unknown>;

		// Components are required
		if (!record.components || !Array.isArray(record.components)) {
			errors.push('Pipeline must have a "components" array');
		} else {
			// Validate components
			record.components.forEach((component: unknown, index: number) => {
				const comp = component as Record<string, unknown>;
				if (!comp.id || typeof comp.id !== 'string') {
					errors.push(`Component at index ${index} must have an "id" field`);
				}
				if (!comp.provider || typeof comp.provider !== 'string') {
					errors.push(`Component at index ${index} must have a "provider" field`);
				}
			});

			// Check for duplicate component IDs
			const componentIds = record.components.map((c: unknown) => (c as Record<string, unknown>).id).filter(Boolean);
			const duplicates = componentIds.filter((id: unknown, index: number) => componentIds.indexOf(id) !== index);
			if (duplicates.length > 0) {
				errors.push(`Duplicate component IDs found: ${(duplicates as string[]).join(', ')}`);
			}
		}

		return {
			isValid: errors.length === 0,
			errors,
		};
	}

	/**
	 * Get source components.
	 *
	 * A component is considered a source when:
	 *   1. Its config explicitly contains `mode: "Source"` (set by the engine
	 *      during execution or in manually authored pipeline files), OR
	 *   2. Its provider's service definition has `classType` containing
	 *      `"source"` (the runtime catalog provided by the engine).
	 *
	 * The second check is essential because the canvas editor does not write
	 * `config.mode` — only the engine adds it at execution time, so freshly
	 * saved .pipe files from the canvas lack the flag.
	 */
	private static getSourceComponents(pipeline: Pipeline, services?: Record<string, ServiceClassInfo>): PipelineComponent[] {
		return pipeline.components.filter((c) => {
			// Check 1: explicit config.mode === 'Source'
			if (c.config && typeof c.config === 'object' && 'mode' in c.config && c.config.mode === 'Source') {
				return true;
			}
			// Check 2: service catalog classType includes 'source'
			if (services && c.provider) {
				const svc = services[c.provider] as ServiceClassInfo | undefined;
				if (svc?.classType?.includes('source')) {
					return true;
				}
			}
			return false;
		});
	}

	/**
	 * Find component by ID
	 */
	static findComponent(pipeline: Pipeline, componentId: string): PipelineComponent | undefined {
		return pipeline.components.find((c) => c.id === componentId);
	}
}
