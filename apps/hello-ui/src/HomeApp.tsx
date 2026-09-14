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
// HELLO APP — OSS landing page and app launcher
// =============================================================================
//
// Simple landing page for OSS installations. Shows installed apps as a grid
// with GitHub stars badge, Discord link, and theme picker in the top bar.
//
// Modes (driven by identity prop):
//   identity === null  → logged-out: shows apps + Sign In button
//   identity !== null  → logged-in: shows apps + Sign Out button
// =============================================================================

import React, { useMemo, type CSSProperties } from 'react';
import { getShellApi, AppLayout } from 'shell';
import type { ShellAppProps, AppManifestEntry } from 'shell';
import GitHubStars from './GitHubStars';

// =============================================================================
// SHELL CONTRACT ACCESSOR
// =============================================================================
//
// Runtime shell access (hooks, client, connection manager) flows through the
// single curated contract accessor rather than named value imports from
// shell. Types continue to come from shell's type surface (the same
// contract types the frozen shell-api snapshot conforms to).
const { useWorkspace, ConnectionManager, getAppVersionOverride, applyAppVersionOverride } = getShellApi();

// =============================================================================
// CONSTANTS
// =============================================================================

const DISCORD_URL = 'https://discord.gg/PMXrtenMsY';

/** Honor the OS "reduce motion" setting for card hover transitions. */
const REDUCE_MOTION =
	typeof window !== 'undefined' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Category ids whose display label is not a simple capitalisation. */
const CATEGORY_LABELS: Record<string, string> = {
	ai: 'AI',
};

/** Rail rung audience types -> the display handles the drop list shows. */
const RUNG_LABEL: Record<string, string> = { user: '@me', team: '@team', public: '@public' };

// The org's developer id — fetched ONCE per document and shared by every
// card (mirrors home-ui's DesktopAppCard): the version chip's developer
// affordance keys off namespace ownership (app id inside the org's
// developer namespace), the same rule the server enforces.
let developerIdPromise: Promise<string> | null = null;

/**
 * The caller org's developer id ('' when none is claimed).
 *
 * @param client - Connected RocketRide client.
 * @returns The developer id slug, cached for the document's lifetime.
 */
function developerIdOf(client: { call: (command: string, args: Record<string, unknown>) => Promise<unknown> }): Promise<string> {
	if (!developerIdPromise) {
		developerIdPromise = client
			.call('rrext_deploy_app', { subcommand: 'developer_status' })
			.then((res) => String((res as { developerId?: string | null })?.developerId ?? ''))
			.catch(() => '');
	}
	return developerIdPromise;
}

/**
 * Format a manifest category id for display (mirrors home-ui's formatter so
 * OSS and SaaS desktops label categories identically).
 *
 * @param cat - Raw category id from the app manifest (e.g. "tools").
 * @returns Display label (e.g. "Tools").
 */
const formatCategory = (cat: string): string =>
	CATEGORY_LABELS[cat.toLowerCase()] ?? cat.charAt(0).toUpperCase() + cat.slice(1);

// =============================================================================
// MOVIE QUOTES — rotating tagline on the signed-in desktop
// =============================================================================

