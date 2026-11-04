// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * node:test preload — stubs the 'shell'/'rocketride' platform modules.
 *
 * At runtime the platform arrives through the shell's Module Federation share
 * scope. In the test runner there is no shell: the bare specifier resolves to
 * the workspace source package, whose barrel side-effect-imports stylesheets
 * and browser-only modules that node cannot execute. Nearly every tested
 * module here imports the platform TYPE-ONLY (erased by tsx, so it never
 * reaches this hook); `src/docs.ts` is the exception — it imports `Documents`
 * and `NOOP_VFS` as values, but only USES them inside functions the pure-logic
 * suites never call, so an inert stub is enough.
 *
 * Keep the stub inert on purpose: any named import resolving to `undefined`
 * fails loudly the moment a test actually depends on shell behaviour, which is
 * the signal to test that module differently (or not at all). `commonStyles`
 * is the one real export, because module-scope spreads like
 * `...commonStyles.columnFill` would throw during import.
 *
 * Loaded via `--require` before tsx starts resolving test files.
 */

const Module = require('module');

const stub = {
	// Any style-fragment lookup yields an empty, spreadable object.
	commonStyles: new Proxy({}, { get: () => ({}) }),
};

// The shell's own sources, which the dev-tool test harness
// (shared/explorer/devtool/testing.ts) loads by relative path, need the REAL
// SDK: RocketRideClientProxy extends RocketRideClient, and a stub makes that
// `extends undefined`. Only files under packages/shell/src/ get it; everything
// else keeps the stub.
const SHELL_SOURCES = /[\\/]packages[\\/]shell[\\/]src[\\/]/;

// step: intercept CJS loads of the platform specifiers before tsx resolves them
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'rocketride' && parent && SHELL_SOURCES.test(parent.filename || '')) {
		return origLoad.call(this, request, parent, isMain);
	}
	if (request === 'shell' || request === 'rocketride') return stub;
	return origLoad.call(this, request, parent, isMain);
};
