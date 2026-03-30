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
 * Programmatic Pipeline Builder for RocketRide.
 *
 * Provides a fluent API for constructing RocketRide pipelines without manually
 * editing JSON. Pipelines built with this API produce valid .pipe JSON that
 * the RocketRide engine can execute.
 *
 * @example Basic usage
 * ```typescript
 * import { Pipeline } from 'rocketride';
 *
 * const pipeline = new Pipeline()
 *   .addNode('webhook_1', 'webhook', { source: true })
 *   .addNode('parse_1', 'parse')
 *   .connect('webhook_1', 'parse_1', { lane: 'tags' })
 *   .addNode('response_1', 'response_text', { config: { laneName: 'text' } })
 *   .connect('parse_1', 'response_1', { lane: 'text' });
 *
 * // Export to .pipe JSON
 * const json = pipeline.toJSON();
 *
 * // Save to file (Node.js)
 * pipeline.toFile('my_pipeline.pipe');
 *
 * // Load from existing file
 * const loaded = Pipeline.fromFile('existing.pipe');
 * ```
 *
 * @packageDocumentation
 */

import { readFileSync, writeFileSync } from 'fs';
import type { PipelineComponent, PipelineConfig } from './types/pipeline.js';

/** Source provider types that receive automatic source config. */
const SOURCE_PROVIDERS = new Set(['webhook', 'chat', 'dropper']);

/** UUID v4 regex for validation. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Error thrown when pipeline validation fails.
 */
export class PipelineValidationError extends Error {
	/** Individual validation error messages. */
	public readonly errors: string[];

	constructor(errors: string[]) {
		super('Pipeline validation failed:\n' + errors.map((e) => `  - ${e}`).join('\n'));
		this.name = 'PipelineValidationError';
		this.errors = errors;
	}
}

/** Options for {@link Pipeline.addNode}. */
export interface AddNodeOptions {
	/** Provider-specific configuration. */
	config?: Record<string, unknown>;
	/** Mark this node as the pipeline source/entry point. */
	source?: boolean;
}

/** Options for {@link Pipeline.connect}. */
export interface ConnectOptions {
	/** Data lane type (default: `"text"`). */
	lane?: string;
}

/** Options for {@link Pipeline.connectControl}. */
export interface ConnectControlOptions {
	/** Control channel class type (default: `"llm"`). */
	classType?: string;
}

/**
 * Fluent builder for constructing RocketRide `.pipe` pipeline definitions.
 *
 * A `Pipeline` manages a directed graph of components (nodes) connected by
 * typed data lanes. It can export to the `.pipe` JSON format consumed by
 * the RocketRide engine and validate the graph for common errors.
 */
export class Pipeline {
	/** Unique GUID identifying this pipeline. */
	public projectId: string;

	private _nodes: Map<string, PipelineComponent> = new Map();
	private _nodeOrder: string[] = [];
	private _sourceId: string | null = null;
	private _viewport = { x: 0, y: 0, zoom: 1 };

	/**
	 * Create a new empty pipeline.
	 *
	 * @param projectId - Optional UUID for the pipeline. A new one is
	 *   generated automatically if omitted.
	 */
	constructor(projectId?: string) {
		this.projectId = projectId ?? crypto.randomUUID();
	}

	// ------------------------------------------------------------------
	// Node management
	// ------------------------------------------------------------------

	/**
	 * Add a component node to the pipeline.
	 *
	 * @param nodeId - Unique identifier (e.g. `"llm_1"`).
	 * @param provider - Component provider type (e.g. `"llm_openai"`).
	 * @param options - Optional config and source flag.
	 * @returns `this` for fluent chaining.
	 */
	addNode(nodeId: string, provider: string, options: AddNodeOptions = {}): this {
		if (this._nodes.has(nodeId)) {
			throw new Error(`Node '${nodeId}' already exists in the pipeline`);
		}
		if (options.source && this._sourceId !== null) {
			throw new Error(`Pipeline already has a source node '${this._sourceId}'. ` + `Cannot add '${nodeId}' as a second source.`);
		}

		const config: Record<string, unknown> = { ...(options.config ?? {}) };

		// Auto-populate required source config fields
		if (options.source || SOURCE_PROVIDERS.has(provider)) {
			config.hideForm ??= true;
			config.mode ??= 'Source';
			config.parameters ??= {};
			config.type ??= provider;
			this._sourceId = nodeId;
		}

		const component: PipelineComponent = {
			id: nodeId,
			provider,
			config,
		};

		this._nodes.set(nodeId, component);
		this._nodeOrder.push(nodeId);
		return this;
	}

	/**
	 * Update configuration of an existing node (shallow merge).
	 *
	 * @param nodeId - ID of the node to configure.
	 * @param config - Configuration to merge.
	 * @returns `this` for fluent chaining.
	 */
	configureNode(nodeId: string, config: Record<string, unknown>): this {
		const node = this._getNode(nodeId);
		Object.assign(node.config, config);
		return this;
	}