/** Classic movie quotes cycled in the desktop tagline. */
const QUOTES: { text: string; source: string }[] = [
	{ text: 'Frankly, my dear, I don\'t give a damn.', source: 'Gone with the Wind (1939)' },
	{ text: 'I\'m gonna make him an offer he can\'t refuse.', source: 'The Godfather (1972)' },
	{ text: 'May the Force be with you.', source: 'Star Wars (1977)' },
	{ text: 'Here\'s looking at you, kid.', source: 'Casablanca (1942)' },
	{ text: 'I\'ll be back.', source: 'The Terminator (1984)' },
	{ text: 'Toto, I\'ve a feeling we\'re not in Kansas anymore.', source: 'The Wizard of Oz (1939)' },
	{ text: 'You talking to me?', source: 'Taxi Driver (1976)' },
	{ text: 'E.T. phone home.', source: 'E.T. the Extra-Terrestrial (1982)' },
	{ text: 'Go ahead, make my day.', source: 'Sudden Impact (1983)' },
	{ text: 'Houston, we have a problem.', source: 'Apollo 13 (1995)' },
	{ text: 'Show me the money!', source: 'Jerry Maguire (1996)' },
	{ text: 'You can\'t handle the truth!', source: 'A Few Good Men (1992)' },
	{ text: 'I see dead people.', source: 'The Sixth Sense (1999)' },
	{ text: 'Here\'s Johnny!', source: 'The Shining (1980)' },
	{ text: 'My precious.', source: 'The Lord of the Rings: The Two Towers (2002)' },
	{ text: 'Life is like a box of chocolates. You never know what you\'re gonna get.', source: 'Forrest Gump (1994)' },
	{ text: 'I feel the need — the need for speed!', source: 'Top Gun (1986)' },
	{ text: 'Nobody puts Baby in a corner.', source: 'Dirty Dancing (1987)' },
	{ text: 'You\'re gonna need a bigger boat.', source: 'Jaws (1975)' },
	{ text: 'Say hello to my little friend!', source: 'Scarface (1983)' },
	{ text: 'Bond. James Bond.', source: 'Dr. No (1962)' },
	{ text: 'There\'s no place like home.', source: 'The Wizard of Oz (1939)' },
	{ text: 'I am your father.', source: 'The Empire Strikes Back (1980)' },
	{ text: 'Why so serious?', source: 'The Dark Knight (2008)' },
	{ text: 'To infinity and beyond!', source: 'Toy Story (1995)' },
	{ text: 'Keep your friends close, but your enemies closer.', source: 'The Godfather Part II (1974)' },
	{ text: 'First rule in government spending: why build one when you can have two at twice the price?', source: 'Contact (1997)' },
	{ text: 'You shall not pass!', source: 'The Lord of the Rings: The Fellowship of the Ring (2001)' },
	{ text: 'Hasta la vista, baby.', source: 'Terminator 2: Judgment Day (1991)' },
	{ text: 'I\'m the king of the world!', source: 'Titanic (1997)' },
];

/** Seconds each quote stays on screen before the rotation advances. */
const QUOTE_INTERVAL_S = 30;

/**
 * Index of the quote to show right now, derived from the wall clock:
 * every QUOTE_INTERVAL_S-second bucket maps to the next quote, so the
 * rotation is deterministic and identical across clients/tabs.
 *
 * @returns Index into {@link QUOTES}.
 */
const currentQuoteIndex = (): number =>
	Math.floor(Date.now() / (QUOTE_INTERVAL_S * 1000)) % QUOTES.length;

// =============================================================================
// GREETING — time-aware welcome, mirrored from home-ui's utils/greeting.ts
// =============================================================================

type TimeBucket = 'morning' | 'afternoon' | 'evening' | 'night';

/** Map a 0–23 hour to a part-of-day bucket. */
const getTimeBucket = (hour: number): TimeBucket => {
	if (hour >= 5 && hour < 12) return 'morning';
	if (hour >= 12 && hour < 17) return 'afternoon';
	if (hour >= 17 && hour < 22) return 'evening';
	return 'night';
};

// Greeting pools — nameless (the OSS identity is always "RocketRide", so a
// personalised greeting reads oddly). Each bucket is concatenated with the
// always-available `any` pool before a random pick, so a fraction of
// greetings are time-neutral (and launch-flavored) at any hour.
const GREETINGS: Record<TimeBucket | 'any', readonly string[]> = {
	morning: [
		'Good morning.',
		'Morning — fresh start.',
		'Rise and shine.',
		'A perfect morning for a launch.',
	],
	afternoon: [
		'Good afternoon.',
		"Hope the day's treating you well.",
		'Cruising through the afternoon.',
	],
	evening: [
		'Good evening.',
		'Winding down?',
		'Quiet evening for a flight?',
	],
	night: [
		'Burning the midnight oil?',
		'Still up?',
		'Late one tonight?',
	],
	any: [
		'Welcome back.',
		'Good to see you.',
		'Ready when you are.',
		"Let's get to it.",
		'Wanna take a ride?',
		'All systems go.',
		'Ready for liftoff?',
	],
};

/**
 * Build a greeting for the desktop page. Picks at random from the current
 * time-of-day pool combined with the time-neutral pool, so it stays fresh on
 * reload while still skewing to the local hour (mirrors home-ui's greeting).
 *
 * @returns Greeting sentence.
 */
