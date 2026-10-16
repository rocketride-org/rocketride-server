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
// QUALITY — three tabs over one question: is the bot any good, and who says so
// =============================================================================
//
// A shell and nothing else. The three tabs are the eval loop's three human
// surfaces, in the order they are used:
//
// SCORECARD — the numbers. What the reference bot posted to `#ralph-eval` every
// Monday, computed from the rows the app holds.
// REVIEW — the queue. What the reference posted as a card per graded thread, and
// the only place a Q/A pair is approved into Ralph's knowledge base.
// REPLAY — the regression check, and the grader that fills the other two tabs.
//
// Every panel stays MOUNTED (the stock `TabPanel`), which is not a detail: a
// half-written answer in the Review tab's teach editor survives a look at the
// Scorecard, and a grading batch keeps running while the reviewer reads the
// numbers it is producing.
// =============================================================================

import React from 'react';
import { TabPanel } from 'shell';
import type { QualityState, QualityTabId } from '../state/types';
import { Skeleton } from '../ui/parts';
import { DdCard, PageHeader, Tabs } from '../ui/dd';
import { ReplayTab } from './quality/ReplayTab';
import { ReviewTab } from './quality/ReviewTab';
import { ScorecardTab } from './quality/ScorecardTab';
import type { ScreenProps } from './types';

// The replay helpers keep living with the replay UI; they are re-exported here
// because the app root reads `regressions` for the nav badge and should not have
// to know which tab owns the import.
export { parseReplayJsonl, regressions, GRADE_LABEL, RUN_REPLAY_REASON } from './quality/ReplayTab';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * The tabs, in the order the UX spec fixes.
 *
 * Re-exported rather than declared: the open tab is a UI PREFERENCE now, so
 * the type lives with the rest of them in `state/types.ts` and this file goes
 * on being the one that names them for a reader.
 */
export type { QualityTabId };

/** Labels for those tabs. */
const TABS: { id: QualityTabId; label: string }[] = [
	{ id: 'scorecard', label: 'Scorecard' },
	{ id: 'review', label: 'Review' },
	{ id: 'replay', label: 'Test' },
];

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link QualityScreen}. */
export interface QualityScreenProps extends ScreenProps {
	/**
	 * The sample run pair to render in demo mode. Owned by the app root, not
	 * built here: the nav's regression badge reads the SAME pair, and a fresh
	 * object per render would both defeat the memos below and let the badge and
	 * the screen disagree.
	 */
	sampleRuns: QualityState;
	/** Which tab is open — a UI preference the app root holds. */
	tab: QualityTabId;
	/** Switch tab. */
	onTabChange: (tab: QualityTabId) => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Quality screen.
 *
 * @param props - See {@link QualityScreenProps}.
 * @returns The screen.
 */
export const QualityScreen: React.FC<QualityScreenProps> = ({ data, actions, pendingQa, loaded, sampleMode, conn, writesBlocked, ui, patchUi, openKnowledgeSearch, sampleRuns, tab, onTabChange }) => {
	const quality = sampleMode ? sampleRuns : data.quality;

	// --- LOADING --------------------------------------------------------------

	if (!sampleMode && !loaded) {
		return (
			<div className="dd-page">
				<PageHeader title="Quality" subtitle="How often Ralph resolves a thread on his own, and what drives the misses." />
				<DdCard>
					<Skeleton rows={4} label="Loading the eval record" />
				</DdCard>
			</div>
		);
	}

	// The tabs sit under the Quality page header, which each tab draws (its
	// subtitle and header chip are its own). Every tab stays mounted (TabPanel
	// hides the others), so a running replay survives a tab switch.
	const nav = <Tabs label="Quality" items={TABS} active={tab} onSelect={(id) => onTabChange(id as QualityTabId)} />;

	return (
		<div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
			<div style={{ flex: 1, minHeight: 0 }}>
				<TabPanel
					activeId={tab}
					panels={{
						scorecard: {
							content: <ScorecardTab data={data} quality={quality} sampleMode={sampleMode} nav={nav} />,
						},
						review: {
							content: <ReviewTab data={data} actions={actions} pendingQa={pendingQa} sampleMode={sampleMode} writesBlocked={writesBlocked} filters={ui.reviewFilters} onFiltersChange={(reviewFilters) => patchUi({ reviewFilters })} nav={nav} onWhatRetrieved={openKnowledgeSearch} />,
						},
						replay: {
							content: <ReplayTab data={data} actions={actions} quality={quality} sampleMode={sampleMode} conn={conn} writesBlocked={writesBlocked} nav={nav} active={tab === 'replay'} />,
						},
					}}
				/>
			</div>
		</div>
	);
};
