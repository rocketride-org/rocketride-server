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
// CANVAS - REACT FLOW PROPS THIS CANVAS RELIES ON (pinned to the installed version)
// =============================================================================
//
// The workspace pins @xyflow/react at 12.3.x (locked 12.3.6). At that version:
//
//   - `disableKeyboardA11y` turns off the built-in keyboard handling of nodes
//     ENTIRELY (arrow-key moves, and Enter/Space/Escape selection), and removes
//     the built-in aria-live message and the "use the arrow keys to move the
//     node" description. That is what this canvas wants: its own keyboard model
//     (graph/keynav.ts) owns every key, and nothing tells a screen-reader user
//     that arrow keys move nodes.
//   - Tab focus is NOT governed by it: a node is tabbable when it is `focusable`
//     (per node) or `nodesFocusable` is on. The canvas turns `nodesFocusable`
//     off and marks only the roving node `focusable`, so exactly one node is in
//     the tab order.
//   - `panActivationKeyCode` (default Space), `deleteKeyCode` (default
//     Backspace) and `selectionKeyCode` (default Shift) are bound by default;
//     the canvas releases them so Space can select and Delete can dismiss.
//
// The modern documentation describes props that DO NOT EXIST at this version
// (`ariaLabelConfig`, `autoPanOnNodeFocus`, node `ariaRole`, `domAttributes`),
// and says `disableKeyboardA11y` keeps selection working, which it does not
// here. `satisfies Partial<ReactFlowProps>` makes this object fail the
// typecheck if a prop is renamed or removed by an upgrade, and the test
// (tests/flowProps.test.ts) fails if an upgrade ADDS the modern props or changes
// the version, so the semantics above are re-checked before anything ships.
// =============================================================================

import type { ReactFlowProps } from '@xyflow/react';

/** Keyboard, focus and selection settings of the graph canvas. */
export const FLOW_INTERACTION_PROPS = {
	disableKeyboardA11y: true,
	nodesFocusable: false,
	edgesFocusable: false,
	nodesConnectable: false,
	elementsSelectable: false,
	panActivationKeyCode: null,
	deleteKeyCode: null,
	selectionKeyCode: null,
	multiSelectionKeyCode: null,
	zoomActivationKeyCode: null,
	// Pointer behaviour: drag nodes, pan and zoom the canvas; a double click on a node expands it.
	nodesDraggable: true,
	zoomOnDoubleClick: false,
	panOnDrag: true,
	minZoom: 0.1,
	maxZoom: 2.5,
} satisfies Partial<ReactFlowProps>;

/** The installed major.minor this file was written for. */
export const REACT_FLOW_VERSION_LINE = '12.3';
