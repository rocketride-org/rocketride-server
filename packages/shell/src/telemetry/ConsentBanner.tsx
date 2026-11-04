// MIT License - Copyright (c) 2026 Aparavi Software AG
//
// The consent banner. Our own record (rr:consent) decides what it shows;
// PostHog's flag is never consulted. A fixed overlay (no layout shift, never
// any page padding), mounted once the page has settled (never the LCP
// element), non-blocking. Desktop and tablet: a compact toast in a bottom
// corner; phones: a slim bar at the bottom. Where it sits is measured
// (placement.ts): it never covers what the page marks data-rr-keep-clear (the
// hero terminal, the hero's actions, the hero art on wide screens, the
// footer's Privacy settings link) and waits for a clear spot when there is
// none yet; the open mobile menu sits above it. "No thanks" and "Opt in" are
// equal, real buttons. Built on the landing theme tokens: the nav dropdown's
// floating surface and the nav's Sign in and Get Started buttons. Reopened
// from the footer's "Privacy settings" link, where the current choice is
// shown and can be changed; "No thanks" there withdraws an opt-in. With a
// browser privacy signal on (Do Not Track, Global Privacy Control) it says
// nothing is recorded and "Opt in" is disabled. A toast narrowed below
// COMPACT_BELOW carries the short phone copy.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { decideConsent, getConsentState, subscribeConsent, withdrawConsent } from './consentState';
import { consentPromptNeeded, trackConsentShown } from './host';
import { privacySignalOn } from 'rocketride/analytics';
import { onOpenConsentBanner, takePendingOpen } from './consentUi';
import type { ConsentState } from './consent';

// Self-contained look: the exact token values of home-ui's marketing palette
// (utils/themeTokens.ts) for the 7 fields the banner reads — the banner is a
// legal surface and must look identical after the move; a cross-repo import
// is not possible and the shell's --rr-* variables are a different palette.
type Theme = 'light' | 'dark';
const FONT_DISPLAY = "'Poppins', 'Poppins Fallback', sans-serif";
const TOKENS: Record<Theme, { textPri: string; textSec: string; navBorder: string; navDropdownBg: string; navSignInBorder: string; ctaBg: string; ctaText: string }> = {
	dark: {
		textPri: '#ffffff',
		textSec: 'rgba(255,255,255,0.55)',
		navBorder: 'rgba(255,255,255,0.10)',
		navDropdownBg: '#16141e',
		navSignInBorder: 'rgba(255,255,255,0.15)',
		ctaBg: '#f0efe9',
		ctaText: '#0a0a0a',
	},
	light: {
		textPri: '#0a0a0a',
		textSec: 'rgba(10,10,10,0.55)',
		navBorder: 'rgba(0,0,0,0.08)',
		navDropdownBg: '#f8f7f3',
		navSignInBorder: 'rgba(0,0,0,0.15)',
		ctaBg: '#0a0a0a',
		ctaText: '#f5f4f0',
	},
};
import { PHONE_MARGIN, compactCopy, nextPlacement, onScreen, placementLabel, positionFor, samePlacement, variantFor, type Obstacles, type Placement, type Rect, type Variant } from './placement';

/** The privacy policy the banner links to. */
export const PRIVACY_POLICY_PATH = '/legal/privacy-policy';

/** The approved copy (2026-10-10), verbatim. */
export const COPY = {
	heading: 'Help us craft a better RocketRide',
	body: "Opt in and we'll use cookies and session recordings to see how people move through the site, what lands and what doesn't, so we can keep refining it. We never record what you type, and you can change your mind anytime in Privacy settings.",
	phone: 'Help us craft a better RocketRide. Opt in to cookies and session recordings (we never record what you type).',
	link: 'Privacy policy',
	decline: 'No thanks',
	accept: 'Opt in',
};

/** The current choice, shown when the banner is reopened from "Privacy settings". */
export const STATUS = {
	accepted: "You're currently opted in.",
	rejected: "You're currently opted out.",
};

