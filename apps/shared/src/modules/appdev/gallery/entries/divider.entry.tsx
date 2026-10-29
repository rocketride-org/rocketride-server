// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Divider. */

import React from 'react';
import { Divider } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: plain, labelled and vertical dividers. */
const DividerDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<div style={{ maxWidth: 360 }}>
		<div className="rr-text-body">Sign in with SSO</div>
		<Divider label={String(knobs.label) || undefined} />
		<div className="rr-text-body">Use an API key</div>
		<Divider />
		<div style={{ display: 'flex', alignItems: 'center', height: 24 }}>
			<span className="rr-text-body">Edit</span>
			<Divider vertical />
			<span className="rr-text-body">Share</span>
		</div>
	</div>
);

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	return `import { Divider } from 'shell';

<Divider label="${String(knobs.label)}" />
<Divider vertical />`;
}

/** The Divider gallery entry. */
export const dividerEntry: IGalleryEntry = {
	id: 'divider',
	name: 'Divider',
	group: 'content',
	blurb: 'Hairline between groups of content - horizontal, vertical, or with a short centered label.',
	knobs: [{ id: 'label', label: 'Label', kind: 'text', defaultValue: 'or' }],
	demo: DividerDemo,
	code: buildCode,
	props: [
		{ name: 'vertical', type: 'boolean', dir: 'in', note: 'Vertical rule between inline items.' },
		{ name: 'label', type: 'ReactNode', dir: 'in', note: 'Short centered label (horizontal only).' },
		{ name: 'decorative', type: 'boolean', dir: 'in', note: 'Hide from screen readers.' },
	],
};
