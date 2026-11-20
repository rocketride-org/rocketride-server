// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// REACT FLOW AT THE PINNED VERSION: the props the canvas relies on exist, the
// modern ones it must not use do not
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FLOW_INTERACTION_PROPS, REACT_FLOW_VERSION_LINE } from '../src/canvas/flowProps';

const APP_ROOT = path.resolve(__dirname, '..');
const flowRoot = fs.realpathSync(path.join(APP_ROOT, 'node_modules', '@xyflow', 'react'));
const pkg = JSON.parse(fs.readFileSync(path.join(flowRoot, 'package.json'), 'utf8'));
const props = fs.readFileSync(path.join(flowRoot, 'dist', 'esm', 'types', 'component-props.d.ts'), 'utf8');
const runtime = fs.readFileSync(path.join(flowRoot, 'dist', 'esm', 'index.js'), 'utf8');

test('the installed React Flow is on the 12.3 line this canvas was written for', () => {
	assert.ok(String(pkg.version).startsWith(`${REACT_FLOW_VERSION_LINE}.`), `installed ${pkg.version}; re-check src/canvas/flowProps.ts before changing REACT_FLOW_VERSION_LINE`);
});

test('every prop the canvas sets exists in the installed typings', () => {
	for (const name of Object.keys(FLOW_INTERACTION_PROPS)) assert.match(props, new RegExp(`\\b${name}\\??:`), `${name} is not a ReactFlow prop at ${pkg.version}`);
});

test('the modern accessibility props are NOT available at this version, so the code must not use them', () => {
	for (const name of ['ariaLabelConfig', 'autoPanOnNodeFocus']) {
		assert.doesNotMatch(props, new RegExp(`\\b${name}\\??:`), `${name} now exists: an upgrade changed the accessibility surface, re-evaluate flowProps.ts and the keyboard model`);
		assert.ok(!runtime.includes(name), `${name} is now in the runtime`);
	}
});

test('disableKeyboardA11y still disables the whole node key handler, as the keyboard model assumes', () => {
	// The behaviour the canvas relies on: with the flag the node key handler returns before it handles Enter/Space or arrows.
	assert.match(runtime, /if \(isInputDOMNode\(event\.nativeEvent\) \|\| disableKeyboardA11y\) \{\s*return;\s*\}/);
	// And tab focus depends on `focusable`, not on the flag.
	assert.match(runtime, /tabIndex: isFocusable \? 0 : undefined/);
});

test('the canvas takes every key binding that would conflict with its own keyboard model', () => {
	assert.equal(FLOW_INTERACTION_PROPS.disableKeyboardA11y, true);
	assert.equal(FLOW_INTERACTION_PROPS.nodesFocusable, false);
	for (const key of ['panActivationKeyCode', 'deleteKeyCode', 'selectionKeyCode', 'multiSelectionKeyCode'] as const) assert.equal(FLOW_INTERACTION_PROPS[key], null, key);
});
