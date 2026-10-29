// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Breadcrumbs. */

import React from 'react';
import { Breadcrumbs } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a deep trail that collapses its middle. */
const BreadcrumbsDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => <Breadcrumbs maxItems={Number(knobs.maxItems)} items={['RocketRide', 'Support', 'rag-pipeline', 'Runs', 'Run 42'].map((label) => ({ id: label, label, onClick: () => undefined }))} />;

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	return `import { Breadcrumbs } from 'shell';

<Breadcrumbs
	maxItems={${Number(knobs.maxItems)}}
	items={[
		{ id: 'org', label: 'RocketRide', onClick: () => go('/') },
		{ id: 'pipeline', label: 'rag-pipeline', href: '/pipelines/rag' },
		{ id: 'run', label: 'Run 42' },
	]}
/>`;
}

/** The Breadcrumbs gallery entry. */
export const breadcrumbsEntry: IGalleryEntry = {
	id: 'breadcrumbs',
	name: 'Breadcrumbs',
	group: 'content',
	blurb: "Where the view sits in a hierarchy. The last crumb is the current page; long trails collapse their middle into an expandable '…'.",
	knobs: [{ id: 'maxItems', label: 'Max items', kind: 'number', defaultValue: 4 }],
	demo: BreadcrumbsDemo,
	code: buildCode,
	props: [
		{ name: 'items', type: '{ id; label; href?; onClick?; icon? }[]', dir: 'in', required: true, note: 'Root first; the last is the current page.' },
		{ name: 'maxItems', type: 'number', dir: 'in', note: 'Collapse the middle beyond this. Default 4.' },
		{ name: 'ariaLabel', type: 'string', dir: 'in', note: "Nav landmark name. Default 'Breadcrumb'." },
	],
};
