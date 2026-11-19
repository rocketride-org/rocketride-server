// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * node:test preload — stubs the 'shell' platform module.
 *
 * At runtime the shell arrives through the Module Federation share scope; in
 * the smoke-test runner there is no shell, and tsconfig maps the specifier
 * onto a type declaration (empty at runtime). Named imports resolve to
 * undefined, which is fine for the component smoke tests — except for
 * module-scope style spreads like `...commonStyles.textEllipsis`, which need
 * commonStyles to be an object. This stub returns a module whose commonStyles
 * hands back an empty style fragment for any name and leaves every other
 * export undefined, matching what the tests already tolerate. Loaded via
 * `--require` before tsx starts resolving test files.
 *
 * 'rocketride' is NOT stubbed: it is a workspace dependency (the SDK's own
 * build), and pure modules under test (the Assets model's path and README
 * helpers) call its pure functions for real.
 */

const Module = require('module');

const stub = {
	// Any style-fragment lookup yields an empty, spreadable object.
	commonStyles: new Proxy({}, { get: () => ({}) }),
};

// step: intercept CJS loads of the shell specifier before tsx resolves it
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'shell') return stub;
	return origLoad.call(this, request, parent, isMain);
};
