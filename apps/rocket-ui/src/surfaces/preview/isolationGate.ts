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
// PREVIEW ISOLATION GATE — may this app be previewed in the shell realm? (#1022, E6/E13/E14)
// =============================================================================
//
// The App Builder's preview runs the app's code in this origin (an iframe of
// the shell, a linked local registration, a blob page). Under separate-origin
// isolation only a first-party app may do that. `iso` is the shell API's
// `getIsolation()`:
//   • `null` (isolation off): allowed, as before;
//   • `optin`/`enforce`: allowed only for an id the server stamped first party;
//   • `unknown` (the probe failed), any other shape, or a throwing check: denied.
// =============================================================================

/** True when `appId` may run in the shell realm for a preview. */
export function previewAllowed(appId: string, iso: unknown): boolean {
	if (iso === null) return true;
	if (typeof iso !== 'object' || iso === undefined) return false;
	const view = iso as { mode?: unknown; isFirstParty?: unknown };
	if (view.mode !== 'optin' && view.mode !== 'enforce') return false;
	if (typeof view.isFirstParty !== 'function') return false;
	try {
		return (view.isFirstParty as (id: string) => unknown)(appId) === true;
	} catch {
		return false;
	}
}
