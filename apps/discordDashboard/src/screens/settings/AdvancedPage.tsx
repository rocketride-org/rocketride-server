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
// SETTINGS › ADVANCED — ingestion limits, event emission, sample data
// =============================================================================
//
// The emit toggles are what feeds the Conversations screen: with Emit Outbound
// and Emit No Reply off, questions still appear but never reach an outcome,
// which each field says out loud rather than leaving the screen mysteriously
// half-populated.
//
// Sample data lives here (not in a dev-only corner) because it is the
// demo / read-only mode of the whole app: every screen switches to labelled
// made-up rows and every action disables itself with a reason.
// =============================================================================

import React from 'react';

import type { AdvancedSettings } from '../../state/types';
import { DdBanner } from '../../ui/dd';
import { BooleanField, IdListField, NumberField } from './fields';

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link AdvancedPage}. */
export interface AdvancedPageProps {
	/** The draft being edited. */
	value: AdvancedSettings;
	/** Merge a patch into the draft. */
	onChange: (patch: Partial<AdvancedSettings>) => void;
	/**
	 * Read-only mode. Note that Sample data itself stays live even here — it is
	 * the switch OUT of read-only mode, so disabling it would be a trap.
	 */
	disabled: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Settings › Advanced.
 *
 * @param props - See {@link AdvancedPageProps}.
 * @returns The form.
 */
export const AdvancedPage: React.FC<AdvancedPageProps> = ({ value, onChange, disabled }) => (
	<div className="dd-form">
		<NumberField label="Backfill Limit" help="Most recent messages to replay per readable channel when the bot starts. Zero disables backfill, which is the node default and what you want unless you are testing. At most 100. Writes discord.backfillLimit." max={100} value={value.backfillLimit} disabled={disabled} onChange={(backfillLimit) => onChange({ backfillLimit })} />

		<NumberField label="Max Attachment Size (bytes)" help="Attachments larger than this are skipped rather than downloaded. Node default 26214400 (25 MB). Writes discord.maxAttachmentBytes." value={value.maxAttachmentBytes} disabled={disabled} onChange={(maxAttachmentBytes) => onChange({ maxAttachmentBytes })} />

		<IdListField label="Text Attachment Extensions" help="Extensions decoded as UTF-8 and folded into the question text instead of travelling as binary. Writes discord.textAttachmentExtensions." placeholder=".pipe, .json, .md" value={value.textAttachmentExtensions} disabled={disabled} onChange={(textAttachmentExtensions) => onChange({ textAttachmentExtensions })} />

		<NumberField label="Text Attachment Max Characters" help="Longest decoded text folded in per attachment. Node default 12000. Writes discord.textAttachmentMaxChars." value={value.textAttachmentMaxChars} disabled={disabled} onChange={(textAttachmentMaxChars) => onChange({ textAttachmentMaxChars })} />

		<BooleanField label="Emit Outbound Events" help="Required for the Answered and Escalated outcomes: without it, Conversations shows the question but never what the bot said. Writes discord.emitOutbound." value={value.emitOutbound} disabled={disabled} onChange={(emitOutbound) => onChange({ emitOutbound })} />

		<BooleanField label="Emit No Reply Events" help="Required for the No reply and Error outcomes, and for the Needs you list. Writes discord.emitNoReply." value={value.emitNoReply} disabled={disabled} onChange={(emitNoReply) => onChange({ emitNoReply })} />

		<BooleanField label="Emit Reactions" help="Capture the emoji users add to the bot's answers. Needs the Message Reactions intent in the Discord portal. Writes discord.emitReactions." value={value.emitReactions} disabled={disabled} onChange={(emitReactions) => onChange({ emitReactions })} />

		<BooleanField label="Include Member Metadata" help="Adds display names and role ids to every event, which is what puts real names in Conversations and lets an escalation clear when a team member replies. Needs the Server Members intent. Writes discord.includeMemberMetadata." value={value.includeMemberMetadata} disabled={disabled} onChange={(includeMemberMetadata) => onChange({ includeMemberMetadata })} />

		<BooleanField label="Capture To Database" help="Write every question, reply and reaction into the dashboard database from the bot itself, so nothing is missed while the dashboard is closed." value={value.captureToDatabase} disabled={disabled} onChange={(captureToDatabase) => onChange({ captureToDatabase })} />

		<div>
			<BooleanField label="Sample data" help="Render labelled, made-up rows on every screen and disable every bot action. Nothing is sent to the engine or to Discord while this is on." value={value.sampleData} onChange={(sampleData) => onChange({ sampleData })} />
			{value.sampleData && (
				<div className="dd-form__note">
					<DdBanner variant="warning">Sample data is on. Save is still available so you can turn it back off, but the bot actions stay disabled and every row you see is invented.</DdBanner>
				</div>
			)}
		</div>

		<p className="dd-help dd-form__note">Reactions users add are captured; the bot cannot post reactions of its own in v1 — the node has no outbound reaction action.</p>
	</div>
);