	/**
	 * Remove a node and all its connections from the pipeline.
	 *
	 * @param nodeId - ID of the node to remove.
	 * @returns `this` for fluent chaining.
	 */
	removeNode(nodeId: string): this {
		if (!this._nodes.has(nodeId)) {
			throw new Error(`Node '${nodeId}' not found in the pipeline`);
		}

		this._nodes.delete(nodeId);
		this._nodeOrder = this._nodeOrder.filter((id) => id !== nodeId);

		if (this._sourceId === nodeId) {
			this._sourceId = null;
		}

		// Remove connections referencing this node
		for (const component of this._nodes.values()) {
			if (component.input) {
				component.input = component.input.filter((inp) => inp.from !== nodeId);
				if (component.input.length === 0) {
					delete component.input;
				}
			}
			if (component.control) {
				component.control = component.control.filter((ctrl) => ctrl.from !== nodeId);
				if (component.control.length === 0) {
					delete component.control;
				}
			}
		}

		return this;
	}

	// ------------------------------------------------------------------
	// Connection management
	// ------------------------------------------------------------------

	/**
	 * Connect two nodes with a data lane.
	 *
	 * @param sourceId - Upstream node producing data.
	 * @param targetId - Downstream node consuming data.
	 * @param options - Lane type (default: `"text"`).
	 * @returns `this` for fluent chaining.
	 */
	connect(sourceId: string, targetId: string, options: ConnectOptions = {}): this {
		this._getNode(sourceId);
		const target = this._getNode(targetId);
		const lane = options.lane ?? 'text';

		if (!target.input) {
			target.input = [];
		}
		target.input.push({ lane, from: sourceId });
		return this;
	}

	/**
	 * Add a control-flow connection between two nodes.
	 *
	 * @param sourceId - Upstream node.
	 * @param targetId - Downstream node.
	 * @param options - Class type (default: `"llm"`).
	 * @returns `this` for fluent chaining.
	 */
	connectControl(sourceId: string, targetId: string, options: ConnectControlOptions = {}): this {
		this._getNode(sourceId);
		const target = this._getNode(targetId);
		const classType = options.classType ?? 'llm';

		if (!target.control) {
			target.control = [];
		}
		target.control.push({ classType, from: sourceId });
		return this;
	}

	/**
	 * Remove data-lane connections from `sourceId` to `targetId`.
	 *
	 * @param sourceId - Upstream node ID.
	 * @param targetId - Downstream node ID.
	 * @param lane - If provided, only remove connections on this lane.
	 * @returns `this` for fluent chaining.
	 */
	disconnect(sourceId: string, targetId: string, lane?: string): this {
		const target = this._nodes.get(targetId);
		if (!target?.input) return this;

		target.input = target.input.filter((inp) => !(inp.from === sourceId && (lane === undefined || inp.lane === lane)));
		if (target.input.length === 0) {
			delete target.input;
		}
		return this;
	}

	// ------------------------------------------------------------------
	// Serialization
	// ------------------------------------------------------------------

	/**
	 * Return the pipeline as a plain object matching .pipe JSON format.
	 */
	toDict(): PipelineConfig {
		const components = this._nodeOrder.map((id) => this._nodes.get(id)!);
		const result: PipelineConfig = {
			components,
			project_id: this.projectId,
			viewport: { ...this._viewport },
			version: 1,
		};
		if (this._sourceId) {
			result.source = this._sourceId;
		}
		return result;
	}

	/**
	 * Serialize the pipeline to a .pipe-compatible JSON string.
	 *
	 * @param indent - Indentation (default: 2 spaces).
	 */
	toJSON(indent: number = 2): string {
		return JSON.stringify(this.toDict(), null, indent);
	}

	/**
	 * Write the pipeline to a `.pipe` file (Node.js only).
	 *
	 * @param path - File path (should end with `.pipe`).
	 * @param indent - JSON indentation level.
	 */
	toFile(path: string, indent: number = 2): void {
		writeFileSync(path, this.toJSON(indent) + '\n', 'utf-8');
	}

	// ------------------------------------------------------------------
	// Deserialization
	// ------------------------------------------------------------------

	/**
	 * Create a Pipeline from a plain object (parsed .pipe JSON).
	 */
	static fromDict(data: PipelineConfig): Pipeline {
		const pipeline = new Pipeline(data.project_id ?? crypto.randomUUID());
		pipeline._viewport = data.viewport ?? { x: 0, y: 0, zoom: 1 };
		pipeline._sourceId = data.source ?? null;

		for (const comp of data.components ?? []) {
			const component: PipelineComponent = { ...comp };
			pipeline._nodes.set(comp.id, component);
			pipeline._nodeOrder.push(comp.id);

			// Detect source from config
			if ((component.config as Record<string, unknown>)?.mode === 'Source') {
				pipeline._sourceId = pipeline._sourceId ?? comp.id;
			}
		}

		return pipeline;
	}

