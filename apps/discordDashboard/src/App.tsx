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
// DISCORD DASHBOARD — the app root
// =============================================================================
//
// Owns the five-screen navigation (Bot, Conversations, Quality, Knowledge,
// Settings — in that order, Settings last), the database the data comes from, the bot task
// and the live nudge, and hands each screen the same {@link ScreenProps}
// contract.
//
// WHERE THE DATA IS. Everything the screens render comes out of a shared
// Postgres database through `useDashboardData` — settings, conversations,
// grades, reviews, clusters, the golden set, the replay runs and what Teach
// Ralph has approved. The workspace slice keeps this viewer's UI preferences
// and nothing else. The connection itself is five MANIFEST settings, because
// the app has to know where the database is before it can read anything out
// of it.
//
// The Quality nav entry carries the regression badge: a seed that passed on the
// previous replay and does not pass on the latest one is the one thing the
// engineering owner must not have to go looking for.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { AppLayout, SidebarMenu, StatusDot, useShellConnection, useWorkspace } from 'shell';
import type { ShellAppProps, ViewMenu } from 'shell';
import { useUiPrefs } from './state/useAppData';
import { BOT_TOKEN_SETTING, DB_HOST_SETTING, DB_NAME_SETTING, DB_PASSWORD_SETTING, DB_PROVIDER_SETTING, DB_USER_SETTING, GITHUB_TOKEN_SETTING, OPENAI_KEY_SETTING, QDRANT_HOST_SETTING, SETTING_DEFAULTS, SLACK_WEBHOOK_SETTING } from './state/types';
import type { QualityTabId, ScreenId, SettingsTabId } from './state/types';
import { connectionFromSettings, LOCAL_CONTAINER } from './db/config';
import { useDashboardData } from './db/useDashboardData';
import { useBotTask } from './bot/useBotTask';
import { useConversationCapture } from './bot/useConversationCapture';
import { sampleQuality } from './sample';
import { ToastProvider } from './ui/toast';
import { DdBanner, DdRoot } from './ui/dd';
// The design system: fonts, tokens and components, scoped to `.dd-root`.
import './ui/theme/index.css';
import { BotScreen } from './screens/BotScreen';
import { ConversationsScreen } from './screens/ConversationsScreen';
import { KnowledgeScreen } from './screens/KnowledgeScreen';
import { QualityScreen, regressions } from './screens/QualityScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import type { ScreenProps } from './screens/types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Screen labels, in navigation order. Settings is last, per the UX spec. */
const SCREENS: { id: ScreenId; label: string }[] = [
	{ id: 'bot', label: 'Bot' },
	{ id: 'conversations', label: 'Conversations' },
	{ id: 'quality', label: 'Quality' },
	{ id: 'knowledge', label: 'Knowledge' },
	{ id: 'settings', label: 'Settings' },
];

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Sidebar column: the menu, then the live bot dot at the bottom. */
	sidebar: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		gap: 12,
		padding: '10px 8px',
		boxSizing: 'border-box',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** The bot's state, pinned under the menu. */
	footer: {
		marginTop: 'auto',
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '8px 10px',
		fontSize: 12,
		color: 'var(--ink-muted)',
	} as CSSProperties,

	/** Status-bar slot content. */
	statusSlot: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		fontSize: 12,
	} as CSSProperties,
};

// =============================================================================
// ROOT
// =============================================================================

/**
 * The app the shell mounts. Provides toasts, then the dashboard itself.
 *
 * @returns The app tree.
 */
const App: React.FC<ShellAppProps> = (props) => (
	<ToastProvider>
		<Dashboard {...props} />
	</ToastProvider>
);

// =============================================================================
// DASHBOARD
// =============================================================================

/**
 * The dashboard: navigation, state, task and screens.
 *
 * @param props.isConnected - Whether the shell's WebSocket is up.
 * @returns The two-column app.
 */
