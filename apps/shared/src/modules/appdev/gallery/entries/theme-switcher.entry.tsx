// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for ThemeSwitcher. */

import React, { useState } from 'react';
import { Field, ThemeSwitcher } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Demo themes, driven locally so the demo does not repaint the whole app. */
const DEMO_THEMES = [
	{ id: 'rocketride', name: 'RocketRide' },
	{ id: 'rocketride-light', name: 'RocketRide Light' },
	{ id: 'dark', name: 'Dark' },
	{ id: 'light', name: 'Light' },
];

/** Live demo: the switcher in explicit-props mode. */
const ThemeSwitcherDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [theme, setTheme] = useState('rocketride');
	return (
		<div style={{ maxWidth: 280 }}>
			<Field label="Theme" help={`Selected: ${theme}`}>
				<ThemeSwitcher variant={knobs.variant as 'select' | 'radio'} options={DEMO_THEMES} value={theme} onChange={setTheme} />
			</Field>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	return `import { Field, ThemeSwitcher } from 'shell';

// Inside the shell: no props needed - it uses the workspace theme list.
<Field label="Theme">
	<ThemeSwitcher variant="${String(knobs.variant)}" />
</Field>`;
}

/** The ThemeSwitcher gallery entry. */
export const themeSwitcherEntry: IGalleryEntry = {
	id: 'theme-switcher',
	name: 'ThemeSwitcher',
	group: 'layouts',
	blurb: "Theme picker for settings pages. Inside the shell it needs no props: it reads the workspace's theme list and switches with setTheme, like the sidebar footer picker.",
	docNote: 'This demo passes options/value/onChange explicitly so it does not repaint the App Builder. Outside the shell, pass them yourself; with no theme source it renders nothing.',
	knobs: [{ id: 'variant', label: 'Variant', kind: 'select', options: ['select', 'radio'], defaultValue: 'select' }],
	demo: ThemeSwitcherDemo,
	code: buildCode,
	props: [
		{ name: 'variant', type: "'select' | 'radio'", dir: 'in', note: 'Default select.' },
		{ name: 'options', type: '{ id; name }[]', dir: 'in', note: "Themes to offer. Default: the shell's list." },
		{ name: 'value', type: 'string', dir: 'in', note: "Current theme id. Default: the shell's." },
		{ name: 'ariaLabel', type: 'string', dir: 'in', note: "Name outside a Field. Default 'Theme'." },
		{ name: 'onChange', type: '(themeId: string) => void', dir: 'out', note: "Default: the shell's setTheme." },
	],
};
