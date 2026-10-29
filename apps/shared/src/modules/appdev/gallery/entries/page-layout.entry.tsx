// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for PageLayout, PageSidebarToggle and usePageLayout. */

import React from 'react';
import { Button, Checkbox, InputField, List, PageLayout, usePageLayout } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Sidebar content: a few filters. */
function FilterPanel(): React.ReactElement {
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
			<span className="rr-text-label">Status</span>
			<Checkbox label="Failed" checked onChange={() => undefined} />
			<Checkbox label="Running" checked={false} onChange={() => undefined} />
		</div>
	);
}

/** Right sidebar content reading the layout context to close itself. */
function DetailPanel(): React.ReactElement {
	const layout = usePageLayout();
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
			<span className="rr-text-label">Run 42</span>
			<span className="rr-text-body">Started 4 minutes ago by the scheduler.</span>
			<Button variant="ghost" small onClick={() => layout?.right.close()}>
				Close details
			</Button>
		</div>
	);
}

/** The demo's rows. */
const RUNS = ['Run 42', 'Run 41', 'Run 40', 'Run 39', 'Run 38'].map((name, index) => ({ id: name, primary: name, secondary: `${index + 2} minutes ago` }));

/** Live demo: a runs page in a resizable box. */
const PageLayoutDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	let leftSidebar;
	if (knobs.left) leftSidebar = { label: 'Filters', content: <FilterPanel />, width: 200 };
	let rightSidebar;
	if (knobs.right) rightSidebar = { label: 'Details', content: <DetailPanel />, width: 220, defaultOpen: true };

	return (
		<div style={{ width: Number(knobs.width), maxWidth: '100%', height: 420, border: '1px solid var(--rr-border)', borderRadius: 8, overflow: 'hidden' }}>
			<PageLayout
				title="Runs"
				subtitle="rag-pipeline, last 30 days"
				breadcrumbs={[
					{ id: 'p', label: 'rag-pipeline', onClick: () => undefined },
					{ id: 'r', label: 'Runs' },
				]}
				actions={<Button small>New run</Button>}
				toolbar={<InputField placeholder="Search runs" style={{ maxWidth: 240, height: 26 }} />}
				variant={knobs.variant as 'simple' | 'carded'}
				leftSidebar={leftSidebar}
				rightSidebar={rightSidebar}
				collapseBelow={640}
			>
				<List items={RUNS} dividers ariaLabel="Runs" />
			</PageLayout>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let sidebars = '';
	if (knobs.left) sidebars += "\n\tleftSidebar={{ label: 'Filters', content: <Filters /> }}";
	if (knobs.right) sidebars += "\n\trightSidebar={{ label: 'Details', content: <RunDetails /> }}";
	return `import { Button, PageLayout } from 'shell';

<PageLayout
	title="Runs"
	subtitle="rag-pipeline, last 30 days"
	breadcrumbs={[{ id: 'p', label: 'rag-pipeline', onClick: openPipeline }, { id: 'r', label: 'Runs' }]}
	actions={<Button small>New run</Button>}
	toolbar={<RunFilters />}
	variant="${String(knobs.variant)}"${sidebars}
>
	<RunList />
</PageLayout>`;
}

/** The PageLayout gallery entry. */
export const pageLayoutEntry: IGalleryEntry = {
	id: 'page-layout',
	name: 'PageLayout',
	group: 'layouts',
	blurb: 'The scaffold for an app view: header (title, breadcrumbs, actions), toolbar, content, and left/right sidebars that turn into drawers when the page is narrow.',
	doc: 'Variants: `simple` and `carded` (toolbar and content in a raised card under a tinted header band). Sidebars are columns while the PAGE is wider than `collapseBelow` (default 900px) and focus-trapped drawers below it - the page measures its own box, never the window, so it cannot fight the shell sidebar breakpoint. Drawers start closed, close on Escape or the scrim, and return focus. The built-in header renders a toggle per sidebar; with a custom `header`, place `<PageSidebarToggle side="left" />` yourself or use `usePageLayout()`. `scroll="content"` (default) scrolls content and sidebars separately; `scroll="page"` scrolls everything under a sticky header. `contentWidth="narrow"` caps content at a readable 880px.',
	knobs: [
		{ id: 'variant', label: 'Variant', kind: 'select', options: ['simple', 'carded'], defaultValue: 'simple' },
		{ id: 'left', label: 'Left sidebar', kind: 'boolean', defaultValue: true },
		{ id: 'right', label: 'Right sidebar', kind: 'boolean', defaultValue: false },
		{ id: 'width', label: 'Page width', kind: 'number', defaultValue: 820 },
	],
	demo: PageLayoutDemo,
	code: buildCode,
	props: [
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'Page content.' },
		{ name: 'title / subtitle / actions / breadcrumbs', type: '...', dir: 'in', note: 'The built-in header.' },
		{ name: 'headingLevel', type: '1 | 2 | 3', dir: 'in', note: 'Title heading level. Default 1.' },
		{ name: 'header', type: 'ReactNode', dir: 'in', note: 'Replace the built-in header.' },
		{ name: 'toolbar', type: 'ReactNode', dir: 'in', note: 'Row under the header (filters, search, tabs).' },
		{ name: 'leftSidebar / rightSidebar', type: 'IPageSidebar', dir: 'in', note: '{ content, label, width?, defaultOpen?, open?, onOpenChange?, showToggle? }.' },
		{ name: 'variant', type: "'simple' | 'carded'", dir: 'in', note: 'Look. Default simple.' },
		{ name: 'contentWidth', type: "'full' | 'narrow'", dir: 'in', note: 'Narrow caps content at 880px.' },
		{ name: 'scroll', type: "'content' | 'page'", dir: 'in', note: 'What scrolls. Default content.' },
		{ name: 'collapseBelow', type: 'number', dir: 'in', note: 'Page width where sidebars become drawers. Default 900.' },
	],
	sections: [
		{
			label: 'Hooks and helpers',
			rows: [
				{ name: 'usePageLayout()', type: 'IPageLayoutContext | null', dir: 'out', note: "{ mode: 'column' | 'drawer', left, right } - each side has isOpen, open, close, toggle, id, label." },
				{ name: '<PageSidebarToggle side />', type: 'ReactElement', dir: 'in', note: 'IconButton with aria-expanded / aria-controls for one sidebar.' },
			],
		},
	],
};