const getGreeting = (): string => {
	const pool = [...GREETINGS[getTimeBucket(new Date().getHours())], ...GREETINGS.any];
	return pool[Math.floor(Math.random() * pool.length)];
};

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Outer container — full height, scrollable. */
	container: {
		height: '100%',
		overflow: 'auto',
		backgroundColor: 'var(--rr-bg-default)',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** Top bar with logo left, badges right. */
	topBar: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '16px 40px 0',
		height: 68,
		flexShrink: 0,
	} as CSSProperties,

	/** Logo + brand name group in the top-left. */
	brand: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		marginRight: 'auto',
	} as CSSProperties,

	/** Brand name text. */
	brandName: {
		fontSize: 22,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		letterSpacing: -0.3,
	} as CSSProperties,

	/** Centred content area. */
	centre: {
		display: 'flex',
		flexDirection: 'column' as const,
		alignItems: 'center',
		justifyContent: 'center',
		padding: '60px 40px 80px',
		gap: 32,
		minHeight: 'calc(100% - 68px)',
	} as CSSProperties,

	/** Header row — 3 columns (greeting 40% / spacer 20% / quote 40%). */
	headerRow: {
		display: 'flex',
		width: '100%',
		maxWidth: 1080,
		alignItems: 'flex-start',
	} as CSSProperties,

	/** Header column 1 (40%) — greeting + subtitle, flush left. */
	headerLeft: {
		flex: '0 0 40%',
		minWidth: 0,
		textAlign: 'left' as const,
	} as CSSProperties,

	/** Header column 2 (20%) — blank spacer. */
	headerSpacer: {
		flex: '0 0 20%',
	} as CSSProperties,

	/** Header column 3 (40%) — movie quote, flush right. */
	headerRight: {
		flex: '0 0 40%',
		minWidth: 0,
		textAlign: 'right' as const,
	} as CSSProperties,

	/** Greeting headline (matches home-ui's desktop greeting). */
	greetingTitle: {
		margin: '0 0 6px',
		fontSize: 28,
		fontWeight: 800,
		color: 'var(--rr-text-primary)',
		letterSpacing: -0.5,
	} as CSSProperties,

	/** Subtitle under the greeting. */
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

	/** Movie attribution — small italic, underneath the quote. */
	quoteSource: {
		margin: '4px 0 0',
		fontSize: 12,
		fontStyle: 'italic' as const,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** App grid — responsive columns, up to 3 per row (matches home-ui). */
	grid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
		gap: 24,
		width: '100%',
		maxWidth: 1080,
	} as CSSProperties,

	/** Individual app card — whole card is the launch target (matches home-ui).
	    Borderless by design; anchors the version popover (position relative). */
	card: {
		position: 'relative' as const,
		display: 'flex',
		flexDirection: 'column' as const,
		gap: 14,
		padding: 20,
		borderRadius: 12,
		boxSizing: 'border-box' as const,
		backgroundColor: 'var(--rr-bg-paper)',
		// No cursor/role here: the card is a plain container. The launch
		// button inside it carries the pointer and the activation.
		// transform is ALWAYS present ('none' at rest) so every hover key
		// exists in both states — React diffs the pair reliably.
		transform: 'none',
		transition: REDUCE_MOTION
			? 'none'
			: 'transform 0.12s ease, background-color 0.12s ease',
	} as CSSProperties,

	/** Card hover effect — bg shift + slight lift (unless reduced motion).
	    Overrides only keys that exist in `card` (see note there). */
	cardHover: {
		backgroundColor: 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))',
		...(REDUCE_MOTION ? {} : { transform: 'translateY(-2px)' }),
	} as CSSProperties,

	/** Top row of the card — icon chip + name/category. */
	cardHeader: {
		display: 'flex',
		flexDirection: 'row' as const,
		alignItems: 'center',
		gap: 14,
	} as CSSProperties,

	/** 52px icon chip — app icon image, or first-letter monogram fallback.
	    Borderless by design — the surface tint alone frames the icon. */
	iconChip: {
		width: 52,
		height: 52,
		flexShrink: 0,
		borderRadius: 12,
		overflow: 'hidden',
		backgroundColor: 'var(--rr-bg-surface-alt)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-brand)',
		fontSize: 22,
		fontWeight: 800,
	} as CSSProperties,

	/** App icon image inside the chip. */
	iconImg: {
		width: '100%',
		height: '100%',
		objectFit: 'cover' as const,
	} as CSSProperties,

	/** Name + category column — ellipsizes next to the fixed-width chip. */
	nameWrap: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	/** App name in the card. */
	appName: {
		margin: 0,
		fontSize: 16,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		whiteSpace: 'nowrap' as const,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	} as CSSProperties,

	/** Category sublabel under the app name. */
	appCategory: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		marginTop: 2,
		whiteSpace: 'nowrap' as const,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	} as CSSProperties,

	/** App description — full width below the header row, clamped to 2 lines. */
	appDesc: {
		margin: 0,
		fontSize: 14,
		lineHeight: 1.45,
		color: 'var(--rr-text-secondary)',
		display: '-webkit-box',
		WebkitLineClamp: 2,
		WebkitBoxOrient: 'vertical' as const,
		overflow: 'hidden',
	} as CSSProperties,

	/** The launch control — a bare button covering the card.

	    The CARD is not the control: a role="button" card would make the
	    version chip an interactive descendant of a button, which assistive
	    technologies expose incorrectly. This overlay keeps the launch target
	    the size of the whole card while the chip stays a SIBLING control,
	    and it leaves the heading/description markup untouched (a button may
	    not contain flow content either). */
	launch: {
		position: 'absolute' as const,
		inset: 0,
		zIndex: 0,
		margin: 0,
		padding: 0,
		border: 'none',
		borderRadius: 12,
		backgroundColor: 'transparent',
		cursor: 'pointer',
	} as CSSProperties,

	/** Bottom row of the card — hosts the version chip, pinned bottom-left.
	    Raised above the launch overlay so the chip takes its own clicks. */
	versionRow: {
		display: 'flex',
		alignItems: 'center',
		marginTop: 'auto',
		position: 'relative' as const,
		zIndex: 1,
	} as CSSProperties,

	/** Faint version chip — click opens the version drop list. */
	versionChip: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 4,
		padding: 0,
		border: 'none',
		backgroundColor: 'transparent',
		color: 'var(--rr-text-secondary)',
		opacity: 0.65,
		fontSize: 11,
		fontWeight: 500,
		fontFamily: 'inherit',
		cursor: 'pointer',
	} as CSSProperties,

	/** Developer variant: BUTTON-shaped — the chip is the org's rail door. */
	versionChipDeveloper: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 4,
		padding: '3px 9px',
		borderRadius: 6,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'transparent',
		color: 'var(--rr-text-secondary)',
		opacity: 1,
		fontSize: 11,
		fontWeight: 500,
		fontFamily: 'inherit',
		cursor: 'pointer',
	} as CSSProperties,

	/** Version drop list — popover anchored above the chip. */
	versionPopover: {
		position: 'absolute' as const,
		left: 16,
		bottom: 44,
		zIndex: 10,
		minWidth: 230,
		padding: '6px 0',
		borderRadius: 10,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-paper)',
		boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
	} as CSSProperties,

	/** One selectable version row inside the drop list. */
	versionItem: {
		display: 'flex',
		alignItems: 'baseline',
		gap: 8,
		width: '100%',
		padding: '7px 14px',
		border: 'none',
		borderRadius: 0,
		backgroundColor: 'transparent',
		color: 'var(--rr-text-primary)',
		fontSize: 12.5,
		fontWeight: 600,
		fontFamily: 'inherit',
		textAlign: 'left' as const,
		cursor: 'pointer',
		boxSizing: 'border-box' as const,
	} as CSSProperties,

	/** Rung provenance label beside the version number. */
	versionItemRung: {
		fontSize: 11,
		fontWeight: 400,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Current-version marker, right-aligned in its row. */
	versionItemMark: {
		marginLeft: 'auto',
		fontSize: 10,
		fontWeight: 600,
		textTransform: 'uppercase' as const,
		letterSpacing: 0.5,
		color: 'var(--rr-brand)',
	} as CSSProperties,

	/** Non-interactive hint row at the bottom of the drop list. */
	versionHint: {
		padding: '7px 14px 4px',
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Failure row in the drop list — a version pick that could not launch. */
	versionError: {
		padding: '7px 14px 4px',
		fontSize: 11,
		color: 'var(--rr-color-error)',
	} as CSSProperties,

	/** Sign In / Sign Out button. */
	authBtn: {
		padding: '7px 20px',
		borderRadius: 6,
		border: 'none',
		backgroundColor: 'var(--rr-brand)',
		color: '#fff',
		fontSize: 14,
		fontWeight: 600,
		cursor: 'pointer',
	} as CSSProperties,

	/** Sign Out button (secondary style). */
	signOutBtn: {
		padding: '7px 16px',
		borderRadius: 6,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'transparent',
		color: 'var(--rr-text-secondary)',
		fontSize: 14,
		fontWeight: 500,
		cursor: 'pointer',
	} as CSSProperties,

	/** Top bar link button (Discord, etc). */
	linkBtn: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '7px 14px',
		borderRadius: 6,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'transparent',
		color: 'var(--rr-text-secondary)',
		fontSize: 13,
		fontWeight: 500,
		textDecoration: 'none',
		cursor: 'pointer',
	} as CSSProperties,

	/** Sliding sun/moon theme toggle track (same control as home-ui). */
	themeToggle: {
		position: 'relative' as const,
		boxSizing: 'border-box' as const,
		width: 52,
		height: 28,
		borderRadius: 14,
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-surface-alt)',
		cursor: 'pointer',
		padding: 0,
		flexShrink: 0,
		transition: 'background 0.3s ease',
	} as CSSProperties,

	/** White knob that slides between the moon (left) / sun (right) positions. */
	themeKnob: {
		position: 'absolute' as const,
		top: 3,
		left: 3,
		width: 22,
		height: 22,
		borderRadius: '50%',
		backgroundColor: '#ffffff',
		boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
		transition: 'transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		color: '#475569', // slate-600 — icon on the always-white knob
	} as CSSProperties,
};