/** Shown instead of the choice when a browser privacy signal is on: nothing is captured, whatever was chosen. */
export const SIGNAL_STATUS = "Your browser's privacy signal is on, so nothing is recorded.";

/**
 * What the banner may not cover, on screen now: every element marked data-rr-keep-clear ("wide" ones not
 * on phones), and among them the ones marked "always" (kept clear also once shown, while the page scrolls).
 *
 * @param variant The viewport's variant.
 * @returns Both sets, clipped to the viewport.
 */
function keepClear(variant: Variant): Obstacles {
	const all: Rect[] = [];
	const always: Rect[] = [];
	document.querySelectorAll('[data-rr-keep-clear]').forEach((el) => {
		const kind = el.getAttribute('data-rr-keep-clear');
		if (variant === 'phone' && kind === 'wide') {
			return;
		}
		const b = el.getBoundingClientRect();
		if (b.width <= 0 || b.height <= 0) {
			return;
		}
		const rect = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
		all.push(rect);
		if (kind === 'always') {
			always.push(rect);
		}
	});
	const view = { width: window.innerWidth, height: window.innerHeight };
	return { all: onScreen(view, all), always: onScreen(view, always) };
}

/**
 * Runs `decide` with a heightAt that measures the toast at a width with the copy that width carries (a
 * narrow toast gets the short phone copy), then puts the node's width and copies back as they were.
 *
 * @param node   The banner.
 * @param decide What needs the measurements.
 * @returns What `decide` returns.
 */
function measuringToast<T>(node: HTMLElement, decide: (heightAt: (width: number) => number) => T): T {
	const width = node.style.width;
	const full = node.querySelector<HTMLElement>('[data-rr-consent-full]');
	const short = node.querySelector<HTMLElement>('[data-rr-consent-compact]');
	const fullDisplay = full?.style.display ?? '';
	const shortDisplay = short?.style.display ?? '';
	const result = decide((w) => {
		return toastHeightAt(node, full, short, w);
	});
	node.style.width = width;
	if (full) {
		full.style.display = fullDisplay;
	}
	if (short) {
		short.style.display = shortDisplay;
	}
	return result;
}

/**
 * The toast's height at a width, with the copy that width carries; leaves the node at that width.
 *
 * @param node  The banner.
 * @param full  The heading and body, if rendered.
 * @param short The short phone copy, if rendered.
 * @param width The width to measure at (px).
 * @returns The banner's height (px).
 */
function toastHeightAt(node: HTMLElement, full: HTMLElement | null, short: HTMLElement | null, width: number): number {
	let fullDisplay = '';
	let shortDisplay = 'none';
	if (compactCopy('toast', width)) {
		fullDisplay = 'none';
		shortDisplay = '';
	}
	node.style.width = `${width}px`;
	if (full) {
		full.style.display = fullDisplay;
	}
	if (short) {
		short.style.display = shortDisplay;
	}
	return node.offsetHeight;
}

/**
 * Whether the visitor asked for reduced motion: the banner then appears without its fade and rise.
 *
 * @returns True under prefers-reduced-motion: reduce.
 */
