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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// GUEST BOOT — the entry of the isolated app frame (PR2b, plan §3.4)
// =============================================================================
//
// Marks the realm as a guest before anything that can build the
// `ConnectionManager` is loaded. `#clear` (the logout clear) goes straight to
// `/_rr/clear` and stops; otherwise the guest runtime is imported dynamically.
// Only `guestFlag` and `bootPlan` are imported statically.
// =============================================================================

import { markGuestRealm } from '../isolation/guestFlag';
import { bootSteps } from './bootPlan';

for (const step of bootSteps(window.location.hash)) {
	if (step === 'markGuestRealm') markGuestRealm();
	else if (step === 'navigateClear') window.location.href = '/_rr/clear';
	else void import('./index');
}
