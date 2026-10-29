// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ActivityFeed — a timeline of recent events: runs finished, pipelines
 * deployed, keys rotated, members invited.
 *
 * Each item has a marker (the actor's Avatar, an icon, or a status dot), a
 * title, an optional description and meta line, and a relative time
 * ("5 minutes ago") whose full date is in the `<time>` element and its
 * tooltip. Items are grouped under day headings (Today, Yesterday, Mon,
 * Oct 26) unless `groupByDay` is off. Relative times refresh every minute.
 *
 * Give items newest first. For long histories pass `hasMore` and
 * `onLoadMore`; while `isLoadingMore` the button reads "Loading…" and
 * ignores clicks (it stays enabled so keyboard focus is not lost).
 *
 * A status `tone` is a secondary cue: the title must say what happened
 * ("Run failed"), since color alone carries no meaning.
 *
 * Built on `.rr-activity` from components.css.
 */

import React, { ReactNode, useEffect, useState } from 'react';
import { Avatar } from '../avatar/Avatar';
import { Button } from '../button/Button';
import { formatFullTime, formatRelativeTime, groupByDay, IDayGroup, TimestampInput, toDate } from './activityTime';

// =============================================================================
// TYPES
// =============================================================================

/** Status tone of an item's marker. */
export type ActivityTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

/** One event in the feed. */
export interface IActivityItem {
	/** Stable id. */
	id: string;
	/** What happened ("Run failed on rag-pipeline"). */
	title: ReactNode;
	/** When it happened. */
	timestamp: TimestampInput;
	/** Who did it; shown as an Avatar marker when there is no `icon`. */
	actor?: string;
	/** The actor's avatar image. */
	actorImage?: string;
	/** Icon marker (overrides the avatar). */
	icon?: ReactNode;
	/** Marker tone when there is no avatar. Defaults to `'neutral'`. */
	tone?: ActivityTone;
	/** Supporting text under the title. */
	description?: ReactNode;
	/** Trailing meta (a duration, a link, a badge). */
	meta?: ReactNode;
}

/** Props for the {@link ActivityFeed} component. */
export interface IActivityFeedProps {
	/** Items, newest first. */
	items: IActivityItem[];
	/** Accessible name of the feed. Defaults to `'Activity'`. */
	label?: string;
	/** Group under day headings. Defaults to true. */
	groupByDay?: boolean;
	/** Heading level of the day headings. Defaults to 3. */
	headingLevel?: 2 | 3 | 4;
	/** Reference time for relative times (tests, server render). Defaults to now, refreshed each minute. */
	now?: Date;
	/** Shown when there are no items. Defaults to `'No activity yet'`. */
	emptyText?: ReactNode;
	/** More items exist: shows a Load more button. */
	hasMore?: boolean;
	/** Loads the next page. */
	onLoadMore?: () => void;
	/** A page is loading. */
	isLoadingMore?: boolean;
}

// =============================================================================
// HOOKS
// =============================================================================

/**
 * The current time, refreshed every minute (or the fixed `now` when given).
 *
 * @param fixed - A fixed reference time.
 * @returns The reference time.
 */
function useNow(fixed: Date | undefined): Date {
	const [tick, setTick] = useState(() => new Date());
	useEffect(() => {
		if (fixed) return undefined;
		const timer = setInterval(() => setTick(new Date()), 60 * 1000);
		return () => clearInterval(timer);
	}, [fixed]);
	if (fixed) return fixed;
	return tick;
}

// =============================================================================
// COMPONENTS
// =============================================================================

/** Renders an item's marker: icon, avatar or status dot. */
function ActivityMarker({ item }: { item: IActivityItem }): React.ReactElement {
	if (item.icon) {
		return (
			<span className={`rr-activity__marker rr-activity__marker--icon rr-activity__marker--${item.tone ?? 'neutral'}`} aria-hidden="true">
				{item.icon}
			</span>
		);
	}
	if (item.actor) {
		return (
			<span className="rr-activity__marker">
				<Avatar name={item.actor} src={item.actorImage} size="sm" decorative />
			</span>
		);
	}
	return (
		<span className={`rr-activity__marker rr-activity__marker--dot rr-activity__marker--${item.tone ?? 'neutral'}`} aria-hidden="true">
			<span className="rr-activity__dot" />
		</span>
	);
}

/** Renders one item. */
function ActivityRow({ item, now }: { item: IActivityItem; now: Date }): React.ReactElement {
	const date = toDate(item.timestamp);
	const full = formatFullTime(date);
	return (
		<li className="rr-activity__item">
			<ActivityMarker item={item} />
			<div className="rr-activity__body">
				<div className="rr-activity__title">
					{item.actor && <span className="rr-activity__actor">{item.actor} </span>}
					{item.title}
				</div>
				{item.description && <div className="rr-activity__description">{item.description}</div>}
				<div className="rr-activity__meta">
					<time dateTime={date.toISOString()} title={full}>
						{formatRelativeTime(date, now)}
					</time>
					{item.meta && <span className="rr-activity__meta-extra">{item.meta}</span>}
				</div>
			</div>
		</li>
	);
}

/**
 * Renders an activity timeline.
 *
 * @param props - {@link IActivityFeedProps}.
 * @returns The feed.
 */
export function ActivityFeed({ items, label = 'Activity', groupByDay: isGrouped = true, headingLevel = 3, now, emptyText = 'No activity yet', hasMore = false, onLoadMore, isLoadingMore = false }: IActivityFeedProps): React.ReactElement {
	const reference = useNow(now);
	const Heading = `h${headingLevel}` as 'h3';

	if (!items.length) {
		return (
			<section className="rr-activity" aria-label={label}>
				<p className="rr-activity__empty">{emptyText}</p>
			</section>
		);
	}

	/** Asks for the next page; ignored while one is loading so the button keeps focus. */
	function handleLoadMore(): void {
		if (isLoadingMore || !onLoadMore) return;
		onLoadMore();
	}

	let loadLabel = 'Load more';
	if (isLoadingMore) loadLabel = 'Loading…';

	let groups: IDayGroup<IActivityItem>[] = [{ key: 'all', label: '', items }];
	if (isGrouped) groups = groupByDay(items, (item) => item.timestamp, reference);

	return (
		<section className="rr-activity" aria-label={label} aria-busy={isLoadingMore || undefined}>
			{groups.map((group) => (
				<div key={group.key} className="rr-activity__group">
					{isGrouped && <Heading className="rr-activity__day">{group.label}</Heading>}
					<ol className="rr-activity__list">
						{group.items.map((item) => (
							<ActivityRow key={item.id} item={item} now={reference} />
						))}
					</ol>
				</div>
			))}
			{hasMore && onLoadMore && (
				<div className="rr-activity__more">
					<Button variant="ghost" small onClick={handleLoadMore}>
						{loadLabel}
					</Button>
				</div>
			)}
		</section>
	);
}
