// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Stepper. */

import React, { useState } from 'react';
import { Button, Stepper } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** The demo's steps: deploying an app. */
const STEPS = [
	{ id: 'connect', label: 'Connect source', description: 'Google Drive' },
	{ id: 'configure', label: 'Configure', description: 'Chunking and embeddings' },
	{ id: 'test', label: 'Test', description: 'Run against 10 samples', optional: true },
	{ id: 'deploy', label: 'Deploy', description: 'Publish to Cloud' },
];

/** Live demo: a deploy flow with back/next. */
const StepperDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [active, setActive] = useState(1);
	const steps = STEPS.map((step, index) => ({ ...step, error: Boolean(knobs.error) && index === active }));
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 640 }}>
			<Stepper steps={steps} activeStep={active} vertical={Boolean(knobs.vertical)} onStepClick={setActive} />
			<div style={{ display: 'flex', gap: 8 }}>
				<Button variant="ghost" small disabled={active === 0} onClick={() => setActive(active - 1)}>
					Back
				</Button>
				<Button small disabled={active === STEPS.length} onClick={() => setActive(active + 1)}>
					Next
				</Button>
			</div>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let verticalAttr = '';
	if (knobs.vertical) verticalAttr = ' vertical';
	return `import { Stepper } from 'shell';

<Stepper
	steps={[{ id: 'connect', label: 'Connect source' }, { id: 'configure', label: 'Configure' }, { id: 'deploy', label: 'Deploy' }]}
	activeStep={step}
	onStepClick={setStep}${verticalAttr}
/>`;
}

/** The Stepper gallery entry. */
export const stepperEntry: IGalleryEntry = {
	id: 'stepper',
	name: 'Stepper',
	group: 'content',
	blurb: 'Progress through a multi-step flow - onboarding, connect a source, deploy. Complete steps are clickable to go back; the current step is aria-current="step".',
	knobs: [
		{ id: 'vertical', label: 'Vertical', kind: 'boolean', defaultValue: false },
		{ id: 'error', label: 'Current step failed', kind: 'boolean', defaultValue: false },
	],
	demo: StepperDemo,
	code: buildCode,
	props: [
		{ name: 'steps', type: '{ id; label; description?; error?; optional? }[]', dir: 'in', required: true, note: 'Steps in order.' },
		{ name: 'activeStep', type: 'number', dir: 'in', required: true, note: 'Current index; steps.length = all complete.' },
		{ name: 'vertical', type: 'boolean', dir: 'in', note: 'Top-to-bottom with descriptions.' },
		{ name: 'isNonLinear', type: 'boolean', dir: 'in', note: 'Allow clicking upcoming steps too.' },
		{ name: 'ariaLabel', type: 'string', dir: 'in', note: "Default 'Progress'." },
		{ name: 'onStepClick', type: '(index: number) => void', dir: 'out', note: 'Makes completed steps clickable.' },
	],
};