// =============================================================================
// THEME TOGGLE
// =============================================================================

/**
 * Sliding sun/moon theme toggle — the same control home-ui uses. Binary:
 * dark ('rocketride') <-> light ('rocketride-light'). Also persists the mode
 * to rr:home:theme, which the shell reads for its boot-time default theme.
 *
 * @param props.theme - The currently active theme id.
 * @param props.onSetTheme - Applies a theme id (useWorkspace().setTheme).
 */
const ThemeToggle: React.FC<{ theme: string; onSetTheme: (id: string) => void }> = ({ theme, onSetTheme }) => {
	// Any theme other than the light variants counts as dark for the toggle.
	const isDark = theme !== 'rocketride-light' && theme !== 'light';

	/** Flip between the light/dark brand themes and persist the mode. */
	const toggle = () => {
		const mode = isDark ? 'light' : 'dark';
		onSetTheme(mode === 'dark' ? 'rocketride' : 'rocketride-light');
		try { localStorage.setItem('rr:home:theme', mode); } catch { /* storage unavailable */ }
	};

	return (
		<button
			type="button"
			role="switch"
			aria-checked={!isDark}
			aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
			onClick={toggle}
			style={styles.themeToggle}
		>
			{/* Knob slides right in light mode (same geometry as home-ui: 24px travel) */}
			<span style={{ ...styles.themeKnob, transform: `translateX(${isDark ? 0 : 24}px)` }}>
				{isDark ? (
					// Moon icon
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
					</svg>
				) : (
					// Sun icon
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="12" cy="12" r="4" />
						<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
					</svg>
				)}
			</span>
		</button>
	);
};

