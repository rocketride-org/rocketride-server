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
// Lazy host for the consent banner (the port of HomeApp's banner host): the
// banner mounts only once the page has settled — the consent decision is not
// worth a frame of the first paint — or at once when the footer's "Privacy
// settings" link asks for it. Renders nothing when there is no key (OSS) or
// when the consent source is the embedding host's setting (VS Code — the
// editor's telemetry switch is the one switch). Under a privacy signal
// (telemetry off) it mounts only on that explicit request: the banner then
// states the signal is honoured, with Opt in disabled — nothing is captured
// and nothing is ever shown unasked (shouldMountConsentBanner).
// =============================================================================

import React, { useEffect, useState } from 'react';
import { privacySignalOn } from 'rocketride/analytics';
import { ConsentBanner } from './ConsentBanner';
import { subscribeConsentHost, shouldMountConsentBanner } from './consentUi';
import { onIdleAfterLoad } from './settle';
import { telemetryConfig } from './config';
import { telemetryEnabled } from './host';

type Props = {
	/** Whether the surface under the banner is signed out (the prompt shows only there). */
	signedOut: boolean;
};

/** Mounts the banner after settle, or immediately on a "Privacy settings" request. */
export const ConsentBannerHost: React.FC<Props> = ({ signedOut }) => {
	const [isReady, setIsReady] = useState(false);
	const [isRequested, setIsRequested] = useState(false);
	useEffect(() => {
		let disposed = false;
		onIdleAfterLoad(() => {
			if (!disposed) {
				setIsReady(true);
			}
		});
		// Also fires at once for a request made before this effect subscribed.
		const off = subscribeConsentHost(() => {
			// The banner takes the pending request itself once mounted.
			if (!disposed) {
				setIsReady(true);
				setIsRequested(true);
			}
		});
		return () => {
			disposed = true;
			off();
		};
	}, []);
	const config = telemetryConfig();
	const mount = shouldMountConsentBanner({
		hasKey: !!config?.key,
		storedConsent: config?.consentSource === 'stored',
		telemetryLive: telemetryEnabled(),
		privacySignal: privacySignalOn(),
		settled: isReady,
		requested: isRequested,
	});
	return mount ? <ConsentBanner signedOut={signedOut} /> : null;
};
