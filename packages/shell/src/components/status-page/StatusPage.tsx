// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * StatusPage — a whole view replaced by a status: not found, no access,
 * something broke, down for maintenance, offline. Centered in whatever box
 * it is given, with a large code, a heading, a sentence of explanation, the
 * next actions, and optional technical details (an error id or stack) in a
 * collapsed disclosure.
 *
 * Each `kind` has a preset title and description; override either. For an
 * empty list or panel inside a page, use EmptyState instead; StatusPage is
 * for when the page itself cannot be shown. `kind="error"` and `"offline"`
 * are announced (role="alert") because they usually appear unprompted.
 *
 * Built on `.rr-status-page` from components.css.
 */

import React, { ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Which status. */
export type StatusPageKind = 'not-found' | 'forbidden' | 'error' | 'maintenance' | 'offline';

/** A kind's default code, title and description. */
export interface IStatusPreset {
	code: string;
	title: string;
	description: string;
}

/** Props for the {@link StatusPage} component. */
export interface IStatusPageProps {
	/** The status. */
	kind: StatusPageKind;
	/** Override the preset title. */
	title?: ReactNode;
	/** Override the preset description. */
	description?: ReactNode;
	/** Override the large code (e.g. `'429'`); pass `''` to hide it. */
	code?: string;
	/** Next steps: a primary Button to recover, a secondary to go home. */
	actions?: ReactNode;
	/** Technical details (error id, stack), collapsed under "Details". */
	details?: ReactNode;
	/** Heading level. Defaults to 1. */
	headingLevel?: 1 | 2;
}

// =============================================================================
// PRESETS
// =============================================================================

const PRESETS: Record<StatusPageKind, IStatusPreset> = {
	'not-found': { code: '404', title: 'Page not found', description: 'The page you are looking for does not exist or has moved. Check the address, or go back to where you were.' },
	forbidden: { code: '403', title: 'You do not have access', description: 'Your account cannot open this page. Ask an organization admin to grant you access.' },
	error: { code: '500', title: 'Something went wrong', description: 'An unexpected error stopped this page from loading. Try again; if it keeps happening, share the details below with support.' },
	maintenance: { code: '', title: 'Down for maintenance', description: 'This service is being updated and will be back shortly. Your pipelines keep their configuration.' },
	offline: { code: '', title: 'You are offline', description: 'The connection to the RocketRide server was lost. We will reconnect automatically when the network is back.' },
};

/**
 * The default code, title and description for a kind.
 *
 * @param kind - The status.
 * @returns Its preset.
 */
export function getStatusPreset(kind: StatusPageKind): IStatusPreset {
	return PRESETS[kind];
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a full-view status.
 *
 * @param props - {@link IStatusPageProps}.
 * @returns The status page element.
 */
export function StatusPage({ kind, title, description, code, actions, details, headingLevel = 1 }: IStatusPageProps): React.ReactElement {
	const preset = getStatusPreset(kind);
	const shownCode = code ?? preset.code;
	const Heading = `h${headingLevel}` as 'h1';

	let role: string | undefined;
	if (kind === 'error' || kind === 'offline') role = 'alert';

	return (
		<div className={`rr-status-page rr-status-page--${kind}`} role={role}>
			<div className="rr-status-page__inner">
				{shownCode && (
					<div className="rr-status-page__code" aria-hidden="true">
						{shownCode}
					</div>
				)}
				<Heading className="rr-status-page__title">{title ?? preset.title}</Heading>
				<p className="rr-status-page__description">{description ?? preset.description}</p>
				{actions && <div className="rr-status-page__actions">{actions}</div>}
				{details && (
					<details className="rr-status-page__details">
						<summary>Details</summary>
						<div className="rr-status-page__details-body rr-text-mono">{details}</div>
					</details>
				)}
			</div>
		</div>
	);
}
