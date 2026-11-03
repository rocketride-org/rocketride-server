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

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSettingsRegistry, effectiveSettings, settingStoreOf, SHELL_SECTION_ID } from './settingsRegistry';
import { getSettingsContributions, onSettingsContributionsChanged, registerSettings } from './settingsContributions';
import type { AppConfiguration, AppManifestEntry } from './types';

/** Minimal manifest entry fixture — only the fields the registry reads. */
function appEntry(id: string, configuration?: AppConfiguration, onDesktop = true): AppManifestEntry {
	return {
		id,
		moduleId: id.replace(/\W/g, '_'),
		name: id,
		configuration,
		onDesktop,
		load: () => Promise.reject(new Error('not loaded in tests')),
	};
}

test('shell General section exists with an empty manifest and declares the sidebar setting', () => {
	const registry = buildSettingsRegistry([]);

	assert.equal(registry.sections.length, 1);
	const general = registry.sections[0];
	assert.equal(general.id, SHELL_SECTION_ID);
	assert.equal(general.title, 'General');
	assert.ok(general.entries.some((e) => e.key === 'rocketride.general.sidebar'));

	const schema = registry.schemas.get('rocketride.general.sidebar');
	assert.ok(schema);
	assert.deepEqual(schema.enum, ['default', 'vscode', 'cursor', 'rocketride']);
	assert.equal(registry.defaults['rocketride.general.sidebar'], 'default');
});

test('General precedes app sections and shell keys win first-wins dedup', () => {
	const hijacker = appEntry('evil.app', {
		title: 'Evil',
		properties: {
			'rocketride.general.sidebar': { type: 'string', default: 'cursor' },
			'evil.app.own': { type: 'boolean', default: true },
		},
	});
	const registry = buildSettingsRegistry([hijacker]);

	assert.equal(registry.sections[0].id, SHELL_SECTION_ID);
	// The shell's schema survives; the app's redeclaration is dropped
	assert.equal(registry.defaults['rocketride.general.sidebar'], 'default');
	const evil = registry.sections.find((s) => s.title === 'Evil');
	assert.ok(evil);
	assert.deepEqual(evil.entries.map((e) => e.key), ['evil.app.own']);
});

test('apps declaring the title "General" merge into the shell section after its entries', () => {
	const friend = appEntry('nice.app', {
		title: 'General',
		properties: { 'nice.app.flag': { type: 'boolean', default: false } },
	});
	const registry = buildSettingsRegistry([friend]);

	assert.equal(registry.sections.length, 1);
	const general = registry.sections[0];
	assert.equal(general.id, SHELL_SECTION_ID);
	assert.deepEqual(general.appIds, [SHELL_SECTION_ID, 'nice.app']);
	assert.deepEqual(general.entries.map((e) => e.key), ['rocketride.general.sidebar', 'nice.app.flag']);
});

test('apps off the desktop contribute nothing', () => {
	const uninstalled = appEntry('store.app', { title: 'Store App', properties: { 'store.app.x': { type: 'string' } } }, false);
	const registry = buildSettingsRegistry([uninstalled]);

	assert.equal(registry.sections.length, 1);
	assert.equal(registry.schemas.has('store.app.x'), false);
});

test('effectiveSettings resolves shell defaults and honors overrides', () => {
	const registry = buildSettingsRegistry([]);

	assert.equal(effectiveSettings(registry, {})['rocketride.general.sidebar'], 'default');
	assert.equal(effectiveSettings(registry, { 'rocketride.general.sidebar': 'rocketride' })['rocketride.general.sidebar'], 'rocketride');
});

// =============================================================================
// SHELLS FILTERING
// =============================================================================

test('entries whose shells exclude the running edition are dropped; no shell option = no filtering', () => {
	const app = appEntry('acme.app', {
		title: 'Acme',
		properties: {
			'acme.app.everywhere': { type: 'boolean', default: true },
			'acme.app.vscodeOnly': { type: 'boolean', default: false, shells: ['vscode'] },
		},
	});

	// Unfiltered build (no shell named): everything included
	const unfiltered = buildSettingsRegistry([app]);
	assert.ok(unfiltered.schemas.has('acme.app.vscodeOnly'));

	const saas = buildSettingsRegistry([app], { shell: 'saas' });
	assert.ok(saas.schemas.has('acme.app.everywhere'));
	assert.equal(saas.schemas.has('acme.app.vscodeOnly'), false);

	const vscode = buildSettingsRegistry([app], { shell: 'vscode' });
	assert.ok(vscode.schemas.has('acme.app.vscodeOnly'));
});

test('a configuration whose every entry is edition-foreign creates no empty section', () => {
	const app = appEntry('acme.app', {
		title: 'Acme',
		properties: { 'acme.app.vscodeOnly': { type: 'boolean', shells: ['vscode'] } },
	});
	const registry = buildSettingsRegistry([app], { shell: 'saas' });

	assert.equal(registry.sections.some((s) => s.title === 'Acme'), false);
});

