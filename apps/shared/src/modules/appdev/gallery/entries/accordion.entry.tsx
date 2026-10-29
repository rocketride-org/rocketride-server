// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Accordion. */

import React from 'react';
import { Accordion, Field, InputField, Switch } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: settings groups. */
const AccordionDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<div style={{ maxWidth: 420 }}>
		<Accordion
			multiple={Boolean(knobs.multiple)}
			flush={Boolean(knobs.flush)}
			defaultExpanded={['general']}
			items={[
				{
					id: 'general',
					title: 'General',
					content: (
						<Field label="Pipeline name">
							<InputField defaultValue="support-bot" />
						</Field>
					),
				},
				{ id: 'runtime', title: 'Runtime', meta: '3 settings', content: <Switch label="Stream tokens" checked onChange={() => undefined} /> },
				{ id: 'billing', title: 'Billing', content: 'Usage is billed to the organization.', disabled: true },
			]}
		/>
	</div>
);

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let attrs = '';
	if (knobs.multiple) attrs += ' multiple';
	if (knobs.flush) attrs += ' flush';
	return `import { Accordion } from 'shell';

<Accordion${attrs}
	defaultExpanded={['general']}
	items={[
		{ id: 'general', title: 'General', content: <GeneralSettings /> },
		{ id: 'runtime', title: 'Runtime', meta: '3 settings', content: <RuntimeSettings /> },
	]}
/>`;
}

/** The Accordion gallery entry. */
export const accordionEntry: IGalleryEntry = {
	id: 'accordion',
	name: 'Accordion',
	group: 'content',
	blurb: 'Stacked expandable sections - settings groups, advanced options, run details. A one-item Accordion is a disclosure.',
	doc: 'WAI-ARIA accordion: headers are headings holding buttons with aria-expanded; panels are labelled regions. Arrow Up/Down and Home/End move between headers. Single-expand by default; collapsed panels stay mounted so form state survives.',
	knobs: [
		{ id: 'multiple', label: 'Multiple', kind: 'boolean', defaultValue: false },
		{ id: 'flush', label: 'Flush', kind: 'boolean', defaultValue: false },
	],
	demo: AccordionDemo,
	code: buildCode,
	props: [
		{ name: 'items', type: '{ id; title; meta?; content; disabled? }[]', dir: 'in', required: true, note: 'Sections in order.' },
		{ name: 'expanded / defaultExpanded', type: 'string[]', dir: 'in', note: 'Open ids, controlled / uncontrolled.' },
		{ name: 'multiple', type: 'boolean', dir: 'in', note: 'Allow several open at once.' },
		{ name: 'headingLevel', type: '2 | 3 | 4 | 5 | 6', dir: 'in', note: 'Header heading level. Default 3.' },
		{ name: 'flush', type: 'boolean', dir: 'in', note: 'No outer border (nested in a card).' },
		{ name: 'onChange', type: '(expanded: string[]) => void', dir: 'out', note: 'Fired with the new open ids.' },
	],
};
