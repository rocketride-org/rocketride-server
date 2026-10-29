// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Stepper — progress through a multi-step flow: onboarding, connect a data
 * source, deploy an app. Each step is complete, current, upcoming or in
 * error; the current step carries `aria-current="step"` and every step
 * announces its state ("Step 2 of 4, complete").
 *
 * Pass `onStepClick` to let users jump back to completed steps (upcoming
 * steps stay locked unless `isNonLinear`). Horizontal by default; vertical
 * for side panels, with optional per-step descriptions. When a horizontal
 * stepper runs out of room, the labels of non-current steps truncate (the
 * current step never does; screen readers still get every full label), so
 * prefer `vertical` in narrow containers.
 *
 * Built on `.rr-stepper` from components.css.
 */

import React, { ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** One step. */
export interface IStep {
	/** Stable id. */
	id: string;
	/** Step name. */
	label: ReactNode;
	/** Secondary line (vertical steppers show it under the label). */
	description?: ReactNode;
	/** Mark the step as failed. */
	error?: boolean;
	/** Show an "Optional" hint. */
	optional?: boolean;
}

/** A step's state. */
export type StepState = 'complete' | 'current' | 'upcoming' | 'error';

/** Props for the {@link Stepper} component. */
export interface IStepperProps {
	/** Steps, in order. */
	steps: IStep[];
	/** Index of the current step (0-based). `steps.length` = all complete. */
	activeStep: number;
	/** Lay out top-to-bottom. */
	vertical?: boolean;
	/** Make steps clickable; fired with the step index. */
	onStepClick?: (index: number) => void;
	/** Allow clicking upcoming steps too. */
	isNonLinear?: boolean;
	/** Accessible name. Defaults to `'Progress'`. */
	ariaLabel?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * A step's state from its position and error flag.
 *
 * @param index - The step's index.
 * @param activeStep - The current step index.
 * @param hasError - Whether the step is marked failed.
 * @returns The state.
 */
export function getStepState(index: number, activeStep: number, hasError = false): StepState {
	if (hasError) return 'error';
	if (index < activeStep) return 'complete';
	if (index === activeStep) return 'current';
	return 'upcoming';
}

/** The words screen readers hear for a state. */
const STATE_TEXT: Record<StepState, string> = {
	complete: 'complete',
	current: 'current',
	upcoming: 'not started',
	error: 'error',
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a step indicator.
 *
 * @param props - {@link IStepperProps}.
 * @returns The stepper element.
 */
export function Stepper({ steps, activeStep, vertical = false, onStepClick, isNonLinear = false, ariaLabel = 'Progress' }: IStepperProps): React.ReactElement {
	let rootClassName = 'rr-stepper';
	if (vertical) rootClassName += ' rr-stepper--vertical';

	return (
		<ol className={rootClassName} aria-label={ariaLabel}>
			{steps.map((step, index) => {
				const state = getStepState(index, activeStep, step.error);
				const isClickable = Boolean(onStepClick) && index !== activeStep && (state === 'complete' || isNonLinear);

				let marker: ReactNode = index + 1;
				if (state === 'complete') marker = '✓';
				if (state === 'error') marker = '!';

				let ariaCurrent: 'step' | undefined;
				if (state === 'current') ariaCurrent = 'step';

				const body = (
					<>
						<span className="rr-stepper__marker" aria-hidden="true">
							{marker}
						</span>
						<span className="rr-stepper__text">
							<span className="rr-stepper__label">{step.label}</span>
							{step.optional && <span className="rr-stepper__hint">Optional</span>}
							{vertical && step.description && <span className="rr-stepper__description">{step.description}</span>}
						</span>
						<span className="rr-sr-only">{`, step ${index + 1} of ${steps.length}, ${STATE_TEXT[state]}`}</span>
					</>
				);

				return (
					<li key={step.id} className="rr-stepper__step" data-state={state} aria-current={ariaCurrent}>
						{isClickable && (
							<button type="button" className="rr-stepper__button" onClick={() => onStepClick?.(index)}>
								{body}
							</button>
						)}
						{!isClickable && <span className="rr-stepper__button">{body}</span>}
					</li>
				);
			})}
		</ol>
	);
}