function prefersReducedMotion(): boolean {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type Props = {
	/** The prompt only concerns the signed-out site; a reopen from "Privacy settings" works on every surface. */
	signedOut: boolean;
	/**
	 * The chrome under the banner: marketing pages render light chrome
	 * regardless of the account theme, so 'light' is the default; the host
	 * passes 'dark' only where the surface underneath actually is.
	 */
	theme?: Theme;
};

/**
 * The consent prompt and its "Privacy settings" reopen (see the file header for the layout rules).
 * Shows the prompt to an undecided, signed-out visitor; a reopen shows the current choice on any
 * surface. Records the choice through the analytics consent API and reports consent:shown once.
 *
 * @param props.signedOut Whether the page under it is a signed-out surface (the prompt shows only there).
 */
export const ConsentBanner: React.FC<Props> = ({ signedOut, theme = 'light' }) => {
	// A browser privacy signal: nothing is captured, so the reopened banner says so and offers no opt-in.
	const [isPrivacySignalOn] = useState(() => {
		return privacySignalOn();
	});
	const [isReady, setIsReady] = useState(false);         // after the page settled
	const [isOpen, setIsOpen] = useState(false);           // reopened from the footer link
	const [state, setState] = useState<ConsentState>(() => {
		return getConsentState();
	});
	const [isPrompting, setIsPrompting] = useState(false); // an undecided visitor is asked
	const [variant, setVariant] = useState<Variant>(() => {
		return variantFor({ width: window.innerWidth, height: window.innerHeight });
	});
	const [placement, setPlacement] = useState<Placement | null>(null);
	const [hasEntered, setHasEntered] = useState(false);
	const ref = useRef<HTMLElement | null>(null);
	const placementRef = useRef<Placement | null>(null);
	const shownRef = useRef(false);

	/** Opens the banner from the footer's "Privacy settings" link, with the current choice shown. */
	const openFromSettings = useCallback((): void => {
		setState(getConsentState());
		setIsOpen(true);
		setIsReady(true);
	}, []);

	// Mounted by HomeApp's host once the page settled (a lazy chunk), so the prompt decision happens at mount.
	useEffect(() => {
		setIsReady(true);
		setIsPrompting(consentPromptNeeded());
	}, []);
	// A decision in this tab closes the prompt; another tab's withdrawal (origin external) reopens it, a decision there closes it.
	useEffect(() => {
		return subscribeConsent((s, origin) => {
			setState(s);
			setIsPrompting(s === 'undecided' && origin === 'external');
		});
	}, []);
	useEffect(() => {
		return onOpenConsentBanner(() => {
			takePendingOpen();
			openFromSettings();
		});
	}, [openFromSettings]);
	// A "Privacy settings" click before this lazy chunk mounted: open now.
	useEffect(() => {
		if (takePendingOpen()) {
			openFromSettings();
		}
	}, [openFromSettings]);

	// The prompt is for the signed-out site; a reopen from "Privacy settings" works signed in too.
	const isWanted = isReady && ((signedOut && isPrompting) || isOpen);

	/** The viewport the current placement was measured for: a new size means a new first placement. */
	const placedViewRef = useRef('');

	/**
	 * Measure, ask nextPlacement (placement.ts) where the banner goes, and apply the answer. The decision is pure and
	 * unit-tested; this side only measures the banner and the obstacles and sets the state.
	 */
	const place = useCallback((): void => {
		const node = ref.current;
		if (!node) {
			return;
		}
		const view = { width: window.innerWidth, height: window.innerHeight };
		const viewKey = `${view.width}x${view.height}`;
		const nextVariant = variantFor(view);
		const height = node.offsetHeight;
		const decision = measuringToast(node, (heightAt) => {
			return nextPlacement({
				current: placementRef.current,
				isSameView: placedViewRef.current === viewKey,
				view,
				obstacles: keepClear(nextVariant),
				height,
				heightAt,
			});
		});
		if (nextVariant !== variant) {
			setVariant(nextVariant);
		}
		if (decision === 'keep') {
			return;
		}
		if (decision !== null) {
			placedViewRef.current = viewKey;
		}
		if (!samePlacement(decision, placementRef.current)) {
			placementRef.current = decision;
			setPlacement(decision);
		}
	}, [variant]);

	// First placement (measured while hidden), then again whenever the page scrolls or the window resizes.
	useLayoutEffect(() => {
		if (!isWanted) {
			placementRef.current = null;
			setPlacement(null);
			setHasEntered(false);
			return;
		}
		place();
		let frame = 0;
		const schedule = (): void => {
			if (frame) {
				return;
			}
			frame = window.requestAnimationFrame(() => {
				frame = 0;
				place();
			});
		};
		document.addEventListener('scroll', schedule, { capture: true, passive: true });
		window.addEventListener('resize', schedule, { passive: true });
		return () => {
			document.removeEventListener('scroll', schedule, { capture: true });
			window.removeEventListener('resize', schedule);
			if (frame) {
				window.cancelAnimationFrame(frame);
			}
		};
	}, [isWanted, place]);

	const isVisible = isWanted && placement !== null;

	// Entrance: opacity and transform only, after the first placed frame; none under reduced motion.
	useEffect(() => {
		if (!isVisible || hasEntered) {
			return;
		}
		if (prefersReducedMotion()) {
			setHasEntered(true);
			return;
		}
		const frame = window.requestAnimationFrame(() => {
			setHasEntered(true);
		});
		return () => {
			window.cancelAnimationFrame(frame);
		};
	}, [isVisible, hasEntered]);

	// consent:shown counts the prompt (an undecided visitor) once it is on screen, never a reopen from the footer.
	useEffect(() => {
		if (!isVisible || !isPrompting || shownRef.current) {
			return;
		}
		shownRef.current = true;
		trackConsentShown();
	}, [isVisible, isPrompting]);

	const close = useCallback((): void => {
		setIsOpen(false);
		setIsPrompting(false);
	}, []);
	const accept = useCallback((): void => {
		decideConsent('accepted');
		close();
	}, [close]);
	// A plain decline, or from accepted a withdrawal (the consented instance is torn down, PostHog's storage is cleared, the
	// decline is kept).
	const decline = useCallback((): void => {
		withdrawConsent();
		close();
	}, [close]);

	if (!isWanted) {
		return null;
	}
	const t = TOKENS[theme];
	const isPhone = variant === 'phone';
	// the phone bar and a toast narrower than COMPACT_BELOW carry the short phone copy
	const isCompact = isPhone || (placement !== null && placement.variant === 'toast' && compactCopy('toast', placement.width));
	const isReopened = isOpen && !isPrompting;
	const isAnimated = !prefersReducedMotion();
	const position = positionFor(placement, isPhone);

	let padding = 16;
	let buttonHeight = 40;
	if (isPhone) {
		padding = 12;
		buttonHeight = 44;
	}
	// the bar rises above the footer link by a transform: moving it is not a layout shift
	let lift = 0;
	if (placement !== null && placement.variant === 'phone') {
		lift = placement.bottom - PHONE_MARGIN;
	}
	// hidden while it is measured or waits for a clear spot: not seen, not focusable, not read
	let visibility: 'hidden' | 'visible' = 'visible';
	if (placement === null) {
		visibility = 'hidden';
	}
	let opacity = 0;
	let rise = 8;
	if (hasEntered) {
		opacity = 1;
		rise = 0;
	}
	let transition = 'none';
	if (isAnimated) {
		transition = 'opacity 200ms ease-out, transform 200ms ease-out';
	}
	// room for the close button, shown only when reopened
	let closeRoom = 0;
	if (isReopened) {
		closeRoom = 28;
	}
	// both copies are rendered; the one not in use is display: none (not seen, not read, not focusable)
	let compactDisplay: 'none' | undefined = 'none';
	let fullDisplay: 'none' | undefined;
	if (isCompact) {
		compactDisplay = undefined;
		fullDisplay = 'none';
	}

	const button: React.CSSProperties = {
		flex: '1 1 0', minWidth: 0, minHeight: buttonHeight, boxSizing: 'border-box', padding: '9px 16px', borderRadius: 4,
		fontFamily: FONT_DISPLAY, fontSize: 14, fontWeight: 600, lineHeight: '20px', cursor: 'pointer',
	};
	// "No thanks" is the nav's Sign in button, "Opt in" its Get Started button: same size, both real buttons.
	const declineStyle: React.CSSProperties = { ...button, border: `1px solid ${t.navSignInBorder}`, backgroundColor: 'transparent', color: t.textPri };
	const acceptStyle: React.CSSProperties = { ...button, border: '1px solid transparent', backgroundColor: t.ctaBg, color: t.ctaText };
	if (isPrivacySignalOn) {
		acceptStyle.opacity = 0.5;
		acceptStyle.cursor = 'not-allowed';
	}
	// Reopened, each button says whether it is the current choice; with a privacy signal on, Opt in is not one.
	const declinePressed: { 'aria-pressed'?: boolean } = {};
	const acceptPressed: { 'aria-pressed'?: boolean } = {};
	let onAccept = accept;
	if (isReopened) {
		declinePressed['aria-pressed'] = state === 'rejected';
		if (!isPrivacySignalOn) {
			acceptPressed['aria-pressed'] = state === 'accepted';
		}
		if (state === 'accepted') {
			onAccept = close; // already opted in: the button just closes the banner
		}
	}
	const link = <a href={PRIVACY_POLICY_PATH} style={{ color: t.textPri, textDecoration: 'underline', textUnderlineOffset: 2, whiteSpace: 'nowrap' }}>{COPY.link}</a>;
	return (
		<section
			ref={ref}
			role="region"
			aria-label="Cookie consent"
			data-rr-consent-banner=""
			data-rr-no-view=""
			data-rr-placement={placementLabel(placement)}
			style={{
				position: 'fixed', zIndex: 40, ...position,
				boxSizing: 'border-box', padding, borderRadius: 10,
				backgroundColor: t.navDropdownBg, color: t.textPri, border: `1px solid ${t.navBorder}`,
				boxShadow: '0 12px 32px rgba(0,0,0,0.32)', fontFamily: FONT_DISPLAY,
				visibility,
				opacity,
				transform: `translateY(${rise - lift}px)`,
				transition,
			}}
		>
			{isReopened && (
				<button
					type="button"
					onClick={close}
					aria-label="Close"
					style={{ position: 'absolute', top: 6, right: 6, width: 28, height: 28, padding: 0, border: 'none', borderRadius: 4, backgroundColor: 'transparent', color: t.textSec, fontSize: 18, lineHeight: '28px', cursor: 'pointer' }}
				>
					×
				</button>
			)}
			<p data-rr-consent-compact="" style={{ display: compactDisplay, margin: '0 0 10px', fontSize: 13, lineHeight: '19px', color: t.textPri, paddingRight: closeRoom }}>
				<span data-rr-consent-text="">{COPY.phone}</span>{' '}{link}
			</p>
			<div data-rr-consent-full="" style={{ display: fullDisplay }}>
				<h2 data-rr-consent-heading="" style={{ margin: 0, paddingRight: closeRoom, fontSize: 15, fontWeight: 600, lineHeight: '20px', color: t.textPri }}>{COPY.heading}</h2>
				<p style={{ margin: '6px 0 12px', fontSize: 13, lineHeight: '19px', color: t.textPri }}>
					<span data-rr-consent-body="">{COPY.body}</span>{' '}{link}
				</p>
			</div>
			{isReopened && isPrivacySignalOn && (
				<p data-rr-consent-status="signal" style={{ margin: '0 0 10px', fontSize: 13, lineHeight: '19px', fontWeight: 600, color: t.textSec }}>{SIGNAL_STATUS}</p>
			)}
			{isReopened && !isPrivacySignalOn && state !== 'undecided' && (
				<p data-rr-consent-status={state} style={{ margin: '0 0 10px', fontSize: 13, lineHeight: '19px', fontWeight: 600, color: t.textSec }}>{STATUS[state]}</p>
			)}
			<div style={{ display: 'flex', gap: 8 }}>
				<button type="button" style={declineStyle} onClick={decline} aria-label="No thanks, decline cookies and session recordings" {...declinePressed}>{COPY.decline}</button>
				<button type="button" style={acceptStyle} disabled={isPrivacySignalOn} onClick={onAccept} aria-label="Opt in to cookies and session recordings" {...acceptPressed}>{COPY.accept}</button>
			</div>
		</section>
	);
};

export default ConsentBanner;
