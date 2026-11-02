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
	/**
	 * Mark the step done out of order: it shows complete even after the
	 * current step (a later step done first, in a checklist the person may
	 * take in any order). The current step still shows as current.
	 */
	complete?: boolean;
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
	/**
	 * Pulse a soft accent shadow round the current step's marker, to say
	 * "start here". Holds still under `prefers-reduced-motion`.
	 */
	pulseCurrent?: boolean;
	/**
	 * Shown at the right of the current step's row: the button that does the
	 * step ("Start", "Continue").
	 */
	currentAction?: ReactNode;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * A step's state from its position and its error and done flags.
 *
 * @param index - The step's index.
 * @param activeStep - The current step index.
 * @param hasError - Whether the step is marked failed.
 * @param isDone - Whether the step is marked done out of order.
 * @returns The state.
 */
export function getStepState(index: number, activeStep: number, hasError = false, isDone = false): StepState {
	if (hasError) return 'error';
	if (index < activeStep) return 'complete';
	if (index === activeStep) return 'current';
	if (isDone) return 'complete';
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
export function Stepper({ steps, activeStep, vertical = false, onStepClick, isNonLinear = false, ariaLabel = 'Progress', pulseCurrent = false, currentAction }: IStepperProps): React.ReactElement {
	let rootClassName = 'rr-stepper';
	if (vertical) rootClassName += ' rr-stepper--vertical';
	if (pulseCurrent) rootClassName += ' rr-stepper--pulse';

	return (
		<ol className={rootClassName} aria-label={ariaLabel}>
			{steps.map((step, index) => {
				const state = getStepState(index, activeStep, step.error, step.complete);
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

				const button = isClickable ? (
					<button type="button" className="rr-stepper__button" onClick={() => onStepClick?.(index)}>
						{body}
					</button>
				) : (
					<span className="rr-stepper__button">{body}</span>
				);

				return (
					<li key={step.id} className="rr-stepper__step" data-state={state} aria-current={ariaCurrent}>
						{state === 'current' && currentAction ? (
							<div className="rr-stepper__row">
								{button}
								<span className="rr-stepper__action">{currentAction}</span>
							</div>
						) : (
							button
						)}
					</li>
				);
			})}
		</ol>
	);
}