const Dashboard: React.FC<ShellAppProps> = ({ isConnected }) => {
	const { ui, patchUi } = useUiPrefs();
	const { settings, emit } = useWorkspace();
	const { client } = useShellConnection();

	// --- Where the database is ------------------------------------------------

	// From the MANIFEST, not from the database: the app cannot read its own
	// connection out of the thing it is trying to connect to. The password is
	// a variable NAME; the value stays encrypted on the server.
	const conn = useMemo(
		() =>
			connectionFromSettings(settings, SETTING_DEFAULTS, {
				provider: DB_PROVIDER_SETTING,
				host: DB_HOST_SETTING,
				database: DB_NAME_SETTING,
				user: DB_USER_SETTING,
				password: DB_PASSWORD_SETTING,
			}),
		[settings]
	);

	// The database stays connected in sample mode, and deliberately: sample
	// data is a RENDER mode (labelled rows, every action disabled), not a
	// connection mode. It is also the only setting that lives IN the database,
	// so disabling the connection on it would make the app unable to read the
	// switch that is supposed to be off — turning sample mode on once would
	// make the app forget it was ever on.
	const dashboard = useDashboardData(conn, true);
	const { data, loaded, dbStatus, dbError, pendingQa, kbDocuments, actions } = dashboard;

	// Sample data is the demo / read-only mode of the whole app.
	const sampleMode = data.settings.advanced.sampleData;

	// --- Navigation state, which is the only thing the workspace still holds ---

	const screen = ui.screen;
	const settingsTab = ui.settingsTab;
	const setScreen = useCallback((next: ScreenId) => patchUi({ screen: next }), [patchUi]);
	const setSettingsTab = useCallback((next: SettingsTabId) => patchUi({ settingsTab: next }), [patchUi]);
	const setQualityTab = useCallback((next: QualityTabId) => patchUi({ qualityTab: next }), [patchUi]);

	// --- Variable names and what the server actually holds --------------------

	/** The variable NAME the app's envkey settings hold (never the value). */
	const tokenVariable = String(settings[BOT_TOKEN_SETTING] ?? SETTING_DEFAULTS[BOT_TOKEN_SETTING]);
	const openaiVariable = String(settings[OPENAI_KEY_SETTING] ?? SETTING_DEFAULTS[OPENAI_KEY_SETTING]);
	const githubVariable = String(settings[GITHUB_TOKEN_SETTING] ?? SETTING_DEFAULTS[GITHUB_TOKEN_SETTING]);
	const qdrantVariable = String(settings[QDRANT_HOST_SETTING] ?? SETTING_DEFAULTS[QDRANT_HOST_SETTING]);
	const slackVariable = String(settings[SLACK_WEBHOOK_SETTING] ?? SETTING_DEFAULTS[SLACK_WEBHOOK_SETTING]);

	// Which variables exist on the server, for the checklist's first step and
	// for the Settings › Discord "Saved on server" line. The same call the
	// shell's own envkey widget makes. `null` means UNKNOWN — the call has not
	// answered, failed, or was never made — and every reader has to say so
	// rather than reporting "missing".
	const [serverVariables, setServerVariables] = useState<string[] | null>(null);
	useEffect(() => {
		if (!client || !isConnected || sampleMode) {
			setServerVariables(null);
			return;
		}
		let alive = true;
		client.account
			.getEnvironmentKeys()
			.then((keys: string[]) => {
				if (alive) setServerVariables(Array.isArray(keys) ? keys : []);
			})
			.catch(() => {
				// No account surface (or not permitted): the list stays unknown, so
				// the checklist falls back to the persisted tick and Settings says
				// "could not be read" instead of "not saved".
				if (alive) setServerVariables(null);
			});
		return () => {
			alive = false;
		};
	}, [client, isConnected, sampleMode]);

	/** What a start needs beyond the ids — see `missingForStart`. */
	const optionalVariables = useMemo(() => ({ github: githubVariable, qdrant: qdrantVariable, slack: slackVariable, saved: serverVariables }), [githubVariable, qdrantVariable, slackVariable, serverVariables]);

	// The bot task. Disabled in sample mode: no call leaves the browser. `conn`
	// is what gives the bot's pipeline its capture component.
	const bot = useBotTask(data, !sampleMode, optionalVariables, conn, actions.probeDatabase);

	// The live nudge. The node writes the event into the database itself; this
	// only asks the data layer to re-read NOW instead of on the next tick.
	// BOTH tasks: the shadow capture branch is the one running with reactions on.
	useConversationCapture([bot.token, bot.captureToken], actions.poll, !sampleMode);

	// --- Navigation -----------------------------------------------------------

	const goto = useCallback(
		(next: ScreenId, tab?: SettingsTabId) => {
			patchUi(tab === undefined ? { screen: next } : { screen: next, settingsTab: tab });
		},
		[patchUi]
	);

	// "What Ralph retrieved": a conversation or a review card asks the Knowledge
	// screen for a meaning search. Held here, not in the UI preferences — it is
	// a one-shot request, and the nonce makes asking twice for the same question
	// run it twice.
	const [kbSearch, setKbSearch] = useState<{ text: string; nonce: number } | null>(null);
	const openKnowledgeSearch = useCallback(
		(question: string) => {
			setKbSearch({ text: question, nonce: Date.now() });
			patchUi({ screen: 'knowledge' });
		},
		[patchUi]
	);
	const consumeKbSearch = useCallback(() => setKbSearch(null), []);

	const openOverlay = useCallback(
		(id: 'settings' | 'environment') => {
			emit('shell:openOverlay', { id });
		},
		[emit]
	);

	// The regression badge (UX spec F4): computed from the persisted runs, so it
	// is there the moment the app opens. In sample mode it must read the SAME
	// sample run the Quality screen renders, or the screen shows a regression
	// the nav badge denies.
	const sampleRuns = useMemo(() => sampleQuality(Date.now()), []);
	const quality = sampleMode ? sampleRuns : data.quality;
	const regressed = useMemo(() => regressions(quality.lastRun, quality.previousRun), [quality.lastRun, quality.previousRun]);

	const menu = useMemo<ViewMenu>(
		() => ({
			entries: SCREENS.map((entry) => {
				if (entry.id === 'conversations' && data.conversations.length > 0) {
					return { ...entry, count: data.conversations.length };
				}
				if (entry.id === 'quality' && regressed.length > 0) {
					return { ...entry, count: regressed.length, severity: 'error' as const };
				}
				return entry;
			}),
		}),
		[data.conversations.length, regressed.length]
	);

	// --- Screen props ---------------------------------------------------------

	/**
	 * Why a write cannot run, or null.
	 *
	 * One sentence, computed once: every screen's write controls disable
	 * themselves with it rather than each inventing its own wording for "the
	 * database is down".
	 */
	const writesBlocked = dbStatus === 'error' ? `The dashboard database is unreachable: ${dbError ?? 'no reason given'}` : dbStatus === 'connecting' ? 'Connecting to the dashboard database' : null;

	const screenProps: ScreenProps = {
		data,
		actions,
		pendingQa,
		loaded,
		bot,
		sampleMode,
		conn,
		dbStatus,
		dbError,
		writesBlocked,
		ui,
		patchUi,
		goto,
		openOverlay,
		openKnowledgeSearch,
		serverVariables,
		tokenVariable,
	};

	const sidebar = (
		<div style={styles.sidebar}>
			<SidebarMenu menu={menu} activeId={screen} onSelect={(id) => setScreen(id as ScreenId)} sectionLabel="Discord Dashboard" />
			<div style={styles.footer}>
				<StatusDot variant={sampleMode ? 'warning' : bot.phase === 'running' ? 'success' : bot.phase === 'failed' ? 'error' : 'muted'} />
				<span>{sampleMode ? 'Sample data' : bot.phase === 'running' ? 'Bot running' : bot.phase === 'starting' ? 'Bot starting' : bot.phase === 'failed' ? 'Bot disconnected' : 'Bot stopped'}</span>
			</div>
		</div>
	);

	const statusSlot = <span style={styles.statusSlot}>{sampleMode ? 'Sample data — actions disabled' : bot.token !== null ? 'Bot task attached' : 'No bot task'}</span>;

	// Where the database is decides how to bring it back.
	const dbHost = conn.host.split(':')[0].trim().toLowerCase();
	const dbIsLocal = conn.provider === 'db_postgres' && ['localhost', '127.0.0.1', '::1', ''].includes(dbHost);

	return (
		<AppLayout sidebar={sidebar} status={statusSlot}>
			<DdRoot>
				{/* The engine connection is the shell's to own, but every screen here
				    depends on it, so its absence is said once at the top rather than
				    four times in four different empty states. */}
				{!isConnected && !sampleMode && (
					<div className="dd-topbanner">
						<DdBanner variant="warning" title="Not connected to the engine.">
							The screens show what was captured earlier; the bot cannot be started or stopped until the connection is back.
						</DdBanner>
					</div>
				)}
				{/* The database is a separate failure from the engine, and it fails
				    differently: Ralph goes on answering, but capture writes fail, so
				    new messages are not saved until it is back. Said once, at the top:
				    what broke, what still works, how to fix it, and the reason. */}
				{dbStatus === 'error' && !sampleMode && (
					<div className="dd-topbanner">
						<DdBanner variant="error" title="The dashboard database is not reachable.">
							Ralph keeps answering, but new messages are not being saved until it is back.{' '}
							{dbIsLocal ? (
								<>
									Start it with <code>docker start {LOCAL_CONTAINER}</code>.
								</>
							) : conn.provider === 'rocketride_sql' ? (
								'Check the RocketRide Cloud database for this account.'
							) : (
								`Start the Postgres server at ${conn.host}.`
							)}{' '}
							<span className="dd-caption">({dbError ?? 'no reason given'})</span>
						</DdBanner>
					</div>
				)}
				<div className="dd-scroll">
					{screen === 'bot' && <BotScreen {...screenProps} />}
					{screen === 'conversations' && <ConversationsScreen {...screenProps} />}
					{screen === 'quality' && <QualityScreen {...screenProps} sampleRuns={sampleRuns} tab={ui.qualityTab} onTabChange={setQualityTab} />}
					{screen === 'knowledge' && <KnowledgeScreen {...screenProps} kbDocuments={kbDocuments} pendingSearch={kbSearch} onSearchConsumed={consumeKbSearch} />}
					{screen === 'settings' && <SettingsScreen {...screenProps} tab={settingsTab} onTabChange={setSettingsTab} openaiVariable={openaiVariable} githubVariable={githubVariable} qdrantVariable={qdrantVariable} />}
				</div>
			</DdRoot>
		</AppLayout>
	);
};

export default App;
