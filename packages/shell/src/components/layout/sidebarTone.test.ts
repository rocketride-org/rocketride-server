// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The ink sidebar an app asks for through `branding.sidebarTone`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { getSidebarToneStyle, isInkSidebar } from './sidebarTone';

test('isInkSidebar: ink only when the app asks and the theme can draw it', () => {
	assert.equal(isInkSidebar('ink', true), true);
	assert.equal(isInkSidebar('ink', false), false);
	assert.equal(isInkSidebar('paper', true), false);
	assert.equal(isInkSidebar(undefined, true), false);
});

test('getSidebarToneStyle: paper changes nothing', () => {
	assert.deepEqual(getSidebarToneStyle(false), {});
});

test('getSidebarToneStyle: ink re-points the surface tokens at the ink tokens', () => {
	const style = getSidebarToneStyle(true) as Record<string, string>;
	assert.equal(style['--rr-bg-paper'], 'var(--rr-sidebar-ink-bg)');
	assert.equal(style['--rr-text-primary'], 'var(--rr-sidebar-ink-fg)');
	assert.equal(style['--rr-bg-list-active'], 'var(--rr-sidebar-ink-active-bg)');
	assert.equal(style['--rr-palette-mode'], 'dark');
	assert.equal(style.colorScheme, 'dark');
});

test('getSidebarToneStyle: never points a token at itself', () => {
	const style = getSidebarToneStyle(true) as Record<string, string>;
	for (const [token, value] of Object.entries(style)) {
		assert.ok(!value.includes(`var(${token})`), `${token} refers to itself`);
	}
});
