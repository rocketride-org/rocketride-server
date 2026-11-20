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
// Transport-owned event names: the events the shell's telemetry layer itself
// raises. App taxonomies stay with their apps (each app owns its event names
// and documents them beside its call sites); ONLY events emitted by this
// module — the consent lifecycle, the sign-in facts the shell observes —
// belong here.
// =============================================================================

/** The transport's own events. */
export const EV = {
	/** The consent banner rendered (once per page load). */
	CONSENT_SHOWN: 'consent:shown',
	/** The visitor decided: choice 'accepted' | 'rejected' | 'withdrawn', with the consent version. */
	CONSENT_DECISION: 'consent:decision',
	/** A mid-visit opt-in bridged the cookieless half onto the consented session. */
	CONSENT_HANDOFF: 'consent:handoff',
	/** The shell started the OAuth redirect. */
	AUTH_START: 'auth:start',
	/** The shell's callback resolved an identity. */
	AUTH_COMPLETE: 'auth:complete',
} as const;
