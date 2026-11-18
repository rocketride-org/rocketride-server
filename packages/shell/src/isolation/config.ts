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
// ISOLATION CONFIG — the probe's `appIsolation` block and the stamp rule
// (PR2b, plan §3.3, §3.6, §4.6)
// =============================================================================
//
// `installIsolation` runs before the first `registerAndMapApps`:
//   • `undefined` (an `off` engine) keeps the base behaviour: `getIsolation()`
//     is `null` and only an `isolated: true` entry is isolated (fail closed);
//   • `undefined` with `probeFailed` records the UNKNOWN state: no template, no
//     first party, so E6/E13/E14 and dev registration are denied and an
//     isolated entry shows the "Isolation unavailable" tile;
//   • `optin` isolates what is stamped `isolated: true`;
//   • `enforce` also isolates every entry without `firstParty: true` (P3).
// First party is whatever the stamps said (`noteFirstParty`, called by the
// loader for `firstParty: true` entries).
// =============================================================================

export { SHELL_CAPS } from './shellCaps';

/** The probe's `appIsolation` block (absent under `off`). */
export interface IAppIsolationInfo {
	mode: 'optin' | 'enforce';
	originTemplate: string;
	protoMin: number;
	protoMax: number;
}

/** What `getIsolation()` hands apps (contract v13). `null` under `off`. */
export interface IIsolationView {
	mode: 'optin' | 'enforce' | 'unknown';
	originTemplate: string | null;
	isFirstParty(appId: string): boolean;
}

type Installed = { mode: 'optin' | 'enforce'; originTemplate: string; protoMin: number; protoMax: number } | { mode: 'unknown'; originTemplate: null };

let installed: Installed | null = null;
const firstParty = new Set<string>();

function validInfo(info: unknown): info is IAppIsolationInfo {
	if (info === null || typeof info !== 'object') return false;
	const i = info as Record<string, unknown>;
	return (i.mode === 'optin' || i.mode === 'enforce') && typeof i.originTemplate === 'string' && i.originTemplate.includes('{label}');
}

/**
 * Records the probe's isolation block. A block that is present but malformed
 * is treated like a failed probe (unknown), never like `off`.
 */
export function installIsolation(info: IAppIsolationInfo | undefined | null, options: { probeFailed?: boolean } = {}): void {
	if (info === undefined || info === null) {
		if (options.probeFailed) installed = { mode: 'unknown', originTemplate: null };
		return;
	}
	if (!validInfo(info)) {
		installed = { mode: 'unknown', originTemplate: null };
		return;
	}
	installed = { mode: info.mode, originTemplate: info.originTemplate, protoMin: info.protoMin, protoMax: info.protoMax };
}

/** The installed mode, or null under `off`. */
export function isolationMode(): 'optin' | 'enforce' | 'unknown' | null {
	return installed ? installed.mode : null;
}

/** Records a `firstParty: true` stamp seen in a server list. */
export function noteFirstParty(appId: string): void {
	firstParty.add(appId);
}

/** True when the id carried a `firstParty: true` stamp and isolation is known (not `unknown`). */
export function isFirstPartyId(appId: string): boolean {
	if (installed?.mode === 'unknown') return false;
	return firstParty.has(appId);
}

/** The stamp rule (plan §4.6). The loader's sticky set is checked separately. */
export function isIsolatedEntry(entry: { id: string; isolated?: boolean; firstParty?: boolean }): boolean {
	if (entry.isolated === true) return true;
	return installed?.mode === 'enforce' && entry.firstParty !== true;
}

/** The v13 channel (`shellApi.getIsolation()`). */
export function getIsolation(): IIsolationView | null {
	if (!installed) return null;
	const { mode, originTemplate } = installed;
	return {
		mode,
		originTemplate,
		isFirstParty: (appId: string) => mode !== 'unknown' && firstParty.has(appId),
	};
}
