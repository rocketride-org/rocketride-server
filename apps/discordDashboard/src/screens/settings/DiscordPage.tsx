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
// SETTINGS › DISCORD — which server, which channels, which role
// =============================================================================
//
// The token is NOT here as a value and never will be: this page shows the NAME
// of the server variable that holds it, read from the app's own
// `contributes.configuration` setting, with a door to the shell's variables
// overlay. The secret itself is resolved server-side at pipeline start
// (`resolve_pipeline_env`), so it never travels through the browser.
// =============================================================================

import React from 'react';
import { LabelValue, Section } from 'shell';
import { BOT_TOKEN_SETTING, GITHUB_TOKEN_SETTING, OPENAI_KEY_SETTING, QDRANT_HOST_SETTING } from '../../state/types';
import type { DiscordSettings } from '../../state/types';
import { DdBanner, Btn } from '../../ui/dd';
import { IdListField, ReadOnlyField, TextField } from './fields';

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link DiscordPage}. */
export interface DiscordPageProps {
	/** The draft being edited. */
	value: DiscordSettings;
	/** Merge a patch into the draft. */
	onChange: (patch: Partial<DiscordSettings>) => void;
	/** Read-only mode (sample data on, or a save in flight). */
	disabled: boolean;
	/** The variable name the botToken setting currently holds. */
	tokenVariable: string;
	/** The variable name the openaiKey setting currently holds. */
	openaiVariable: string;
	/** The variable name the githubToken setting holds (RAG pipe only). */
	githubVariable: string;
	/** The variable name the qdrantHost setting holds (capture pipe only). */
	qdrantVariable: string;
	/**
	 * Names saved on the server, or null when the list is UNKNOWN — unreachable
	 * account surface, or sample mode. Null is not "none".
	 */
	serverVariables: string[] | null;
	/** Whether the draft has Include Member Metadata on (intent note). */
	memberMetadataOn: boolean;
	/** Open the shell's server-variables overlay. */
	onOpenVariables: () => void;
	/** Open the shell's app-settings overlay, where the names are chosen. */
	onOpenAppSettings: () => void;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * How the "Saved on server" line reads for one variable name.
 *
 * Three states, not two: a variable the server confirms, a variable the server
 * says it does not have, and a list that could not be read at all. Reporting
 * the third as the second tells the user to go fix something that is not broken.
 *
 * @param name - The configured variable name, possibly empty.
 * @param saved - Names the server holds, or null when unknown.
 * @param consequence - What breaks while the variable is absent.
 * @returns The line to render.
 */
function savedLine(name: string, saved: string[] | null, consequence: string): string {
	if (name.length === 0) return 'No variable name set for this setting yet';
	if (saved === null) return 'Unknown — the server variable list has not been read';
	return saved.includes(name) ? 'Yes' : `No — ${consequence}`;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Settings › Discord.
 *
 * @param props - See {@link DiscordPageProps}.
 * @returns The form.
 */
export const DiscordPage: React.FC<DiscordPageProps> = ({ value, onChange, disabled, tokenVariable, openaiVariable, githubVariable, qdrantVariable, serverVariables, memberMetadataOn, onOpenVariables, onOpenAppSettings }) => (
	<div className="dd-form">
		<Section label="Secrets">
			<LabelValue label="Bot token variable" mono>
				{tokenVariable || 'not set'}
			</LabelValue>
			<LabelValue label="Saved on server">{savedLine(tokenVariable, serverVariables, 'the bot cannot log in until it is')}</LabelValue>
			<LabelValue label="OpenAI key variable" mono>
				{openaiVariable || 'not set'}
			</LabelValue>
			<LabelValue label="GitHub token variable" mono>
				{githubVariable || 'not set'}
			</LabelValue>
			<LabelValue label="GitHub token saved">{savedLine(githubVariable, serverVariables, 'the RAG pipeline cannot start')}</LabelValue>
			<LabelValue label="Qdrant host variable" mono>
				{qdrantVariable || 'not set'}
			</LabelValue>
			<LabelValue label="Qdrant host saved">{savedLine(qdrantVariable, serverVariables, 'the eval-capture branch cannot start')}</LabelValue>
		</Section>
		<p className="dd-help dd-form__note">The GitHub token is needed only by the RAG pipeline and the Qdrant host only by the eval-capture branch, so neither blocks the minimal pipeline. The app checks each one before starting the pipe that uses it.</p>
		<p className="dd-help dd-form__note">This app stores the NAME of each variable, never its value. Change a name in the shell&rsquo;s app settings; save or rotate the value itself in the variables overlay.</p>
		<div className="dd-row dd-form__note">
			<Btn small onClick={onOpenVariables}>
				Open variables
			</Btn>
			<Btn small variant="ghost" onClick={onOpenAppSettings}>
				Choose variable names
			</Btn>
		</div>

		<TextField label="Server ID (Guild ID)" help="The one Discord server the bot listens to. Writes discord.guildIds." placeholder="e.g. 1024567890123456789" value={value.guildId} disabled={disabled} onChange={(guildId) => onChange({ guildId })} />

		<IdListField label="Channel IDs" help="Support channels the bot answers in; thread parents match too. Empty means every channel the bot can read. Writes discord.channelIds." placeholder="paste ids, comma or space separated" value={value.supportChannelIds} disabled={disabled} onChange={(supportChannelIds) => onChange({ supportChannelIds })} />

		<IdListField label="Require Mention Channel IDs" help="Guest channels where the bot answers only when it is @mentioned directly. Writes discord.requireMentionChannelIds." placeholder="paste ids, comma or space separated" value={value.mentionChannelIds} disabled={disabled} onChange={(mentionChannelIds) => onChange({ mentionChannelIds })} />

		<TextField label="Team role ID (escalations)" help="The one role the bot may ping when it cannot answer. Writes discord.allowedMentionRoleIds, and replaces the role mention in the minimal pipe's prompt. @everyone and @here can never be enabled." placeholder="e.g. 1024567890123456790" value={value.teamRoleId} disabled={disabled} onChange={(teamRoleId) => onChange({ teamRoleId })} />

		{/* The intent this app's defaults depend on. Member metadata is ON by
		    default because the escalation-clearing rule and the Asker column both
		    read it, and it is the one setting that needs a privileged intent the
		    Discord portal does not grant automatically. */}
		{memberMetadataOn ? (
			<DdBanner variant="info">
				Include Member Metadata is on, so the bot needs the privileged <strong>Server Members Intent</strong> enabled in the Discord developer portal (Privileged Gateway Intents). It adds display names and member/mentioned role IDs to every event — which is what puts real names in Conversations and clears an escalation when a team-role member replies. Turn it off in Settings &rsaquo; Advanced if you cannot enable the intent.
			</DdBanner>
		) : (
			<DdBanner variant="warning">Include Member Metadata is off, so events carry no display names or role ids: Conversations shows user ids, and an escalated row only leaves &ldquo;Needs you&rdquo; when you dismiss it by hand. Turning it back on in Settings &rsaquo; Advanced needs the privileged Server Members Intent in the Discord developer portal.</DdBanner>
		)}

		<IdListField label="Allowed Bot IDs" help="Bot user ids let through while Ignore Bot Messages is on — test drivers, normally empty. Writes discord.allowedBotIds." placeholder="paste ids, comma or space separated" value={value.allowedBotIds} disabled={disabled} onChange={(allowedBotIds) => onChange({ allowedBotIds })} />

		<ReadOnlyField label="Settings keys" help="The shell setting keys this page reads. They are declared in the app manifest; the last two are optional.">
			{BOT_TOKEN_SETTING} · {OPENAI_KEY_SETTING} · {GITHUB_TOKEN_SETTING} · {QDRANT_HOST_SETTING}
		</ReadOnlyField>
	</div>
);
