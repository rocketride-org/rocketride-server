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
import { buildSettingsRegistry, effectiveSettings, SHELL_SECTION_ID } from './settingsRegistry';
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
