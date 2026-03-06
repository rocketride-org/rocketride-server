/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Offline pipeline validation for CLI and CI.
 * Validates structure, source, component ids, and input references without a server.
 */

export interface ValidatePipelineResult {
	valid: boolean;
	errors: string[];
	/** Normalized pipeline (components + source) for display or server validation */
	normalized?: { components: unknown[]; source: string };
}

interface PipelineInputConnection {
	lane?: unknown;
	from?: unknown;
}

interface RawComponent {
	id?: unknown;
	provider?: unknown;
	config?: unknown;
	input?: unknown;
}

/**
 * Normalize .pipe / pipeline JSON into a single shape: { components, source }.
 * Supports: { pipeline: { source, components } } or { source?, components } (e.g. .pipe from UI).
 */
function normalizePipeline(root: Record<string, unknown>): { components: RawComponent[]; source: string | undefined } {
	const pipeline = (root.pipeline as Record<string, unknown>) || root;
	const components = Array.isArray(pipeline.components) ? (pipeline.components as RawComponent[]) : [];
	let source = typeof pipeline.source === 'string' ? pipeline.source : undefined;

	if (!source && components.length > 0) {
		const withSourceMode = components.find(
			(c) =>
				c.config &&
				typeof c.config === 'object' &&
				'mode' in (c.config as Record<string, unknown>) &&
				(c.config as Record<string, unknown>).mode === 'Source'
		);
		if (withSourceMode && typeof withSourceMode.id === 'string') {
			source = withSourceMode.id;
		}
	}

	return { components, source };
}

/**
 * Validate a pipeline configuration offline (no server).
 * Rules aligned with engine PipelineConfig: source, components, ids, input refs.
 */
export function validatePipeline(raw: Record<string, unknown>): ValidatePipelineResult {
	const errors: string[] = [];
	const { components, source } = normalizePipeline(raw);

	// --- Root / pipeline shape ---
	if (!Array.isArray(components)) {
		errors.push("'components' must be an array");
		return { valid: false, errors };
	}

	if (components.length === 0) {
		errors.push("'components' must contain at least one component");
		return { valid: false, errors };
	}

	const allIds = new Set<string>();
	const idList: string[] = [];
	for (const c of components) {
		const id = (c as RawComponent).id;
		if (typeof id === 'string' && id.trim() !== '') {
			allIds.add(id);
			idList.push(id);
		}
	}
	const duplicateIds = idList.filter((id, idx) => idList.indexOf(id) !== idx);
	const duplicateSet = new Set(duplicateIds);

	for (let i = 0; i < components.length; i++) {
		const c = components[i] as RawComponent;
		const compLabel = typeof c.id === 'string' ? c.id : `component at index ${i}`;

		if (!c || typeof c !== 'object') {
			errors.push(`Component at index ${i} must be an object`);
			continue;
		}

		// id
		if (c.id === undefined || c.id === null) {
			errors.push(`Component at index ${i} missing 'id'`);
		} else if (typeof c.id !== 'string') {
			errors.push(`Component ${compLabel} 'id' must be a non-empty string`);
		} else if (c.id.trim() === '') {
			errors.push(`Component at index ${i} 'id' must be a non-empty string`);
		}

		// provider
		if (c.provider === undefined || c.provider === null) {
			errors.push(`Component ${compLabel} missing 'provider'`);
		} else if (typeof c.provider !== 'string') {
			errors.push(`Component ${compLabel} 'provider' must be a non-empty string`);
		} else if (c.provider.trim() === '') {
			errors.push(`Component ${compLabel} 'provider' must be a non-empty string`);
		}

		// config
		if (c.config !== undefined && c.config !== null && typeof c.config !== 'object') {
			errors.push(`Component ${compLabel} 'config' must be an object`);
		}

		// input array
		if (c.input !== undefined && c.input !== null) {
			if (!Array.isArray(c.input)) {
				errors.push(`Component ${compLabel} 'input' must be an array`);
			} else {
				for (let j = 0; j < c.input.length; j++) {
					const conn = c.input[j] as PipelineInputConnection;
					if (!conn || typeof conn !== 'object') {
						errors.push(`Component ${compLabel} input entry ${j} must be an object`);
						continue;
					}
					if (conn.from === undefined || conn.from === null || typeof conn.from !== 'string' || (conn.from as string).trim() === '') {
						errors.push(`Component ${compLabel} input entry ${j} 'from' must be a non-empty string`);
					} else if (!allIds.has(conn.from as string)) {
						errors.push(`Component ${compLabel} input references unknown component id: ${conn.from}`);
					}
					if (conn.lane === undefined || conn.lane === null || typeof conn.lane !== 'string' || (conn.lane as string).trim() === '') {
						errors.push(`Component ${compLabel} input entry ${j} 'lane' must be a non-empty string`);
					}
				}
			}
		}
	}

	for (const id of duplicateSet) {
		errors.push(`Duplicate component id: ${id}`);
	}

	// Source: required and must reference an existing component
	if (!source || typeof source !== 'string' || source.trim() === '') {
		errors.push("'source' must be a non-empty string (or have one component with config.mode === 'Source')");
	} else if (!allIds.has(source)) {
		errors.push(`'source' references unknown component id: ${source}`);
	}

	const valid = errors.length === 0;
	return {
		valid,
		errors,
		normalized: valid ? { components, source: source! } : undefined
	};
}
