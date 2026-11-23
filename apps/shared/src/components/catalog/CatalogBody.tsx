// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CATALOG BODY — the catalog body: a responsive 3-up grid of AppCards or a
// stacked list of AppListRows.
// =============================================================================

import React, { type CSSProperties } from 'react';
import type { AppManifestEntry } from 'shell';
import type { ICatalogPalette } from './palette';
import { AppCard } from './AppCard';
import { AppListRow } from './AppListRow';
import type { CatalogView } from './palette';


// Honor the OS "reduce motion" setting — same idiom as the rest of home-ui.
const REDUCE_MOTION =
	typeof window !== 'undefined' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface CatalogBodyProps {
	/** Apps to render. */
	apps: AppManifestEntry[];
	/** Active theme tokens. */
	t: ICatalogPalette;
	/** Grid or list layout. */
	view: CatalogView;
	/** Open the detail panel for an app. */
	onOpen: (app: AppManifestEntry) => void;
	/** CTA label resolver for list rows. */
	getCtaLabel: (app: AppManifestEntry) => string;
	/** CTA handler for list rows. */
	onCta: (app: AppManifestEntry) => void;
}

/**
 * Catalog body. In grid view it lays {@link AppCard} tiles three-up (reflowing
 * down to one column on narrow screens via `auto-fill`); in list view it stacks
 * {@link AppListRow}s.
 */
export const CatalogBody: React.FC<CatalogBodyProps> = ({ apps, t, view, onOpen, getCtaLabel, onCta }) => {
	if (apps.length === 0) return null;

	const sectionAnim: CSSProperties = REDUCE_MOTION
		? {}
		: { animation: 'rr-fade-up 420ms cubic-bezier(0.22,1,0.36,1) backwards' };

	return (
		<section style={{ marginTop: 24, fontFamily: t.font, ...sectionAnim }}>
			{view === 'grid' ? (
				<div style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
					gap: 24,
				}}>
					{apps.map((app) => (
						<AppCard key={app.id} app={app} t={t} onOpen={onOpen} badge={getCtaLabel(app)} />
					))}
				</div>
			) : (
				<div style={{
					border: `1px solid ${t.border}`, borderRadius: 12, overflow: 'hidden',
					backgroundColor: t.bgSurface,
				}}>
					{apps.map((app) => (
						<AppListRow
							key={app.id}
							app={app}
							t={t}
							onClick={onOpen}
							ctaLabel={getCtaLabel(app)}
							onCta={onCta}
						/>
					))}
				</div>
			)}
		</section>
	);
};
