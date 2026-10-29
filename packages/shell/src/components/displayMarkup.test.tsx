// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Markup-level checks for the phase 3 components: server-rendered (no DOM)
 * and inspected for the roles and ARIA state assistive tech relies on.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Avatar, AvatarGroup } from './avatar/Avatar';
import { Badge } from './badge/Badge';
import { ProgressBar, Spinner } from './progress/Progress';
import { Skeleton } from './skeleton/Skeleton';
import { Divider } from './divider/Divider';
import { Accordion } from './accordion/Accordion';
import { List } from './list/List';
import { Table } from './table/Table';
import { Tree } from './tree/Tree';
import { Breadcrumbs } from './breadcrumbs/Breadcrumbs';
import { Pagination } from './pagination/Pagination';
import { Stepper } from './stepper/Stepper';

const noop = (): void => undefined;

/** Counts occurrences of a substring. */
function count(html: string, needle: string): number {
	return html.split(needle).length - 1;
}

test('Avatar is a named image with initials; decorative hides it', () => {
	const html = renderToStaticMarkup(<Avatar name="Avery Chen" />);
	assert.ok(html.includes('role="img"') && html.includes('aria-label="Avery Chen"') && html.includes('>AC<'));
	assert.ok(html.includes('--rr-avatar-tone:var(--rr-chart-'));
	const decorative = renderToStaticMarkup(<Avatar name="Avery Chen" decorative />);
	assert.ok(decorative.includes('aria-hidden="true"') && !decorative.includes('role="img"'));
});

test('AvatarGroup shows max avatars plus a +N chip and names the group', () => {
	const people = ['Ann', 'Ben', 'Cal', 'Dee', 'Eve', 'Fay'].map((name) => ({ name }));
	const html = renderToStaticMarkup(<AvatarGroup avatars={people} max={3} />);
	assert.ok(html.includes('role="group"') && html.includes('aria-label="Ann, Ben, Cal, Dee, Eve, Fay"'));
	assert.ok(html.includes('+3'));
	assert.equal(count(html, 'rr-avatar--toned'), 3);
});

test('Badge hides at zero, caps counts, and speaks its label', () => {
	assert.ok(!renderToStaticMarkup(<Badge count={0}>x</Badge>).includes('rr-count'));
	assert.ok(
		renderToStaticMarkup(
			<Badge count={0} showZero>
				x
			</Badge>
		).includes('rr-count')
	);
	const html = renderToStaticMarkup(
		<Badge count={150} label="unread messages">
			x
		</Badge>
	);
	assert.ok(html.includes('99+') && html.includes('150 unread messages'));
});

test('ProgressBar exposes value range; indeterminate omits it', () => {
	const html = renderToStaticMarkup(<ProgressBar value={3} max={4} label="Uploading" showLabel />);
	assert.ok(html.includes('role="progressbar"') && html.includes('aria-valuenow="3"') && html.includes('aria-valuemax="4"') && html.includes('aria-valuetext="75%"'));
	assert.ok(html.includes('width:75%'));
	const indeterminate = renderToStaticMarkup(<ProgressBar label="Indexing" />);
	assert.ok(!indeterminate.includes('aria-valuenow') && indeterminate.includes('rr-progress--indeterminate'));
	assert.ok(renderToStaticMarkup(<Spinner />).includes('aria-label="Loading"'));
});

test('Skeleton is hidden from assistive tech; Divider is a separator', () => {
	assert.ok(renderToStaticMarkup(<Skeleton lines={3} />).includes('aria-hidden="true"'));
	assert.equal(count(renderToStaticMarkup(<Skeleton lines={3} />), 'class="rr-skeleton"'), 3);
	assert.ok(renderToStaticMarkup(<Divider vertical />).includes('aria-orientation="vertical"'));
	assert.ok(renderToStaticMarkup(<Divider label="or" />).includes('role="separator"'));
});

test('Accordion wires headers to regions and hides closed panels', () => {
	const html = renderToStaticMarkup(
		<Accordion
			defaultExpanded={['b']}
			items={[
				{ id: 'a', title: 'General', content: 'A' },
				{ id: 'b', title: 'Advanced', content: 'B' },
			]}
		/>
	);
	assert.equal(count(html, 'aria-expanded="false"'), 1);
	assert.equal(count(html, 'aria-expanded="true"'), 1);
	assert.equal(count(html, 'role="region"'), 2);
	assert.equal(count(html, 'hidden=""'), 1);
	assert.ok(html.includes('<h3 class="rr-accordion__heading">'));
});

