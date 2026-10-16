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
// SETTINGS › EVAL — who counts as the team, what is a test, and the tunables
// =============================================================================
//
// Not one of these is a `discord.*` parameter, which is why this is a page of
// its own rather than more fields on Behavior: they do not change what the bot
// DOES, they change how the app labels what the bot already did. Nothing here
// restarts anything.
//
// The values are the reference support bot's `eval/config.ts` environment
// variables, brought into the form so the loop can be tuned without an .env
// file. Each field says which one it was.
// =============================================================================

import React from 'react';
import type { EvalSettings } from '../../state/types';

import { BooleanField, IdListField, NumberField } from './fields';

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link EvalPage}. */
export interface EvalPageProps {
	/** The draft being edited. */
	value: EvalSettings;
	/** Merge a patch into the draft. */
	onChange: (patch: Partial<EvalSettings>) => void;
	/** Read-only mode (sample data on, or a save in flight). */
	disabled: boolean;
	/** The bots Settings › Discord lets through, for the test-bot fallback line. */
	allowedBotIds: string[];
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Settings › Eval.
 *
 * @param props - See {@link EvalPageProps}.
 * @returns The form.
 */
export const EvalPage: React.FC<EvalPageProps> = ({ value, onChange, disabled, allowedBotIds }) => (
	<div className="dd-form">
		<IdListField label="Team User Ids" help="Team members who do not carry the escalation role, comma-separated ids. A reply from anyone on the role or in this list counts as the team answering, which is what tells an escalation that was picked up from one that was not. Was EVAL_TEAM_USER_IDS." placeholder="000000000000000001, 000000000000000002" value={value.teamUserIds} disabled={disabled} onChange={(teamUserIds) => onChange({ teamUserIds })} />

		<IdListField label="Test Bot Ids" help={`Bots whose questions are test traffic and are left out of the score. Leave empty to use the bots Settings › Discord already lets through${allowedBotIds.length > 0 ? ` (currently ${allowedBotIds.length})` : ' (currently none)'}. Was TEST_ALLOW_BOT_IDS.`} placeholder="leave empty to reuse Allowed Bot Ids" value={value.testBotIds} disabled={disabled} onChange={(testBotIds) => onChange({ testBotIds })} />

		<NumberField label="Quiet Hours" help="How long a thread has to be quiet before it is graded. Grading it sooner would score an answer somebody was still reading. Default 48. Was EVAL_QUIET_HOURS." value={value.quietHours} disabled={disabled} onChange={(quietHours) => onChange({ quietHours })} />

		<NumberField label="Window (days)" help="The trailing window the headline resolved rate is computed over. Default 28. Was EVAL_WINDOW_DAYS." value={value.windowDays} disabled={disabled} onChange={(windowDays) => onChange({ windowDays })} />

		<NumberField label="Target" help="The resolved rate the score is read against, as a fraction of 1. Default 0.6 — the aspirational 0.9 is not this number. Was EVAL_TARGET." value={value.target} disabled={disabled} onChange={(target) => onChange({ target })} />

		<NumberField label="Match Distance" help="Chroma distance; lower is closer. At or below this the knowledge base counts as already holding an answer; above it, a failure is a documentation gap rather than a retrieval miss. A real docs question tops out around 0.78 and nonsense sits around 0.91, so the default is 0.8. Was EVAL_MATCH_SCORE, which read the number the other way round." value={value.matchDistance} disabled={disabled} onChange={(matchDistance) => onChange({ matchDistance })} />

		<NumberField label="Re-ask Days" help="Window in which the same question asked again counts as a re-ask — the earlier answer did not land — rather than as new traffic. Default 14. Was EVAL_REASK_DAYS." value={value.reaskDays} disabled={disabled} onChange={(reaskDays) => onChange({ reaskDays })} />

		<BooleanField label="Grade Now Ignores Quiet Hours" help="Testing only: grade rows immediately instead of waiting the quiet period. Off by default, because a thread graded minutes after the answer landed scores a conversation somebody was still reading." value={value.gradeNowIgnoresQuiet} disabled={disabled} onChange={(gradeNowIgnoresQuiet) => onChange({ gradeNowIgnoresQuiet })} />

		<p className="dd-help dd-form__note">Capture is always on: every question the app sees is recorded with its thread's events, and these settings decide how those events are read. Nothing here restarts the bot, and nothing here is sent to Discord.</p>
	</div>
);