// =============================================================================
// APP CARD
// =============================================================================

/** One deduplicated row of the version drop list. */
interface VersionRow {
	/** Registry version number (the launch key — monotonic, never semver-compared). */
	registryVersion: number;
	/** Artifact semver for display. */
	appVersion: string;
	/** Rung handles pinning this version (e.g. '@team/Development'). */
	handles: string[];
}

/**
 * Single desktop app card — mirrors home-ui's DesktopAppCard pattern: hover
 * state lives locally in each card (not in the parent grid), the arrangement
 * proven stable on the SaaS desktop. The whole card is the launch target.
 *
 * A version chip sits bottom-left (BUTTON-shaped for the app's developer
 * org — the chip is their rail door); clicking it opens a drop list of the
 * servable versions the rail verb answers by role. Picking one is a
 * SESSION override (numbers only — the load URL is constructed): repoint
 * when the container has not loaded yet, full reload otherwise.
 *
 * @param props.app - Manifest entry to render.
 * @param props.onLaunch - Invoked with the app when the card is activated.
 */
const AppCard: React.FC<{ app: AppManifestEntry; onLaunch: (app: AppManifestEntry) => void }> = ({ app, onLaunch }) => {
	// Local hover state — per-card, like home-ui's DesktopAppCard
	const [hover, setHover] = React.useState(false);
	// Version drop list — rows load lazily on first open
	const [versionsOpen, setVersionsOpen] = React.useState(false);
	const [versionRows, setVersionRows] = React.useState<VersionRow[] | null>(null);
	// A failed version pick renders inline in the popover — a silent close
	// reads as "the click did nothing".
	const [versionError, setVersionError] = React.useState<string | null>(null);
	// Bumped after select/reset so the chip re-reads the session override
	const [overrideSeq, setOverrideSeq] = React.useState(0);
	const popoverRef = React.useRef<HTMLDivElement>(null);

	// First manifest category, formatted for display (may be absent)
	const category = app.categories?.[0] ? formatCategory(app.categories[0]) : null;

	// Effective version label — live dev build > session override > manifest.
	// Bare semver by default; an override shows the OVERRIDDEN version's
	// semver plus its registry number ("0.1.0 v6").
	// eslint-disable-next-line react-hooks/exhaustive-deps -- overrideSeq forces the re-read after select/reset
	const override = React.useMemo(() => getAppVersionOverride(app.id), [app.id, overrideSeq]);
	const versionLabel = app.dev
		? 'dev'
		: override
			? `${override.appVersion ? `${override.appVersion} ` : ''}v${override.version}`
			: (app.version ?? '');

	// Developer affordance: when the app id lives inside the caller org's
	// developer namespace, the chip renders as a button and the drop list is
	// the org's rail door (the server answers the rail verb by role).
	const [developerId, setDeveloperId] = React.useState('');
	React.useEffect(() => {
		let alive = true;
		const client = ConnectionManager.getInstance().getClient();
		if (!client) return;
		void developerIdOf(client).then((id) => { if (alive) setDeveloperId(id); });
		return () => { alive = false; };
	}, []);
	const isDeveloper = !!developerId && app.id.startsWith(`${developerId}.`);

	// Close the drop list on outside click (mirrors home-ui's popover)
	React.useEffect(() => {
		if (!versionsOpen) return;
		const handler = (e: MouseEvent) => {
			if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
				setVersionsOpen(false);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [versionsOpen]);

	/** Toggle the drop list; fetch the servable versions on first open. The
	 * rail verb answers by role — the developer org sees its FULL rail
	 * (published or not), everyone else their caller-visible versions. */
	const toggleVersions = async (e: React.SyntheticEvent) => {
		e.stopPropagation();
		setVersionsOpen((v) => !v);
		setVersionError(null);
		if (versionRows !== null) return;
		try {
			const client = ConnectionManager.getInstance().getClient();
			if (!client) { setVersionRows([]); return; }
			const rail = await client.listDeployments(app.id);
			// Built versions only — an unbuilt row has no servable bytes.
			const rows = rail
				.filter((r) => r.buildStatus === 'ok')
				.map((r) => ({
					registryVersion: r.registryVersion,
					appVersion: r.appVersion,
					handles: r.rungs?.length
						? [...new Set(r.rungs.map((rung) => RUNG_LABEL[rung] ?? rung))].concat(r.state === 'submit' ? ['in review'] : [])
						: [r.state === 'submit' ? 'in review' : 'unpublished'],
				}))
				.sort((a, b) => b.registryVersion - a.registryVersion);
			setVersionRows(rows);
		} catch {
			// Unauthenticated or no registry — the chip still shows the current version
			setVersionRows([]);
		}
	};

	/** Launch a specific version: apply the session override (numbers only —
	 * the load URL is constructed client-side; entitlement is enforced by
	 * the serve route at fetch time, so there is nothing to mint or await). */
	const selectVersion = (e: React.SyntheticEvent, row: VersionRow) => {
		e.stopPropagation();
		const result = applyAppVersionOverride(app.id, app.moduleId, {
			version: row.registryVersion,
			appVersion: row.appVersion,
		});
		setVersionsOpen(false);
		setOverrideSeq((n) => n + 1);
		// A loaded container cannot be repointed — reboot registers the
		// override before anything loads; otherwise launch right away.
		if (result === 'reload-required') { window.location.reload(); return; }
		onLaunch(app);
	};

	/** Drop the session override — back to the server's default resolution. */
	const resetVersion = (e: React.SyntheticEvent) => {
		e.stopPropagation();
		const result = applyAppVersionOverride(app.id, app.moduleId, null);
		setVersionError(null);
		setVersionsOpen(false);
		setOverrideSeq((n) => n + 1);
		if (result === 'reload-required') window.location.reload();
	};

	return (
		<div
			style={{ ...styles.card, ...(hover ? styles.cardHover : {}) }}
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
		>
			{/* Launch control — a sibling of the version chip, not its
			    ancestor: the card itself is inert, this overlay carries the
			    activation over the card's whole area. */}
			<button type="button" style={styles.launch} aria-label={`Open ${app.name}`} onClick={() => onLaunch(app)} />

			{/* Top row — icon chip + name/category */}
			<div style={styles.cardHeader}>
				<div style={styles.iconChip}>
					{app.icon
						? <img src={app.icon} alt="" loading="lazy" decoding="async" style={styles.iconImg} />
						: app.name[0]}
				</div>
				<div style={styles.nameWrap}>
					<h2 style={styles.appName}>{app.name}</h2>
					{category && <div style={styles.appCategory}>{category}</div>}
				</div>
			</div>

			{/* Description — full width below the header row */}
			<p style={styles.appDesc}>
				{app.description || 'No description'}
			</p>

			{/* Version chip — bottom-left, faint; opens the drop list */}
			{versionLabel && (
				<div style={styles.versionRow}>
					<button
						type="button"
						style={isDeveloper ? styles.versionChipDeveloper : styles.versionChip}
						title="Switch version"
						aria-haspopup="listbox"
						aria-expanded={versionsOpen}
						onClick={toggleVersions}
						onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
					>
						{versionLabel}
					</button>
				</div>
			)}

			{/* Version drop list */}
			{versionsOpen && (
				<div ref={popoverRef} style={styles.versionPopover} role="listbox" onClick={(e) => e.stopPropagation()}>
					{versionError && <div style={styles.versionError}>{versionError}</div>}
					{versionRows === null && <div style={styles.versionHint}>Loading versions…</div>}
					{versionRows !== null && versionRows.length === 0 && (
						<div style={styles.versionHint}>No other versions available</div>
					)}
					{versionRows !== null && versionRows.map((row) => {
						// Match on the registry version (the wire identity), never
						// the display semver — two registry records can share one
						// appVersion, which would light both rows as current. The
						// manifest carries the resolved default's registry number,
						// so the current row is knowable with or without an override.
						const isCurrent = row.registryVersion === (override?.version ?? app.registryVersion);
						return (
							<button
								key={row.registryVersion}
								type="button"
								role="option"
								aria-selected={isCurrent}
								style={styles.versionItem}
								onClick={(e) => selectVersion(e, row)}
							>
								{row.appVersion ? `${row.appVersion} ` : ''}v{row.registryVersion}
								<span style={styles.versionItemRung}>{row.handles.join(' · ')}</span>
								{isCurrent && <span style={styles.versionItemMark}>current</span>}
							</button>
						);
					})}
					{override && (
						<button type="button" style={styles.versionItem} onClick={resetVersion}>
							Reset to default
						</button>
					)}
					{versionRows !== null && versionRows.length > 0 && (
						<div style={styles.versionHint}>Session only — clears when this tab closes</div>
					)}
				</div>
			)}
		</div>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * OSS landing page — shows installed apps as a centered card grid with
 * GitHub stars, Discord link, and theme picker in the top bar.
 *
 * @param props.identity - ConnectResult when logged in, null when not.
 */
const HomeApp: React.FC<ShellAppProps> = ({ identity }) => {
	const cm = ConnectionManager.getInstance();
	const { appManifest, prefs, setTheme } = useWorkspace();

	// The unauthenticated home owns its look (mirrors saas home-ui's
	// applyThemeMode ownership): re-assert the anonymous default — the
	// rr:home:theme mode if the visitor ever toggled, else the brand light
	// theme — so signing out doesn't leave the previous user's workspace
	// theme painted on the logged-out screen. Authenticated visits are left
	// alone: the workspace restores the account's own theme.
	React.useEffect(() => {
		if (identity) return;
		let mode: string | null = null;
		try { mode = localStorage.getItem('rr:home:theme'); } catch { /* storage unavailable */ }
		const target = mode === 'dark' ? 'rocketride' : 'rocketride-light';
		if (prefs.theme !== target) setTheme(target);
	}, [identity, prefs.theme, setTheme]);

	// Filter out this app from the list — don't show ourselves
	const apps = useMemo(
		() => appManifest
			.filter((a) => a.id !== 'rocketride.hello')
			.sort((a, b) => a.name.localeCompare(b.name)),
		[appManifest],
	);

	/** Launch an app by switching to it in the workspace. */
	const handleLaunch = (app: AppManifestEntry) => {
		cm.emit('shell:switchApp', { appId: app.id });
	};

	// Greeting \u2014 time-aware, picked once per mount so it stays stable
	// through re-renders (mirrors home-ui's desktop).
	const greeting = useMemo(() => getGreeting(), []);

	// Rotating movie quote \u2014 index derives from the user's clock so it
	// advances every QUOTE_INTERVAL_S seconds (see currentQuoteIndex).
	const [quoteIndex, setQuoteIndex] = React.useState(currentQuoteIndex);
	React.useEffect(() => {
		// Re-derive once a second; setState bails out while the 30s bucket
		// (QUOTE_INTERVAL_S) is unchanged, so this re-renders only when the
		// quote advances.
		const id = setInterval(() => setQuoteIndex(currentQuoteIndex()), 1000);
		return () => clearInterval(id);
	}, []);
	const quote = identity ? QUOTES[quoteIndex] : null;

	return (
		// One-column app (no sidebar) with the status bar on.
		<AppLayout showStatus>
		<div style={styles.container}>
			{/* Top bar */}
			<div style={styles.topBar}>
				{/* Brand logo */}
				<div style={styles.brand}>
					<svg width="36" height="36" viewBox="0 0 191 192" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block', flexShrink: 0 }}>
						<path d="M159.5 161.424L153.7 167.224C151.9 169.024 148.9 169.024 147 167.224L126.6 146.824C115.6 135.824 115.6 118.024 126.6 107.024C138.1 95.5245 138.1 76.9245 126.6 65.4245L125.1 63.9245C113.6 52.4245 95 52.4245 83.5 63.9245C72.5 74.9245 54.6 74.9245 43.6 63.9245L23.2 43.5245C21.4 41.7245 21.4 38.7245 23.2 36.8245L29 31.0245C37 23.0245 49.1 20.5245 59.6 24.9245L87.5 36.3245C97.3 40.1245 108.4 38.0245 116.3 31.1245L137 10.4245C138.6 8.92449 140.4 7.42449 142.5 6.22449C146.2 4.12449 150.3 3.02449 154.5 2.62449L185.4 0.0244895C188.3 -0.275511 190.8 2.22449 190.5 5.12449L187.8 36.4245C187.3 42.8245 184.5 48.8245 180.1 53.5245L160.5 73.1245C152.5 81.2245 150.1 93.3245 154.5 103.824L155.5 106.224L161.2 120.024L165.6 130.924C169.9 141.424 167.5 153.524 159.5 161.524V161.424Z" fill="currentColor" fillOpacity={0.85} />
						<path d="M0.799997 190.325C-0.200003 189.325 -0.300003 187.625 0.599997 186.425L21.1 162.024C31.1 150.024 37.9 137.725 41.3 125.325C43.6 116.625 44.6 108.525 44.1 101.225C44.1 100.325 44.4 99.4245 45.1 98.8245C45.8 98.2245 46.8 97.9245 47.7 98.1245C65 101.625 83.5 98.3245 98.5 88.9245C99.6 88.2245 101.1 88.4245 102 89.3245C102.9 90.2245 103.1 91.7245 102.4 92.8245C93 107.825 89.7 126.325 93.2 143.525C93.4 144.325 93.2 145.225 92.6 145.925C92 146.625 91 147.225 90.1 147.125C82.8 146.625 74.6 147.525 66 149.925C53.6 153.225 41.2 160.025 29.3 170.125L4.9 190.625C3.8 191.525 2.1 191.525 0.999997 190.425H0.799997V190.325Z" fill="#F93822" />
					</svg>
					<span style={styles.brandName}>RocketRide</span>
				</div>

				{/* GitHub stars */}
				<GitHubStars />

				{/* Discord */}
				<a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" style={styles.linkBtn}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
						<path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
					</svg>
					Discord
				</a>

				{/* Theme toggle — sliding sun/moon pill, same control as home-ui */}
				<ThemeToggle theme={prefs.theme} onSetTheme={setTheme} />

				{/* Auth button */}
				{identity ? (
					<button
						style={styles.signOutBtn}
						onClick={() => cm.emit('shell:logoutRequest', {})}
					>
						Sign Out
					</button>
				) : (
					<button
						style={styles.authBtn}
						onClick={() => cm.emit('shell:loginRequest', {})}
					>
						Sign In
					</button>
				)}
			</div>

			{/* Content */}
			<div style={styles.centre}>
				{/* Header row — greeting (40%) / blank spacer (20%) / movie quote (40%) */}
				<div style={styles.headerRow}>
					<div style={styles.headerLeft}>
						<h1 style={styles.greetingTitle}>{identity ? greeting : 'Welcome to RocketRide'}</h1>
						<p style={styles.greetingSub}>Select an application to launch.</p>
					</div>
					<div style={styles.headerSpacer} />
					<div style={styles.headerRight}>
						{quote && (
							<>
								{/* Quote slightly bolder; attribution italic underneath */}
								<p style={styles.quoteText}>{'“'}{quote.text}{'”'}</p>
								<p style={styles.quoteSource}>— {quote.source}</p>
							</>
						)}
					</div>
				</div>

				{apps.length > 0 ? (
					<div style={styles.grid}>
						{apps.map((app) => (
							<AppCard key={app.id} app={app} onLaunch={handleLaunch} />
						))}
					</div>
				) : (
					<p style={styles.greetingSub}>
						No apps installed. Build and deploy an app to see it here.
					</p>
				)}
			</div>
		</div>
		</AppLayout>
	);
};

export default HomeApp;
