// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// GET-STARTED CHECKLIST — UX spec F1
// =============================================================================
//
// Five steps, resumable in any order, each one deep-linking to where the work
// happens. Four of the five are DERIVED, not ticked by hand: the app can see
// whether the variable exists, whether the ids are filled in, and whether a
// task is running, so the card cannot claim a step is done when it is not. The
// card disappears at 5/5 and the state is persisted so it stays gone.
// =============================================================================

import React from 'react';
import type { ChecklistStepId } from '../state/types';
import { Btn, CheckList, DdCard, Meter } from '../ui/dd';

// =============================================================================
// TYPES
// =============================================================================

/** One rendered checklist step. */
export interface ChecklistStep {
	/** Which of the five steps this is. */
	id: ChecklistStepId;
	/** What the user has to do. */
	label: string;
	/** Why, or exactly which value is needed. */
	detail: string;
	/** Whether the app can see that it is done. */
	done: boolean;
	/** Label of the control that takes the user there. */
	actionLabel: string;
	/** Where the control goes. */
	onAction: () => void;
}

/** Props for {@link Checklist}. */
export interface ChecklistProps {
	/** The five steps, in spec order. */
	steps: ChecklistStep[];
	/** Sample-data mode: the deep links stay, the actions do not act. */
	readOnly: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Get-started card: a progress meter, then the steps.
 *
 * @param props - See {@link ChecklistProps}.
 * @returns The card, or null once every step is done.
 */
export const Checklist: React.FC<ChecklistProps> = ({ steps, readOnly }) => {
	const doneCount = steps.filter((step) => step.done).length;
	if (doneCount === steps.length) return null;

	return (
		<DdCard
			title="Get started"
			actions={
				<span className="dd-caption dd-num">
					{doneCount} of {steps.length} done
				</span>
			}
		>
			<div className="dd-stack">
				<Meter value={doneCount / steps.length} tone="ok" label={`${doneCount} of ${steps.length} steps done`} />
				<CheckList
					items={steps.map((step) => ({
						key: step.id,
						state: step.done ? 'done' : 'todo',
						// A done step keeps its detail as a tooltip, so the card stays
						// compact; an open step shows it, because it says what to do.
						title: step.done ? <span title={step.detail}>{step.label}</span> : step.label,
						body: step.done ? undefined : step.detail,
						action: (
							<Btn small variant={step.done ? 'ghost' : 'secondary'} onClick={step.onAction} disabled={readOnly} title={readOnly ? 'Turn off Sample data to use this' : step.actionLabel}>
								{step.actionLabel}
							</Btn>
						),
					}))}
				/>
			</div>
		</DdCard>
	);
};
