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
// COMPONENT GALLERY — SHARED TYPES
// =============================================================================

/**
 * Types for the App Builder's component gallery (`appdev/gallery`).
 *
 * The gallery is the in-product explorer for the stock shared-ui component
 * library: pick a component in the list, see everything about it in the
 * detail pane — blurb, LIVE demo of the real component, knob controls, a
 * copyable usage snippet, and the prop contract. One registry entry per
 * component, one implementation file per entry under `entries/`.
 *
 * Entries without a demo (`demo` and `lazyDemo` both absent) are doc-only:
 * shell-owned host chrome that apps never mount themselves — the pane
 * renders the `docNote` explanation in place of the demo frame.
 */

import type React from 'react';

// =============================================================================
// KNOBS
// =============================================================================

/** A single knob value — the union of every control's output type. */
export type KnobValue = boolean | string | number;

/** Values keyed by knob id, passed to the demo and the snippet builder. */
export type KnobValues = Record<string, KnobValue>;

/**
 * One knob a demo exposes. Knobs cover the interesting few props of a
 * component (variant, size, disabled, a label text) — the prop table
 * documents the rest.
 */
export interface IGalleryKnob {
	/** Stable id — the key of this knob's value in {@link KnobValues}. */
	id: string;
	/** Control label. */
	label: string;
	/** Control kind — selects the rendered knob control. */
	kind: 'boolean' | 'select' | 'text' | 'number';
	/** The selectable options (kind 'select' only). */
	options?: string[];
	/** Initial value; its type must match `kind`. */
	defaultValue: KnobValue;
}

// =============================================================================
// PROP DOCUMENTATION
// =============================================================================

/** One row of an entry's prop-contract table. */
export interface IGalleryPropRow {
	/** Prop name as declared on the component's props interface. */
	name: string;
	/** Rendered type expression (kept short; unions spelled out). */
	type: string;
	/** Direction — `in` = data the component consumes, `out` = callback it fires. */
	dir: 'in' | 'out';
	/** Marked when the prop is required. */
	required?: boolean;
	/** One-line description, taken from the component's JSDoc. */
	note: string;
}

// =============================================================================
// ENTRY
// =============================================================================

/** The three gallery groups, matching the style guide's stock table. */
export type GalleryGroup = 'chrome' | 'sidebar' | 'content';

/** Props every live demo component receives. */
export interface IGalleryDemoProps {
	/** Current knob values keyed by knob id (defaults until the user edits). */
	knobs: KnobValues;
}

/** One component's gallery entry. */
export interface IGalleryEntry {
	/** Stable id, kebab-case (e.g. 'status-badge'). */
	id: string;
	/** Display name (e.g. 'StatusBadge / StatusDot'). */
	name: string;
	/** Which list group the entry renders under. */
	group: GalleryGroup;
	/** One-line description — the stock table's "renders" column. */
	blurb: string;
	/** Knob spec; absent = no knob panel. */
	knobs?: IGalleryKnob[];
	/** Live demo rendering the REAL component; absent with lazyDemo = doc-only. */
	demo?: React.ComponentType<IGalleryDemoProps>;
	/** Lazily-loaded demo for heavy components (Tabulator, chat) — loaded on
	    first view of the entry so the appdev bundle stays lean. */
	lazyDemo?: () => Promise<{ default: React.ComponentType<IGalleryDemoProps> }>;
	/** Doc-only explanation shown in place of the demo frame (host chrome). */
	docNote?: string;
	/** Copyable usage snippet — a static string, or a builder over the live
	    knob values so the copied code matches the configured demo. */
	code: string | ((knobs: KnobValues) => string);
	/** The prop contract; omitted for doc-only entries without a component API. */
	props?: IGalleryPropRow[];
}
