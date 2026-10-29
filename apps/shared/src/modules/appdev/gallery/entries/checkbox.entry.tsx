// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Checkbox and Switch. */

import React, { useState } from 'react';
import { Checkbox, Switch } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a select-all checkbox with two rows, and a switch. */
const CheckboxDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [rows, setRows] = useState({ ingest: true, embed: false });
	const [isLive, setIsLive] = useState(true);
	const disabled = Boolean(knobs.disabled);
	const checkedCount = Number(rows.ingest) + Number(rows.embed);

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
			<Checkbox label="All stages" checked={checkedCount === 2} indeterminate={checkedCount === 1} disabled={disabled} onChange={(checked) => setRows({ ingest: checked, embed: checked })} />
			<div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 24 }}>
				<Checkbox label="Ingest" checked={rows.ingest} disabled={disabled} onChange={(checked) => setRows({ ...rows, ingest: checked })} />
				<Checkbox label="Embed" description="Runs after ingest finishes" checked={rows.embed} disabled={disabled} onChange={(checked) => setRows({ ...rows, embed: checked })} />
			</div>
			<Switch label="Run on save" checked={isLive} disabled={disabled} onChange={setIsLive} />
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let disabledAttr = '';
	if (knobs.disabled) disabledAttr = ' disabled';
	return `import { Checkbox, Switch } from 'shell';

<Checkbox label="Embed" description="Runs after ingest finishes" checked={embed} onChange={setEmbed}${disabledAttr} />
<Switch label="Run on save" checked={runOnSave} onChange={setRunOnSave}${disabledAttr} />`;
}

/** The Checkbox / Switch gallery entry. */
export const checkboxEntry: IGalleryEntry = {
	id: 'checkbox',
	name: 'Checkbox / Switch',
	group: 'content',
	blurb: 'Native checkbox and on/off switch with a clickable label and optional description. Checkbox supports the mixed (indeterminate) state.',
	doc: 'Use a Checkbox when the choice applies on submit or is one of a set; use a Switch when the setting takes effect immediately.',
	knobs: [{ id: 'disabled', label: 'Disabled', kind: 'boolean', defaultValue: false }],
	demo: CheckboxDemo,
	code: buildCode,
	props: [
		{ name: 'checked', type: 'boolean', dir: 'in', required: true, note: 'Whether it is on.' },
		{ name: 'label', type: 'ReactNode', dir: 'in', note: 'Visible label. Omit only with ariaLabel.' },
		{ name: 'description', type: 'ReactNode', dir: 'in', note: 'Secondary line, linked with aria-describedby.' },
		{ name: 'indeterminate', type: 'boolean', dir: 'in', note: 'Checkbox only - mixed state for select-all.' },
		{ name: 'disabled', type: 'boolean', dir: 'in', note: 'Disable the control.' },
		{ name: 'ariaLabel', type: 'string', dir: 'in', note: 'Accessible name when there is no visible label.' },
		{ name: 'name / value / id', type: 'string', dir: 'in', note: 'Native form attributes.' },
		{ name: 'onChange', type: '(checked: boolean, event) => void', dir: 'out', required: true, note: 'Fired with the new state.' },
	],
};
