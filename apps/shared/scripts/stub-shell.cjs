// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * node:test preload — stubs the 'shell'/'rocketride' platform modules.
 *
 * At runtime the platform arrives through the shell's Module Federation share
 * scope; in the smoke-test runner there is no shell, and tsconfig maps the
 * specifier onto a type declaration (empty at runtime). Named imports resolve
 * to undefined, which is fine for the component smoke tests — except for
 * module-scope style spreads like `...commonStyles.textEllipsis`, which need
 * commonStyles to be an object. This stub returns a module whose commonStyles
 * hands back an empty style fragment for any name and leaves every other
 * export undefined, matching what the tests already tolerate. Loaded via
 * `--require` before tsx starts resolving test files.
 */

const Module = require('module');

const stub = {
	// Any style-fragment lookup yields an empty, spreadable object.
	commonStyles: new Proxy({}, { get: () => ({}) }),
};

// step: intercept CJS loads of the platform specifiers before tsx resolves them
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'shell' || request === 'rocketride') return stub;
	return origLoad.call(this, request, parent, isMain);
};
