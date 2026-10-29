// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Eval trial preload: stands in for the browser-only 'shell' module.
 *
 * Only 'shell' is replaced. 'rocketride' (the real TypeScript client) loads as
 * it is. getClient returns the client the trial installs (the fake engine, or
 * a connected RocketRideClient). CachedVfs is the shell's real class, so the
 * rocket-ui workspace runs unchanged. The bus is silent. A name the agent
 * reads that this stub lacks is recorded, so a gap shows in the record.
 */
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '../../../../../..');
const missing = new Set();

const bus = { emit: () => {}, on: () => () => {}, off: () => {}, subscribe: () => () => {} };

const impl = {
	getClient: () => globalThis.__evalClient ?? null,
	get CachedVfs() {
		return require(path.join(REPO, 'packages/shell/src/modules/explorer/CachedVfs.ts')).CachedVfs;
	},
	ConnectionManager: { getInstance: () => bus },
	showConfirmDialog: async (title, message) => {
		(globalThis.__evalConfirms ??= []).push({ title: String(title), answer: 'no', message: String(message).slice(0, 300) });
		return false;
	},
	commonStyles: new Proxy({}, { get: () => ({}) }),
	useWorkspace: () => ({}),
};

const stub = new Proxy(impl, {
	get(target, key) {
		if (key in target) return target[key];
		if (typeof key === 'string' && key !== 'then' && key !== '__esModule' && !missing.has(key)) {
			missing.add(key);
			(globalThis.__evalShellMissing ??= []).push(key);
		}
		return undefined;
	},
});

const original = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'shell') return stub;
	return original.call(this, request, parent, isMain);
};
