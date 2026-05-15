// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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
 * Types for the pipeline template system.
 *
 * A template defines a pre-built pipeline skeleton. Some components are
 * fully specified (fixed provider), while others reference a `requires`
 * slot that the user fills by choosing from a filtered service list.
 */

// ============================================================================
// Template Requirement
// ============================================================================

/**
 * A slot the user must fill when instantiating a template.
 * The UI filters the service catalog by `classType` and presents
 * matching services for the user to choose from.
 */
export interface ITemplateRequirement {
	/** The classType used to filter available services (e.g. "store", "embedding"). */
	classType: string;
	/** Human-readable label shown in the picker dialog (e.g. "Vector Store"). */
	label: string;
}

// ============================================================================
// Template Component
// ============================================================================

/**
 * A single node in the template's component list.
 *
 * - If `provider` is set, this is a fully-specified (fixed) component.
 * - If `ref` is set, it references a key in the template's `requires`
 *   map. At instantiation time, the ref is replaced with the provider
 *   the user chose for that slot.
 */
export interface ITemplateComponent {
	/** Unique ID within the template (used for connection references). */
	id: string;

	/** Fixed provider key. Mutually exclusive with `ref`. */
	provider?: string;

	/** Reference to a `requires` key. Mutually exclusive with `provider`. */
	ref?: string;

	/** Incoming data-lane connections. */
	input: { lane: string; from: string }[];

	/** Incoming invoke (control-flow) connections. */
	control: { classType: string; from: string }[];

	/** Optional position on the canvas. */
	position?: { x: number; y: number };
}

// ============================================================================
// Template Definition
// ============================================================================

/**
 * A complete pipeline template definition as stored in templates.json.
 */
export interface ITemplate {
	/** Display title (e.g. "RAG Pipeline"). */
	title: string;

	/** Short description shown in the picker. */
	description: string;

	/** Slots the user must fill (keyed by slot name). */
	requires: Record<string, ITemplateRequirement>;

	/** The component list — mix of fixed and ref-based entries. */
	components: ITemplateComponent[];
}

/**
 * The top-level templates.json shape: a dictionary of templates keyed by slug.
 */
export type ITemplateCatalog = Record<string, ITemplate>;
