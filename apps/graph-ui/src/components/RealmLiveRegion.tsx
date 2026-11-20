// =============================================================================
// MIT License
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
// GRAPH-UI - THE REALM'S LIVE REGION (rendered by one mount, portalled to the page)
// =============================================================================
//
// Each mount renders <RealmLiveRegion />; only the first claim renders the
// region (realmRegion.ts). It is portalled to document.body, so the mount that
// owns it can sit in a hidden tab without silencing the announcements of the
// visible one.
// =============================================================================

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { LiveRegion } from '../adapters/explorer';
import { REALM_REGION } from '../realmRegion';

/** The realm's one polite live region, rendered by whichever mount claimed it first. */
export const RealmLiveRegion: React.FC = () => {
	const [token] = useState(() => ({}));
	useEffect(() => {
		REALM_REGION.claim(token);
		return () => REALM_REGION.release(token);
	}, [token]);
	const owner = useSyncExternalStore(REALM_REGION.subscribe, REALM_REGION.owner, REALM_REGION.owner);
	if (owner !== token || typeof document === 'undefined') return null;
	return createPortal(<LiveRegion />, document.body);
};

export default RealmLiveRegion;
