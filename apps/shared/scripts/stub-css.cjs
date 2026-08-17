// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * node:test preload — stubs style imports for the component smoke tests.
 *
 * The shell barrel side-effect-imports stylesheets (e.g. Tabulator's CSS from
 * the DataGrid module). Bundlers handle those; node cannot execute CSS, so the
 * smoke-test runner registers a no-op compiler for style extensions. Loaded
 * via `--require` before tsx starts resolving test files.
 */

// step: register a no-op loader for every stylesheet extension node may hit
for (const ext of ['.css', '.scss', '.sass', '.less']) {
	require.extensions[ext] = () => {};
}
