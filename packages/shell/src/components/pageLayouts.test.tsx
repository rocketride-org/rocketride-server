// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Phase 4 page layouts: the pure sidebar rules, the status presets, and the
 * server-rendered structure and ARIA wiring of each component.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_COLLAPSE_BELOW, getSidebarMode, openStateForMode, setSideOpen } from './page-layout/pageLayoutState';
import { PageLayout, PageSidebarToggle } from './page-layout/PageLayout';
import { SettingsSection } from './settings/SettingsSection';
import { ThemeSwitcher } from './settings/ThemeSwitcher';
import { getStatusPreset, StatusPage } from './status-page/StatusPage';

/** Counts occurrences of a substring. */
function count(html: string, needle: string): number {
	return html.split(needle).length - 1;
}

test('getSidebarMode: unmeasured and wide are columns, narrow is a drawer', () => {
	assert.equal(getSidebarMode(0, DEFAULT_COLLAPSE_BELOW), 'column');
	assert.equal(getSidebarMode(1200, 900), 'column');
	assert.equal(getSidebarMode(900, 900), 'column');
	assert.equal(getSidebarMode(899, 900), 'drawer');
});

test('openStateForMode: drawers start closed, columns restore defaults', () => {
	assert.deepEqual(openStateForMode('drawer', { left: true, right: true }), { left: false, right: false });
	assert.deepEqual(openStateForMode('column', { left: true, right: false }), { left: true, right: false });
});

test('setSideOpen: opening a drawer closes the other; columns are independent', () => {
	assert.deepEqual(setSideOpen({ left: true, right: false }, 'right', true, 'drawer'), { left: false, right: true });
	assert.deepEqual(setSideOpen({ left: true, right: false }, 'right', true, 'column'), { left: true, right: true });
	assert.deepEqual(setSideOpen({ left: true, right: true }, 'left', false, 'drawer'), { left: false, right: true });
});

test('getStatusPreset gives every kind a title and description', () => {
	for (const kind of ['not-found', 'forbidden', 'error', 'maintenance', 'offline'] as const) {
		const preset = getStatusPreset(kind);
		assert.ok(preset.title.length > 0 && preset.description.length > 0, kind);
	}
	assert.equal(getStatusPreset('not-found').code, '404');
	assert.equal(getStatusPreset('maintenance').code, '');
});

test('PageLayout: built-in header, sidebars with toggles, closed right sidebar hidden', () => {
	const html = renderToStaticMarkup(
		<PageLayout
			title="Runs"
			subtitle="Last 30 days"
			breadcrumbs={[
				{ id: 'p', label: 'rag-pipeline' },
				{ id: 'r', label: 'Runs' },
			]}
			leftSidebar={{ label: 'Filters', content: 'F' }}
			rightSidebar={{ label: 'Details', content: 'D' }}
		>
			body
		</PageLayout>
	);
	assert.ok(html.includes('<h1 class="rr-page-layout__title">Runs</h1>'));
	assert.ok(html.includes('aria-label="Breadcrumb"'));
	assert.equal(count(html, 'role="complementary"'), 2, 'wide page: sidebars are labelled complementary columns');
	assert.ok(/<div[^>]*aria-label="Filters"(?![^>]*hidden)[^>]*>/.test(html), 'left column open by default');
	assert.ok(/<div[^>]*aria-label="Details"[^>]*hidden=""/.test(html), 'right column closed by default');
	assert.ok(/class="rr-page-layout__content" tabindex="0" role="region" aria-label="Runs content"/.test(html), 'scrolling content is a focusable, labelled region');
	assert.ok(html.includes('aria-label="Hide Filters"') && html.includes('aria-label="Show Details"'));
	assert.ok(html.includes('aria-expanded="true"') && html.includes('aria-expanded="false"'));
	assert.ok(!html.includes('role="dialog"'), 'wide page: columns, not drawers');
});

test('PageLayout: custom header replaces the built-in one; toggle outside a layout is inert', () => {
	const html = renderToStaticMarkup(
		<PageLayout header={<div id="custom">Custom</div>} variant="carded" contentWidth="narrow" toolbar={<span>tb</span>}>
			body
		</PageLayout>
	);
	assert.ok(html.includes('id="custom"') && !html.includes('rr-page-layout__title'));
	assert.ok(html.includes('rr-page-layout--carded') && html.includes('rr-page-layout--narrow') && html.includes('rr-page-layout__toolbar'));
	assert.equal(renderToStaticMarkup(<PageSidebarToggle side="left" />), '');
});

test('SettingsSection is a region labelled by its heading', () => {
	const html = renderToStaticMarkup(
		<SettingsSection title="API keys" description="Keys for the SDK." footer={<button>Save</button>} danger>
			controls
		</SettingsSection>
	);
	const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
	assert.ok(labelledBy && html.includes(`<h2 id="${labelledBy}"`));
	assert.ok(html.includes('rr-settings-section--danger') && html.includes('rr-settings-section__footer'));
});

test('ThemeSwitcher: nothing without a source; a named Select with explicit props', () => {
	assert.equal(renderToStaticMarkup(<ThemeSwitcher />), '');
	const html = renderToStaticMarkup(
		<ThemeSwitcher
			options={[
				{ id: 'light', name: 'Light' },
				{ id: 'dark', name: 'Dark' },
			]}
			value="dark"
			onChange={() => undefined}
		/>
	);
	assert.ok(html.includes('role="combobox"') && html.includes('aria-label="Theme"') && html.includes('Dark'));
	const radios = renderToStaticMarkup(<ThemeSwitcher variant="radio" options={[{ id: 'light', name: 'Light' }]} value="light" onChange={() => undefined} />);
	assert.ok(radios.includes('role="radiogroup"'));
});

test('StatusPage: presets, overrides, alert role for errors, collapsed details', () => {
	const notFound = renderToStaticMarkup(<StatusPage kind="not-found" />);
	assert.ok(notFound.includes('404') && notFound.includes('Page not found') && !notFound.includes('role="alert"'));
	const error = renderToStaticMarkup(<StatusPage kind="error" title="Run failed" code="" details="trace-id: abc123" />);
	assert.ok(error.includes('role="alert"') && error.includes('Run failed') && !error.includes('rr-status-page__code'));
	assert.ok(error.includes('<details class="rr-status-page__details"><summary>Details</summary>'));
});
