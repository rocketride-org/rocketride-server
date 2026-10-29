// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Demo data shared by the dashboard-widget gallery entries. Deterministic
 * (no random numbers) so screenshots and docs stay stable. Pipeline and
 * people names are fictional.
 */

import type { IActivityItem, IChartData } from 'shell';

/** The last 14 days, oldest first ("Oct 16" .. "Oct 29"). */
export const DAYS: string[] = Array.from({ length: 14 }, (_, index) => `Oct ${16 + index}`);

/** Runs per day for three pipelines. */
export const RUNS_BY_PIPELINE: IChartData = {
	categories: DAYS,
	series: [
		{ id: 'rag', label: 'rag-pipeline', values: [820, 860, 910, 870, 940, 1010, 980, 1050, 1120, 1080, 1160, 1210, 1190, 1284] },
		{ id: 'ingest', label: 'doc-ingest', values: [410, 430, 400, 460, 480, 450, 520, 540, 510, 560, 590, 570, 610, 640] },
		{ id: 'summarize', label: 'summarize', values: [150, 170, 160, 180, null, 210, 200, 230, 220, 250, 240, 270, 260, 290] },
	],
};

/** Tokens per model this week (millions). */
export const TOKENS_BY_MODEL: IChartData = {
	categories: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
	series: [
		{ id: 'large', label: 'Large model', values: [4.2, 4.8, 5.1, 4.9, 5.6, 2.1, 1.8] },
		{ id: 'small', label: 'Small model', values: [2.4, 2.6, 2.9, 3.1, 3.0, 1.2, 1.1] },
	],
};

/** p95 latency (ms) over 14 days, where down is good. */
export const LATENCY: number[] = [612, 598, 640, 655, 630, 590, 575, 560, 548, 552, 530, 525, 518, 504];

/** A fixed "now" for the feed demo: Oct 29, 2026, 18:00 local. */
export const DEMO_NOW = new Date(2026, 9, 29, 18, 0);

/** Recent workspace events, newest first. */
export const ACTIVITY: IActivityItem[] = [
	{ id: 'a1', actor: 'Dana Reyes', title: 'deployed rag-pipeline v14', timestamp: new Date(2026, 9, 29, 17, 52), meta: 'production' },
	{ id: 'a2', icon: '✕', tone: 'error', title: 'Run failed on doc-ingest', description: 'Source timed out after 30s (connector: object-store).', timestamp: new Date(2026, 9, 29, 16, 10) },
	{ id: 'a3', icon: '✓', tone: 'success', title: 'Nightly eval passed', description: 'Answer relevance 0.91 (threshold 0.85).', timestamp: new Date(2026, 9, 29, 3, 0) },
	{ id: 'a4', actor: 'Sam Okafor', title: 'rotated the API key "ci-runner"', timestamp: new Date(2026, 9, 28, 14, 30) },
	{ id: 'a5', tone: 'warning', title: 'Token quota at 82%', timestamp: new Date(2026, 9, 28, 9, 15) },
	{ id: 'a6', actor: 'Priya Nair', title: 'invited 2 members to the workspace', timestamp: new Date(2026, 9, 26, 11, 5) },
];