	/**
	 * Create a Pipeline from a JSON string.
	 */
	static fromJSON(jsonStr: string): Pipeline {
		return Pipeline.fromDict(JSON.parse(jsonStr));
	}

	/**
	 * Load a Pipeline from a `.pipe` file (Node.js only).
	 */
	static fromFile(path: string): Pipeline {
		const content = readFileSync(path, 'utf-8');
		return Pipeline.fromJSON(content);
	}

	// ------------------------------------------------------------------
	// Validation
	// ------------------------------------------------------------------

	/**
	 * Validate the pipeline graph and return an array of error messages.
	 *
	 * Checks:
	 * - At least one component exists
	 * - Exactly one source node is defined
	 * - All input/control references point to existing nodes
	 * - The graph contains no cycles
	 * - `projectId` looks like a UUID
	 *
	 * @returns An array of error strings. Empty means valid.
	 */
	validate(): string[] {
		const errors: string[] = [];

		if (this._nodes.size === 0) {
			errors.push('Pipeline has no components');
			return errors;
		}

		// Check project_id
		if (!this.projectId) {
			errors.push('Pipeline is missing a project_id');
		} else if (!UUID_RE.test(this.projectId)) {
			errors.push(`project_id '${this.projectId}' is not a valid UUID`);
		}

		// Check source node
		const sourceNodes: string[] = [];
		for (const [id, comp] of this._nodes) {
			if ((comp.config as Record<string, unknown>)?.mode === 'Source') {
				sourceNodes.push(id);
			}
		}
		if (sourceNodes.length === 0 && this._sourceId === null) {
			errors.push('Pipeline has no source node');
		} else if (sourceNodes.length > 1) {
			errors.push(`Pipeline has multiple source nodes: ${sourceNodes.join(', ')}`);
		}

		// Check references
		for (const [id, comp] of this._nodes) {
			for (const inp of comp.input ?? []) {
				if (!this._nodes.has(inp.from)) {
					errors.push(`Node '${id}' references unknown input node '${inp.from}'`);
				}
			}
			for (const ctrl of comp.control ?? []) {
				if (!this._nodes.has(ctrl.from)) {
					errors.push(`Node '${id}' references unknown control node '${ctrl.from}'`);
				}
			}
		}

		// Cycle detection (Kahn's algorithm)
		const inDegree = new Map<string, number>();
		const adjacency = new Map<string, string[]>();
		for (const id of this._nodes.keys()) {
			inDegree.set(id, 0);
			adjacency.set(id, []);
		}

		for (const [id, comp] of this._nodes) {
			for (const inp of comp.input ?? []) {
				if (this._nodes.has(inp.from)) {
					adjacency.get(inp.from)!.push(id);
					inDegree.set(id, inDegree.get(id)! + 1);
				}
			}
			for (const ctrl of comp.control ?? []) {
				if (this._nodes.has(ctrl.from)) {
					adjacency.get(ctrl.from)!.push(id);
					inDegree.set(id, inDegree.get(id)! + 1);
				}
			}
		}

		const queue: string[] = [];
		for (const [id, deg] of inDegree) {
			if (deg === 0) queue.push(id);
		}

		let visited = 0;
		while (queue.length > 0) {
			const node = queue.shift()!;
			visited++;
			for (const neighbour of adjacency.get(node)!) {
				const newDeg = inDegree.get(neighbour)! - 1;
				inDegree.set(neighbour, newDeg);
				if (newDeg === 0) queue.push(neighbour);
			}
		}

		if (visited !== this._nodes.size) {
			errors.push('Pipeline graph contains a cycle');
		}

		return errors;
	}

	/**
	 * Validate the pipeline and throw if there are errors.
	 *
	 * @throws PipelineValidationError
	 */
	validateOrThrow(): void {
		const errors = this.validate();
		if (errors.length > 0) {
			throw new PipelineValidationError(errors);
		}
	}

	// ------------------------------------------------------------------
	// Introspection helpers
	// ------------------------------------------------------------------

	/** All node IDs in insertion order. */
	get nodeIds(): string[] {
		return [...this._nodeOrder];
	}

	/** Number of nodes in the pipeline. */
	get size(): number {
		return this._nodes.size;
	}

	/**
	 * Return a copy of the raw component object for a node.
	 */
	getNode(nodeId: string): PipelineComponent {
		return { ...this._getNode(nodeId) };
	}

	// ------------------------------------------------------------------
	// Private helpers
	// ------------------------------------------------------------------

	private _getNode(nodeId: string): PipelineComponent {
		const node = this._nodes.get(nodeId);
		if (!node) {
			throw new Error(`Node '${nodeId}' not found in the pipeline`);
		}
		return node;
	}
}
