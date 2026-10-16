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
// SETTINGS — five sub-pages over one draft
// =============================================================================
//
// One draft for every sub-page, one Save. Switching sub-pages keeps the edits,
// because an id typed on Discord and a toggle flipped on Advanced are one
// change to the bot as far as the user is concerned.
//
// Saving writes the draft to the workspace slice and then OFFERS a restart
// (UX spec F3) — nothing restarts silently, because a restart drops the bot off
// the Gateway for a moment and that is the user's call, not the form's.
//
// A save is CONFIRMED BY THE DATABASE. Each touched sub-page is one
// `dd_settings` row written under optimistic concurrency: the row carries a
// version, the UPDATE names the version the form read, and zero rows back
// means somebody else saved first. The form then says so, reloads, and keeps
// the edits on screen — the state matrix's "save failure toast with reason,
// form keeps edits" cell, now reachable for the reason it was written for.
//
// A save writes ONLY the sub-pages the user actually edited. The draft is
// seeded when typing starts, so its untouched sub-pages are a snapshot that
// may already be stale — writing them back would revert another admin's save,
// which is now a real admin on another machine rather than a second tab.
// `touched` is what makes that correct: it is the set of groups `patch` has
// been called for.
// =============================================================================

import React, { useState } from 'react';
import { DEFAULT_SETTINGS, SETTINGS_SLICES } from '../state/types';
import type { BotSettings, SettingsSlice, SettingsTabId } from '../state/types';
import { SampleBanner, Skeleton } from '../ui/parts';
import { Btn, DdBanner, DdCard, PageHeader } from '../ui/dd';
import { Icon, type IconName } from '../ui/Icon';
import { useToast } from '../ui/toast';
import { AdvancedPage } from './settings/AdvancedPage';
import { BehaviorPage } from './settings/BehaviorPage';
import { DiscordPage } from './settings/DiscordPage';
import { EvalPage } from './settings/EvalPage';
import { PipelinePage } from './settings/PipelinePage';
import type { ScreenProps } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The sub-nav, in the order the UX spec fixes. */
const TABS: { id: SettingsTabId; label: string; blurb: string }[] = [
	{ id: 'discord', label: 'Discord', blurb: 'Which server, which channels, which role.' },
	{ id: 'behavior', label: 'Behavior', blurb: 'How the bot answers.' },
	{ id: 'pipeline', label: 'Pipeline', blurb: 'Which pipeline runs, and how restarts behave.' },
	{ id: 'advanced', label: 'Advanced', blurb: 'Ingestion limits, event capture, sample data.' },
	{ id: 'eval', label: 'Eval', blurb: 'Who counts as the team, what is a test, and the scoring tunables.' },
];

// =============================================================================
// TYPES
// =============================================================================

/** The sub-nav's glyphs. */
const TAB_ICON: Record<SettingsTabId, IconName> = {
	discord: 'message',
	behavior: 'sliders',
	pipeline: 'cpu',
	advanced: 'database',
	eval: 'gauge',
};

