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
// The React seams apps reach telemetry through. The shell wraps the app outlet
// in <TelemetryProvider reporter={getReporter(activeAppId)}>; components call
// useReport() for the bound reporter, module-level code calls getReporter()
// (host.ts). Reporters are closed over the DESCRIPTOR's app id — nothing
// re-initialises on app switch, and a late event from a backgrounded app
// stamps its true emitter. useConsent() is the read-only consent surface plus
// the one affordance to change it (the Settings Privacy section).
// =============================================================================

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Reporter } from 'rocketride/analytics';
import { ConnectionManager } from '../connection/connection';
import { getConsentState, subscribeConsent } from './consentState';
import { setPageActive } from './host';
import type { ConsentState } from './consent';

/** A reporter that drops everything: the context default outside a provider. */
const NOOP_REPORTER: Reporter = () => { /* outside a TelemetryProvider: nothing to attribute to */ };

const TelemetryContext = createContext<Reporter>(NOOP_REPORTER);

/** Props for the provider the shell wraps the app outlet in. */
export type TelemetryProviderProps = {
	/** The active app's bound reporter (host.ts getReporter). */
	reporter: Reporter;
	children?: React.ReactNode;
};

/**
 * Scopes the bound reporter to the app subtree and marks an app page active
 * for the transport (shell-owned screens are not pages: no $pageleave, no web
 * vitals attributed to them).
 */
export const TelemetryProvider: React.FC<TelemetryProviderProps> = ({ reporter, children }) => {
	useEffect(() => {
		setPageActive(true);
		return () => {
			setPageActive(false);
		};
	}, []);
	return <TelemetryContext.Provider value={reporter}>{children}</TelemetryContext.Provider>;
};

/**
 * The active app's bound `report(event, props?, options?)`. Stable identity;
 * outside a provider (a shell screen) it reports nothing.
 *
 * @returns The bound reporter.
 */
export function useReport(): Reporter {
	return useContext(TelemetryContext);
}

/** What useConsent returns: the device's consent state and the way to change it. */
export type ConsentApi = {
	/** The device's consent record: 'undecided' | 'accepted' | 'rejected'. */
	state: ConsentState;
	/** Open the Settings overlay at the Privacy section (the one write surface besides the banner). */
	openSettings(): void;
};

/**
 * The device's analytics-consent state, live: re-renders on decisions made in
 * the banner, the Settings toggle, or another tab. Apps that gate their own
 * experiment captures follow this instead of owning a consent store.
 *
 * @returns The state and the Settings affordance.
 */
export function useConsent(): ConsentApi {
	const [state, setState] = useState<ConsentState>(() => {
		return getConsentState();
	});
	useEffect(() => {
		const unsubscribe = subscribeConsent((next) => {
			setState(next);
		});
		// The store does not replay its state to a new listener: a decision made between the render's
		// initial read and this subscription would otherwise be missed until the next change.
		setState(getConsentState());
		return unsubscribe;
	}, []);
	const openSettings = useCallback(() => {
		ConnectionManager.getInstance().emit('shell:openOverlay', { id: 'settings', section: 'privacy' });
	}, []);
	return useMemo(() => ({ state, openSettings }), [state, openSettings]);
}