test('List: static is a plain list; selectable is a listbox with one tab stop', () => {
	const items = [
		{ id: 'a', primary: 'Alpha' },
		{ id: 'b', primary: 'Beta', disabled: true },
		{ id: 'c', primary: 'Gamma' },
	];
	assert.ok(!renderToStaticMarkup(<List items={items} />).includes('role="listbox"'));
	const html = renderToStaticMarkup(<List items={items} onSelect={noop} selectedId="c" ariaLabel="Projects" />);
	assert.ok(html.includes('role="listbox"') && html.includes('aria-label="Projects"'));
	assert.equal(count(html, 'tabindex="0"'), 1);
	const tabStopRow = html.slice(html.lastIndexOf('<li', html.indexOf('tabindex="0"')), html.indexOf('</li>', html.indexOf('tabindex="0"')));
	assert.ok(tabStopRow.includes('aria-selected="true"') && tabStopRow.includes('Gamma'), 'the tab stop is the selected row');
	assert.ok(html.includes('aria-disabled="true"'));
});

test('Table marks the sorted column and sorts rows', () => {
	const rows = [
		{ id: '1', name: 'Embed', cost: 4 },
		{ id: '2', name: 'Chat', cost: 12 },
		{ id: '3', name: 'Ingest', cost: 1 },
	];
	const html = renderToStaticMarkup(
		<Table
			caption="Costs"
			rows={rows}
			getRowId={(row) => row.id}
			defaultSort={{ columnId: 'cost', direction: 'desc' }}
			columns={[
				{ id: 'name', header: 'Stage', value: (row) => row.name, sortable: true },
				{ id: 'cost', header: 'Cost', value: (row) => row.cost, sortable: true, align: 'right' },
			]}
		/>
	);
	assert.ok(html.includes('aria-sort="descending"') && html.includes('aria-sort="none"'));
	assert.ok(html.indexOf('Chat') < html.indexOf('Embed') && html.indexOf('Embed') < html.indexOf('Ingest'));
	assert.ok(html.includes('<caption class="rr-sr-only">Costs</caption>'));
});

test('Tree renders treeitems with level, set position and expansion', () => {
	const html = renderToStaticMarkup(
		<Tree
			ariaLabel="Components"
			defaultExpanded={['src']}
			selectedId="s3"
			nodes={[
				{ id: 'src', label: 'Sources', children: [{ id: 's3', label: 'S3' }] },
				{ id: 'out', label: 'Output' },
			]}
		/>
	);
	assert.ok(html.includes('role="tree"') && html.includes('aria-label="Components"'));
	assert.equal(count(html, 'role="treeitem"'), 3);
	assert.ok(html.includes('aria-level="2"') && html.includes('aria-expanded="true"'));
	assert.equal(count(html, 'aria-expanded'), 1, 'leaves carry no aria-expanded');
	assert.equal(count(html, 'tabindex="0"'), 1, 'single tab stop (the selected node)');
});

test('Breadcrumbs: nav landmark, current page, collapsed middle', () => {
	const crumbs = ['Org', 'Team', 'Project', 'Pipeline', 'Run 42'].map((label) => ({ id: label, label, onClick: noop }));
	const html = renderToStaticMarkup(<Breadcrumbs items={crumbs} maxItems={4} />);
	assert.ok(html.includes('<nav class="rr-breadcrumbs" aria-label="Breadcrumb">'));
	assert.ok(html.includes('aria-current="page"') && html.includes('Run 42'));
	assert.ok(html.includes('aria-label="Show 2 more"') && !html.includes('>Team<'));
});

test('Pagination marks the current page and disables the edge step', () => {
	const html = renderToStaticMarkup(<Pagination page={1} pageCount={10} onChange={noop} totalItems={200} pageSize={20} />);
	assert.ok(html.includes('aria-label="Pagination"') && html.includes('1–20 of 200'));
	assert.ok(/aria-current="page" aria-label="Page 1"/.test(html));
	assert.ok(/aria-label="Previous page" disabled=""/.test(html));
});

test('Stepper announces position and state, current step marked', () => {
	const html = renderToStaticMarkup(
		<Stepper
			activeStep={1}
			steps={[
				{ id: 'a', label: 'Connect' },
				{ id: 'b', label: 'Configure' },
				{ id: 'c', label: 'Deploy' },
			]}
		/>
	);
	assert.ok(html.includes('aria-current="step"'));
	assert.ok(html.includes(', step 1 of 3, complete') && html.includes(', step 3 of 3, not started'));
});