test('the shell sidebar setting is cloud-only (shells saas/oss)', () => {
	const vscode = buildSettingsRegistry([], { shell: 'vscode' });
	assert.equal(vscode.schemas.has('rocketride.general.sidebar'), false);

	const saas = buildSettingsRegistry([], { shell: 'saas' });
	assert.ok(saas.schemas.has('rocketride.general.sidebar'));
});

// =============================================================================
// CONTRIBUTIONS
// =============================================================================

test('contributions fold in after the shell and before apps; keys dedupe first-wins', () => {
	const contribution = {
		appId: 'builtin.pipelines',
		name: 'Pipelines',
		configuration: {
			title: 'Pipelines',
			properties: { 'rocketride.pipeBuilder.pipelineTTL': { type: 'integer' as const, default: 900 } },
		},
	};
	// An app redeclaring a contributed key loses (first-wins)
	const app = appEntry('late.app', {
		title: 'Late',
		properties: { 'rocketride.pipeBuilder.pipelineTTL': { type: 'integer', default: 1 } },
	});
	const registry = buildSettingsRegistry([app], { contributions: [contribution] });

	assert.deepEqual(registry.sections.map((s) => s.title), ['General', 'Pipelines']);
	assert.equal(registry.defaults['rocketride.pipeBuilder.pipelineTTL'], 900);
	const entry = registry.sections[1].entries[0];
	assert.equal(entry.owner, 'builtin.pipelines');
});

test('storageAppId overrides where workspace values live (builtins → the product partition)', () => {
	const contribution = {
		appId: 'builtin.pipelines',
		name: 'Pipelines',
		storageAppId: 'rocketride.pipeBuilder',
		configuration: {
			title: 'Pipelines',
			properties: { 'rocketride.pipeBuilder.pipelineTTL': { type: 'integer' as const, default: 900 } },
		},
	};
	const registry = buildSettingsRegistry([], { contributions: [contribution] });

	const section = registry.sections.find((s) => s.title === 'Pipelines');
	assert.equal(section?.id, 'builtin.pipelines', 'section identity stays the contributor');
	assert.equal(section?.entries[0]?.owner, 'rocketride.pipeBuilder', 'value storage routes to the product partition');
});

test('a contribution whose shells exclude the edition contributes nothing', () => {
	const contribution = {
		appId: 'builtin.agent',
		name: 'Agent',
		shells: ['saas', 'oss'],
		configuration: { title: 'Agent', properties: { 'rocketride.agent.x': { type: 'string' as const } } },
	};
	const registry = buildSettingsRegistry([], { shell: 'vscode', contributions: [contribution] });

	assert.equal(registry.schemas.has('rocketride.agent.x'), false);
});

test('registerSettings registers, replaces by appId, and unregisters; the change feed fires', () => {
	let changes = 0;
	const off = onSettingsContributionsChanged(() => changes++);
	const before = getSettingsContributions().length;

	const unregister = registerSettings({
		appId: 'test.tool',
		name: 'Test Tool',
		configuration: { properties: { 'test.tool.a': { type: 'boolean', default: false } } },
	});
	assert.equal(getSettingsContributions().length, before + 1);
	assert.equal(changes, 1);

	// Re-registering the same appId replaces, never duplicates
	registerSettings({
		appId: 'test.tool',
		name: 'Test Tool',
		configuration: { properties: { 'test.tool.b': { type: 'boolean', default: true } } },
	});
	assert.equal(getSettingsContributions().length, before + 1);
	assert.equal(getSettingsContributions().find((c) => c.appId === 'test.tool')?.configuration.properties['test.tool.b']?.default, true);
	assert.equal(changes, 2);

	// The ORIGINAL registration's disposer is stale after replacement — a no-op
	unregister();
	assert.equal(getSettingsContributions().length, before + 1);
	assert.equal(changes, 2);

	// Clean up via a fresh registration's disposer
	const unregister2 = registerSettings({
		appId: 'test.tool',
		name: 'Test Tool',
		configuration: { properties: {} },
	});
	unregister2();
	assert.equal(getSettingsContributions().some((c) => c.appId === 'test.tool'), false);
	off();
});

// =============================================================================
// STORE RESOLUTION
// =============================================================================

test('settingStoreOf defaults to workspace and honors the declaration', () => {
	assert.equal(settingStoreOf({ type: 'boolean' }), 'workspace');
	assert.equal(settingStoreOf({ type: 'boolean', store: 'user' }), 'user');
	assert.equal(settingStoreOf({ type: 'boolean', store: 'host' }), 'host');
});

test('entries record their owner (shell keys owned by the shell section)', () => {
	const registry = buildSettingsRegistry([]);
	const sidebar = registry.sections[0].entries.find((e) => e.key === 'rocketride.general.sidebar');
	assert.equal(sidebar?.owner, SHELL_SECTION_ID);
});
