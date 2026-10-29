// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for SettingsSection. */

import React, { useState } from 'react';
import { Button, Field, InputField, SettingsSection, Switch } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: two settings groups and a danger zone. */
const SettingsSectionDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [isStreaming, setIsStreaming] = useState(true);
	return (
		<div style={{ width: Number(knobs.width), maxWidth: '100%' }}>
			<SettingsSection title="General" description="How this pipeline appears in the Console." footer={<Button small>Save</Button>}>
				<Field label="Name">
					<InputField defaultValue="rag-pipeline" />
				</Field>
			</SettingsSection>
			<SettingsSection title="Runtime" description="Applies to new runs.">
				<Switch label="Stream tokens" description="Send output as it is generated." checked={isStreaming} onChange={setIsStreaming} />
			</SettingsSection>
			<SettingsSection title="Danger zone" description="Deleting removes the pipeline and its run history." danger>
				<div>
					<Button variant="danger" small>
						Delete pipeline
					</Button>
				</div>
			</SettingsSection>
		</div>
	);
};

/** Snippet builder. */
function buildCode(_knobs: KnobValues): string {
	return `import { Field, InputField, PageLayout, SettingsSection } from 'shell';

<PageLayout title="Settings" contentWidth="narrow">
	<SettingsSection title="General" description="How this pipeline appears in the Console." footer={<Button small onClick={save}>Save</Button>}>
		<Field label="Name"><InputField value={name} onChange={(e) => setName(e.target.value)} /></Field>
	</SettingsSection>
	<SettingsSection title="Danger zone" description="Deleting removes the pipeline." danger>
		<Button variant="danger" small onClick={confirmDelete}>Delete pipeline</Button>
	</SettingsSection>
</PageLayout>`;
}

/** The SettingsSection gallery entry. */
export const settingsSectionEntry: IGalleryEntry = {
	id: 'settings-section',
	name: 'SettingsSection',
	group: 'layouts',
	blurb: 'One group on a settings page: title and description on the left, controls on the right, footer actions below. Stacks into one column when the section is narrow.',
	doc: 'Stack sections inside a `PageLayout contentWidth="narrow"`. The column switch is a CSS container query on the section, so it behaves the same in a page, a side panel or a webview. Each section is a region labelled by its heading. `danger` marks destructive settings.',
	knobs: [{ id: 'width', label: 'Width', kind: 'number', defaultValue: 720 }],
	demo: SettingsSectionDemo,
	code: buildCode,
	props: [
		{ name: 'title', type: 'ReactNode', dir: 'in', required: true, note: 'Section heading.' },
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'The controls.' },
		{ name: 'description', type: 'ReactNode', dir: 'in', note: 'What the settings do.' },
		{ name: 'footer', type: 'ReactNode', dir: 'in', note: 'Right-aligned actions (Save, Reset).' },
		{ name: 'danger', type: 'boolean', dir: 'in', note: 'Destructive settings: red title and border.' },
		{ name: 'headingLevel / id', type: '2 | 3 | 4 / string', dir: 'in', note: 'Heading level (default 2); id for deep links.' },
	],
};
