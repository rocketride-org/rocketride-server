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
// SETTINGS › PIPELINE — which .pipe is deployed, and how restarts behave
// =============================================================================
//
// TTL is shown read-only on purpose: a support bot that idles out is a support
// bot that stops answering, so the app always starts with `ttl: 0` and says so
// rather than offering a number that must not be changed.
// =============================================================================

import React from 'react';
import { LabelValue, Section } from 'shell';
import type { PipeChoice, PipelineSettings } from '../../state/types';
import { PIPE_DESCRIPTIONS, PIPE_LABELS, pipeIdentity, PIPELINES } from '../../pipeline/resolve';

import { BooleanField, ReadOnlyField, SelectField } from './fields';

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link PipelinePage}. */
export interface PipelinePageProps {
	/** The draft being edited. */
	value: PipelineSettings;
	/** Merge a patch into the draft. */
	onChange: (patch: Partial<PipelineSettings>) => void;
	/** Read-only mode (sample data on, or a save in flight). */
	disabled: boolean;
	/** The bot task's token, or null when nothing is running. */
	token: string | null;
	/** The eval-capture task's token, or null when it is not running. */
	captureToken: string | null;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** The pipe choices, in the order they should read. */
const PIPE_OPTIONS: { value: PipeChoice; label: string }[] = (['min', 'rag', 'ralph', 'ralphSlack'] as PipeChoice[]).map((choice) => ({ value: choice, label: PIPE_LABELS[choice] }));

/** Leading characters of a task token kept when it is shown. */
const TOKEN_HEAD = 6;

/** Trailing characters of a task token kept when it is shown. */
const TOKEN_TAIL = 4;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * A task token, shortened.
 *
 * The token is a credential — anyone holding it can terminate or restart the
 * bot — so the screen shows just enough of it to tell two tasks apart, never
 * enough to use. This page exists to confirm the app is attached to the task it
 * should be, and the ends do that.
 *
 * @param token - The live token, or null when nothing is running.
 * @returns The display string.
 */
function shortToken(token: string | null): string {
	if (token === null) return 'not running';
	if (token.length <= TOKEN_HEAD + TOKEN_TAIL) return `${token.slice(0, 1)}… (attached)`;
	return `${token.slice(0, TOKEN_HEAD)}…${token.slice(-TOKEN_TAIL)}`;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Settings › Pipeline.
 *
 * @param props - See {@link PipelinePageProps}.
 * @returns The form.
 */
export const PipelinePage: React.FC<PipelinePageProps> = ({ value, onChange, disabled, token, captureToken }) => {
	const identity = pipeIdentity(PIPELINES[value.pipe]);

	return (
		<div className="dd-form">
			<SelectField<PipeChoice> label="Answer pipeline" help={PIPE_DESCRIPTIONS[value.pipe]} value={value.pipe} options={PIPE_OPTIONS} disabled={disabled} onChange={(pipe) => onChange({ pipe })} />

			<BooleanField label="Also run the eval-capture branch" help="Starts the shadow capture pipe as a second task. It posts nothing to Discord and records questions, reactions and no-reply outcomes into its own store for the eval loop." value={value.captureEnabled} disabled={disabled} onChange={(captureEnabled) => onChange({ captureEnabled })} />

			<BooleanField label="Offer a restart after saving" help="Settings only take effect on the next start. With this on, saving offers a restart there and then. Nothing ever restarts silently." value={value.restartAfterSave} disabled={disabled} onChange={(restartAfterSave) => onChange({ restartAfterSave })} />

			<ReadOnlyField label="Time to live" help="The app always starts the bot with ttl 0, so the engine never idles it out. A support bot that times out is a support bot that has quietly stopped answering.">
				Runs until stopped
			</ReadOnlyField>

			<Section label="Task identity">
				<LabelValue label="Project id" mono>
					{identity.projectId}
				</LabelValue>
				<LabelValue label="Source component" mono>
					{identity.source}
				</LabelValue>
				<LabelValue label="Current task token" mono>
					{shortToken(token)}
				</LabelValue>
				<LabelValue label="Capture task token" mono>
					{value.captureEnabled ? shortToken(captureToken) : 'capture branch off'}
				</LabelValue>
			</Section>
			<p className="dd-help dd-form__note">Task tokens are shown shortened on purpose: the full token can terminate or restart the bot, and the ends are enough to tell one task from another.</p>
			<p className="dd-help dd-form__note">The app attaches to one shared task rather than starting one per viewer: every start passes useExisting, and the token is resolved from the server by project and source, so a second viewer sees the same bot.</p>
		</div>
	);
};
