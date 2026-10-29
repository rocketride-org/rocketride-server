// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for StatusPage. */

import React from 'react';
import { Button, StatusPage } from 'shell';
import type { StatusPageKind } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: one status in a page-sized box. */
const StatusPageDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const kind = knobs.kind as StatusPageKind;
	let details: string | undefined;
	if (knobs.details) details = 'request-id: 7f3a9c21\nGET /api/pipelines/rag-pipeline -> 500';
	return (
		<div style={{ height: 380, border: '1px solid var(--rr-border)', borderRadius: 8, overflow: 'auto' }}>
			<StatusPage
				kind={kind}
				headingLevel={2}
				details={details}
				actions={
					<>
						<Button small>Try again</Button>
						<Button variant="ghost" small>
							Go to home
						</Button>
					</>
				}
			/>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let detailsAttr = '';
	if (knobs.details) detailsAttr = '\n\tdetails={error.requestId}';
	return `import { Button, StatusPage } from 'shell';

<StatusPage
	kind="${String(knobs.kind)}"
	actions={<Button onClick={retry}>Try again</Button>}${detailsAttr}
/>`;
}

/** The StatusPage gallery entry. */
export const statusPageEntry: IGalleryEntry = {
	id: 'status-page',
	name: 'StatusPage',
	group: 'layouts',
	blurb: 'A whole view replaced by a status: not found, no access, error, maintenance, offline. Preset copy per kind, actions, and collapsed technical details.',
	doc: 'Use EmptyState for an empty list or panel inside a page; StatusPage is for when the page itself cannot be shown. Errors and offline are announced (role="alert").',
	knobs: [
		{ id: 'kind', label: 'Kind', kind: 'select', options: ['not-found', 'forbidden', 'error', 'maintenance', 'offline'], defaultValue: 'not-found' },
		{ id: 'details', label: 'Details', kind: 'boolean', defaultValue: false },
	],
	demo: StatusPageDemo,
	code: buildCode,
	props: [
		{ name: 'kind', type: "'not-found' | 'forbidden' | 'error' | 'maintenance' | 'offline'", dir: 'in', required: true, note: 'Picks the preset code, title and description.' },
		{ name: 'title / description', type: 'ReactNode', dir: 'in', note: 'Override the preset copy.' },
		{ name: 'code', type: 'string', dir: 'in', note: "Override the big code; '' hides it." },
		{ name: 'actions', type: 'ReactNode', dir: 'in', note: 'Recovery actions.' },
		{ name: 'details', type: 'ReactNode', dir: 'in', note: 'Technical details in a collapsed disclosure.' },
		{ name: 'headingLevel', type: '1 | 2', dir: 'in', note: 'Default 1.' },
	],
};
