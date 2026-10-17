// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DESKTOP VIEW — the shared desktop page (greeting + quote + app-card grid)
// =============================================================================
//
// The one desktop implementation consumed by every launcher host: the OSS
// hello app, the SaaS home app, and rocket-ui's Desktop document page. It
// renders ONLY the desktop content — greeting + subtitle on the left, the
// rotating AI-leader quote on the right, and the responsive card grid below.
// Hosts own all chrome (nav, footer, background, padding) and pass the app
// list; launch, versions, overrides, remove, unsubscribe, and subscription
// status are handled internally (see adapter.ts) unless overridden.

import React, { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import { DesktopAppCard } from './DesktopAppCard';
import { RevealText } from './RevealText';
import { useStaggerReveal } from './useStaggerReveal';
import { createShellDesktopAdapter, defaultLaunch } from './adapter';
import { getGreeting } from './greeting';
import { DESKTOP_QUOTES, currentQuoteIndex } from './quotes';
import type { DesktopViewProps } from './types';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	/** Root column — centred content; the HOST supplies padding/background. */
	root: {
		display: 'flex',
		flexDirection: 'column' as const,
		alignItems: 'center',
		gap: 32,
		width: '100%',
		boxSizing: 'border-box' as const,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** Header row — 3 columns (greeting 40% / spacer 20% / quote 40%). */
	headerRow: {
		display: 'flex',
		width: '100%',
		maxWidth: 1080,
		alignItems: 'flex-start',
	} as CSSProperties,

	headerLeft: {
		flex: '0 0 40%',
		minWidth: 0,
		textAlign: 'left' as const,
	} as CSSProperties,

	headerSpacer: {
		flex: '0 0 20%',
	} as CSSProperties,

	headerRight: {
		flex: '0 0 40%',
		minWidth: 0,
		textAlign: 'right' as const,
	} as CSSProperties,

	greetingTitle: {
		margin: '0 0 6px',
		fontSize: 28,
		fontWeight: 800,
		color: 'var(--rr-text-primary)',
		letterSpacing: -0.5,
	} as CSSProperties,

	greetingSub: {
		margin: 0,
		fontSize: 14,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Quote text — bold, standing out from body text. */
	quoteText: {
		margin: 0,
		fontSize: 14,
		fontWeight: 700,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.5,
	} as CSSProperties,

	/** Attribution — small italic, underneath the quote. */
	quoteAttribution: {
		margin: '4px 0 0',
		fontSize: 12,
		fontStyle: 'italic' as const,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** App grid — responsive columns, up to 3 per row. */
	grid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
		gap: 24,
		width: '100%',
		maxWidth: 1080,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The shared desktop page content: greeting, rotating quote, app-card grid.
 *
 * @param props - {@link DesktopViewProps}.
 */
export const DesktopView: React.FC<DesktopViewProps> = ({
	apps,
	onLaunch,
	greetingName,
	greetingOverride,
	showQuote = true,
	showHeader = true,
	allowRemove = true,
	resolveIcon,
	adapter: adapterProp,
	popoverBoundarySelector,
	emptyMessage = 'No apps installed. Build and deploy an app to see it here.',
	style,
}) => {
	// The adapter is built once — all server affordances flow through it.
	const adapter = useMemo(() => adapterProp ?? createShellDesktopAdapter(), [adapterProp]);
	const launch = onLaunch ?? defaultLaunch;

	// Subscription status — the shell's live view of identity.apps; an
	// adapter override wins when the host supplies one.
	const { getStatus } = useSubscriptions();
	const statusOf = adapter.getStatus ?? getStatus;

	// Greeting — picked once per mount so it stays stable through re-renders.
	const greeting = useMemo(
		() => greetingOverride ?? getGreeting(greetingName),
		[greetingOverride, greetingName],
	);

	// Rotating quote — index derives from the wall clock so it advances every
	// quote interval and is identical across clients/tabs.
	const [quoteIndex, setQuoteIndex] = useState(currentQuoteIndex);
	useEffect(() => {
		if (!showQuote) return;
		// Re-derive once a second; setState bails out while the bucket is
		// unchanged, so this re-renders only when the quote advances.
		const id = setInterval(() => setQuoteIndex(currentQuoteIndex()), 1000);
		return () => clearInterval(id);
	}, [showQuote]);
	const quote = showQuote ? DESKTOP_QUOTES[quoteIndex] : null;

	// Staggered entrance cascade. Reset only on the empty→populated
	// transition so the batch cascades in once on load; later add/remove lets
	// individual cards animate on their own mount without re-cascading.
	const reveal = useStaggerReveal(apps.length > 0 ? 'apps' : 'empty');

	return (
		<div style={{ ...S.root, ...style }}>
			{/* Header row — greeting (40%) / spacer (20%) / quote (40%) */}
			{showHeader && (
			<div style={S.headerRow}>
				<div style={S.headerLeft}>
					<h1 style={S.greetingTitle}>
						<RevealText key={greeting} text={greeting} />
					</h1>
					<p style={S.greetingSub}>
						{apps.length > 0 ? 'Select an application to launch.' : emptyMessage}
					</p>
				</div>
				<div style={S.headerSpacer} />
				<div style={S.headerRight}>
					{quote && (
						<>
							{/* Quote slightly bolder; attribution italic underneath */}
							<p style={S.quoteText}>{'“'}{quote.quote}{'”'}</p>
							<p style={S.quoteAttribution}>{quote.who} — {quote.audience}, {quote.date}</p>
						</>
					)}
				</div>
			</div>
			)}

			{/* Empty state without the header row (picker/compact surfaces). */}
			{!showHeader && apps.length === 0 && <p style={S.greetingSub}>{emptyMessage}</p>}

			{/* App grid */}
			{apps.length > 0 && (
				<div key={reveal.revealKey} style={S.grid}>
					{apps.map((app, i) => (
						<DesktopAppCard
							key={app.id}
							app={app}
							onLaunch={launch}
							adapter={adapter}
							status={statusOf(app.id)}
							allowRemove={allowRemove}
							resolveIcon={resolveIcon}
							popoverBoundarySelector={popoverBoundarySelector}
							animStyle={reveal.getItemStyle(i)}
						/>
					))}
				</div>
			)}
		</div>
	);
};

export default DesktopView;
