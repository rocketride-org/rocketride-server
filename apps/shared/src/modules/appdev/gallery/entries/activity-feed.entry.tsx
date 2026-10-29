// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for ActivityFeed. */

import React, { useState } from 'react';
import { ActivityFeed } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';
import { ACTIVITY, DEMO_NOW } from './dashboard-demo-data';

/** Live demo: the workspace feed with a simulated Load more. */
const ActivityFeedDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [count, setCount] = useState(4);
	const [isLoadingMore, setIsLoadingMore] = useState(false);

	/** Pretends to fetch the next page. */
	function loadMore(): void {
		setIsLoadingMore(true);
		setTimeout(() => {
			setCount(ACTIVITY.length);
			setIsLoadingMore(false);
		}, 600);
	}

	return (
		<div style={{ maxWidth: 420 }}>
			<ActivityFeed items={ACTIVITY.slice(0, count)} now={DEMO_NOW} groupByDay={Boolean(knobs.groupByDay)} hasMore={count < ACTIVITY.length} onLoadMore={loadMore} isLoadingMore={isLoadingMore} />
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let extra = '';
	if (!knobs.groupByDay) extra = '\n\tgroupByDay={false}';
	return `import { ActivityFeed } from 'shell';

<ActivityFeed
	items={[
		{ id: 'e1', actor: 'Dana Reyes', title: 'deployed rag-pipeline v14', timestamp: event.at },
		{ id: 'e2', icon: '✕', tone: 'error', title: 'Run failed on doc-ingest', description: reason, timestamp: run.endedAt },
	]}${extra}
	hasMore={page.hasMore}
	onLoadMore={fetchNextPage}
	isLoadingMore={isFetching}
/>`;
}

/** The ActivityFeed gallery entry. */
export const activityFeedEntry: IGalleryEntry = {
	id: 'activity-feed',
	name: 'ActivityFeed',
	group: 'dashboards',
	blurb: 'A timeline of recent events grouped under day headings, with an avatar, icon or status dot per item and relative times that refresh every minute.',
	doc: 'Give items newest first. The marker is the `icon` if set, else the actor\'s Avatar, else a status dot in `tone`. A tone is a secondary cue: the title must say what happened ("Run failed"). Each time is a `<time>` element whose tooltip is the full date. While `isLoadingMore` the button reads "Loading…" and stays focused.',
	knobs: [{ id: 'groupByDay', label: 'Group by day', kind: 'boolean', defaultValue: true }],
	demo: ActivityFeedDemo,
	code: buildCode,
	props: [
		{ name: 'items', type: 'IActivityItem[]', dir: 'in', required: true, note: '{ id, title, timestamp, actor?, actorImage?, icon?, tone?, description?, meta? }.' },
		{ name: 'label', type: 'string', dir: 'in', note: "Region name. Default 'Activity'." },
		{ name: 'groupByDay', type: 'boolean', dir: 'in', note: 'Default true.' },
		{ name: 'headingLevel', type: '2 | 3 | 4', dir: 'in', note: 'Day headings. Default 3.' },
		{ name: 'now', type: 'Date', dir: 'in', note: 'Fixed reference time (tests, server render).' },
		{ name: 'emptyText', type: 'ReactNode', dir: 'in', note: "Default 'No activity yet'." },
		{ name: 'hasMore / onLoadMore / isLoadingMore', type: 'boolean / fn / boolean', dir: 'in', note: 'Pagination.' },
	],
};