/** Props for {@link SettingsScreen}. */
export interface SettingsScreenProps extends ScreenProps {
	/** Which sub-page is showing. */
	tab: SettingsTabId;
	/** Switch sub-page. */
	onTabChange: (tab: SettingsTabId) => void;
	/** The variable name the openaiKey setting holds. */
	openaiVariable: string;
	/** The variable name the githubToken setting holds (RAG pipe only). */
	githubVariable: string;
	/** The variable name the qdrantHost setting holds (capture pipe only). */
	qdrantVariable: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Settings screen.
 *
 * @param props - See {@link SettingsScreenProps}.
 * @returns The screen.
 */
export const SettingsScreen: React.FC<SettingsScreenProps> = ({ data, actions, loaded, bot, sampleMode, writesBlocked, openOverlay, serverVariables, tokenVariable, tab, onTabChange, openaiVariable, githubVariable, qdrantVariable }) => {
	const toast = useToast();
	// The draft. Seeded from the saved settings; a null draft means "no edits".
	const [draft, setDraft] = useState<BotSettings | null>(null);
	// The sub-pages the draft has edits on: what a save writes.
	const [touched, setTouched] = useState<SettingsSlice[]>([]);
	const [saving, setSaving] = useState(false);
	// A save failure keeps the edits on screen and says why (state matrix).
	const [saveError, setSaveError] = useState<string | null>(null);
	// The restart offer, raised by a successful save.
	const [offerRestart, setOfferRestart] = useState(false);

	const current = draft ?? data.settings;
	const dirty = draft !== null;

	/** Merge a patch into one sub-page's group of the draft. */
	function patch<K extends SettingsSlice>(group: K, value: Partial<BotSettings[K]>): void {
		setDraft((prev) => {
			const base = prev ?? data.settings;
			return { ...base, [group]: { ...base[group], ...value } };
		});
		setTouched((prev) => (prev.includes(group) ? prev : [...prev, group]));
	}

	// --- Save -----------------------------------------------------------------

	/**
	 * Write the touched sub-pages, one row each.
	 *
	 * Sequential rather than in parallel: the gateway serialises statements
	 * anyway, and a conflict on the first slice is a reason to stop and show
	 * the reloaded values rather than to go on overwriting the next four with
	 * a draft the user is about to be told is stale.
	 */
	async function save(): Promise<void> {
		if (draft === null) return;
		const slices = touched.length > 0 ? touched : SETTINGS_SLICES;
		if (writesBlocked !== null) {
			setSaveError(writesBlocked);
			toast.error(`Could not save the settings: ${writesBlocked.toLowerCase()}.`);
			return;
		}
		setSaving(true);
		setSaveError(null);
		try {
			for (const slice of slices) {
				const conflict = await actions.saveSettings(slice, draft[slice]);
				if (conflict !== null) {
					// Somebody else's save is the newer truth and has been loaded.
					// The edits stay on screen so nothing the user typed is lost.
					setSaveError(conflict);
					toast.error(conflict);
					return;
				}
			}
			setDraft(null);
			setTouched([]);
			toast.success('Settings saved.');
			// The offer is only meaningful when something is actually running and
			// the user asked for it.
			if (draft.pipeline.restartAfterSave && bot.token !== null && !draft.advanced.sampleData) {
				setOfferRestart(true);
			}
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			setSaveError(reason);
			toast.error(`Could not save the settings: ${reason}`);
		} finally {
			setSaving(false);
		}
	}

	/** Restart the bot from the post-save offer. */
	async function restartNow(): Promise<void> {
		setOfferRestart(false);
		const failure = await bot.restart();
		if (failure === null) toast.success('Bot restarted with the new settings.');
		else toast.error(`Could not restart the bot: ${failure}`);
	}

	/** Throw the edits away and go back to what is saved. */
	function discard(): void {
		setDraft(null);
		setTouched([]);
		setSaving(false);
		setSaveError(null);
	}

	/** Put every field back to the node's own defaults, as an edit. */
	function resetToDefaults(): void {
		setDraft({
			discord: { ...DEFAULT_SETTINGS.discord },
			behavior: { ...DEFAULT_SETTINGS.behavior },
			pipeline: { ...DEFAULT_SETTINGS.pipeline },
			advanced: { ...DEFAULT_SETTINGS.advanced, sampleData: current.advanced.sampleData },
			eval: { ...DEFAULT_SETTINGS.eval },
		});
		// A reset is an edit to every sub-page, and means every one.
		setTouched(SETTINGS_SLICES);
	}

	// --- LOADING --------------------------------------------------------------

	if (!loaded) {
		return (
			<div className="dd-page">
				<PageHeader title="Settings" subtitle="Shared by every admin. Changes apply on the next bot start." />
				<DdCard>
					<Skeleton rows={6} label="Loading the settings" />
				</DdCard>
			</div>
		);
	}

	// Sample mode disables the fields; Advanced keeps its own Sample data switch
	// live so the user can get back out.
	const fieldsDisabled = sampleMode || saving;
	const active = TABS.find((entry) => entry.id === tab) ?? TABS[0];

	return (
		<div className="dd-page">
			{/* Save and Discard live in the page header, reachable from every
			    sub-page; they act on the form exactly as before. */}
			<PageHeader
				title="Settings"
				subtitle="Shared by every admin. Changes apply on the next bot start."
				actions={
					<div className="dd-row">
						<Btn variant="ghost" onClick={resetToDefaults} disabled={saving}>
							Reset to defaults
						</Btn>
						<Btn onClick={discard} disabled={!dirty || saving}>
							Discard changes
						</Btn>
						<Btn variant="primary" onClick={() => void save()} disabled={!dirty || saving || writesBlocked !== null} title={writesBlocked !== null ? writesBlocked : dirty ? 'Save these settings' : 'Nothing to save'}>
							{saving ? 'Saving…' : 'Save'}
						</Btn>
					</div>
				}
			/>

			{sampleMode && <SampleBanner />}
			{saveError !== null && <DdBanner variant="error">Could not save: {saveError}. Your edits are still on this form.</DdBanner>}
			{dirty && <DdBanner variant="info">Unsaved changes. Settings take effect the next time the bot starts.</DdBanner>}

			{offerRestart && (
				<DdCard title="Restart the bot?">
					<div className="dd-stack">
						<p className="dd-help">The saved settings apply on the next start. Restarting now drops the bot off the Discord Gateway for a moment and brings it back with the new configuration.</p>
						<div className="dd-row">
							<Btn variant="primary" icon="rotate" onClick={() => void restartNow()} disabled={bot.busy}>
								{bot.busy ? 'Restarting…' : 'Restart bot now'}
							</Btn>
							<Btn variant="ghost" onClick={() => setOfferRestart(false)}>
								Later
							</Btn>
						</div>
					</div>
				</DdCard>
			)}

			<div className="dd-settings">
				{/* The five sub-pages, all visible; the current one is raised. */}
				<nav className="dd-subnav" aria-label="Settings">
					{TABS.map((entry) => (
						<button key={entry.id} type="button" aria-current={entry.id === tab ? 'page' : undefined} onClick={() => onTabChange(entry.id)}>
							<Icon name={TAB_ICON[entry.id]} />
							{entry.label}
						</button>
					))}
				</nav>

				<DdCard>
					<div className="dd-stack" style={{ gap: 4 }}>
						<p className="dd-help" style={{ paddingTop: 4 }}>
							<strong className="dd-strong">{active.label}.</strong> {active.blurb}
						</p>
						{tab === 'discord' && <DiscordPage value={current.discord} onChange={(value) => patch('discord', value)} disabled={fieldsDisabled} tokenVariable={tokenVariable} openaiVariable={openaiVariable} githubVariable={githubVariable} qdrantVariable={qdrantVariable} serverVariables={serverVariables} memberMetadataOn={current.advanced.includeMemberMetadata} onOpenVariables={() => openOverlay('environment')} onOpenAppSettings={() => openOverlay('settings')} />}
						{tab === 'behavior' && <BehaviorPage value={current.behavior} onChange={(value) => patch('behavior', value)} disabled={fieldsDisabled} />}
						{tab === 'pipeline' && <PipelinePage value={current.pipeline} onChange={(value) => patch('pipeline', value)} disabled={fieldsDisabled} token={bot.token} captureToken={bot.captureToken} />}
						{tab === 'advanced' && <AdvancedPage value={current.advanced} onChange={(value) => patch('advanced', value)} disabled={fieldsDisabled} />}
						{tab === 'eval' && <EvalPage value={current.eval} onChange={(value) => patch('eval', value)} disabled={fieldsDisabled} allowedBotIds={current.discord.allowedBotIds} />}
					</div>
				</DdCard>
			</div>
		</div>
	);
};
