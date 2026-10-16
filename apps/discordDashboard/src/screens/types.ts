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
// SCREEN CONTRACT — what every screen receives from the app root
// =============================================================================

import type { AppData, ScreenId, SettingsTabId, UiPrefs, UpdateUiPrefs } from '../state/types';
import type { UseBotTask } from '../bot/useBotTask';
import type { DbConnection } from '../db/config';
import type { DbStatus } from '../db/gateway';
import type { ApprovedQa } from '../db/repo';
import type { DashboardActions } from '../db/useDashboardData';

/** The props every screen takes. */
export interface ScreenProps {
	/** Everything the screens render, assembled from the database. */
	data: AppData;
	/**
	 * Every write, as an explicit awaitable call.
	 *
	 * There is no functional updater any more: the database is the merge, and
	 * a write names what it changed rather than handing back a whole slice.
	 */
	actions: DashboardActions;
	/** The approved Q/A pairs a knowledge-base writeback would still write. */
	pendingQa: ApprovedQa[];
	/** True once the first full load has landed. */
	loaded: boolean;
	/** The bot task's lifecycle surface. */
	bot: UseBotTask;
	/** Settings › Advanced › Sample data is on: labelled rows, no actions. */
	sampleMode: boolean;
	/** Where the dashboard database is, from the manifest settings. */
	conn: DbConnection;
	/** Where the database connection is. */
	dbStatus: DbStatus;
	/** The database's last failure text, or null. */
	dbError: string | null;
	/**
	 * Why a write cannot run, or null when it can.
	 *
	 * Computed once at the root so every screen's disabled reason is the same
	 * sentence — the top-of-app banner and a greyed-out button must not
	 * describe the same outage two different ways.
	 */
	writesBlocked: string | null;
	/** This viewer's UI preferences — the only thing still in the workspace. */
	ui: UiPrefs;
	/** Merge a patch into them. */
	patchUi: UpdateUiPrefs;
	/** Navigate to another screen, optionally to one of Settings' sub-pages. */
	goto: (screen: ScreenId, tab?: SettingsTabId) => void;
	/** Ask the shell to open one of its own overlays. */
	openOverlay: (id: 'settings' | 'environment') => void;
	/**
	 * Open the Knowledge screen's meaning search for one question — the
	 * "What Ralph retrieved" link on a conversation and on a review card.
	 */
	openKnowledgeSearch: (question: string) => void;
	/**
	 * Names of the variables saved on the server, or null when the list is
	 * UNKNOWN — the account surface is unreachable, or sample mode is on. Null is
	 * not "none": a screen must not claim a variable is missing on a call that
	 * never answered.
	 */
	serverVariables: string[] | null;
	/**
	 * The variable NAME the app's `botToken` setting holds. The checklist and the
	 * empty state both test the CONFIGURED name rather than a literal, so
	 * renaming the variable cannot silently break step 1.
	 */
	tokenVariable: string;
}
