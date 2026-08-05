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
// CONTRACT HOLD — the versioned contract, enforced in shell-ui's own tsc
// =============================================================================
//
// This lives in its OWN file (not api.ts) so api.ts stays a pure surface source:
// `shell:freeze` runs dts-bundle-generator over api.ts to snapshot the contract,
// and nothing here should ever leak into that snapshot.

import type { ShellApiLatest } from 'shell-api';
import type { ShellApiShape } from './api';

/**
 * Hand-written anchor: the live surface must still satisfy the NEWEST frozen
 * version ({@link ShellApiLatest}). Removing or breaking a member that the latest
 * contract declares fails HERE, under shell-ui's own `tsc --noEmit` / build.
 *
 * The FULL "nothing ever frozen can be removed" guarantee — across every version,
 * so a removal cannot be laundered by re-freezing — is the set of per-version
 * floors in contract-check.generated.ts (`_floor_vN`), which `shell:freeze`
 * appends (never drops) from the immutable versions/*.d.ts files. There is no
 * freeze path that removes a floor: dropping one takes hand-deleting a
 * "FROZEN — do not edit" version file, a deliberate, review-visible act.
 *
 * Accumulation is per-version (not an intersection): intersecting the snapshots
 * reduces nominal members (enums like ConnectionState) to `never`.
 *
 * `{} as ShellApiShape` (not a fresh object literal) skips excess-property checks,
 * so a newly-added member can be used before it is frozen — only removals and
 * breaking changes fail.
 *
 * The RocketRideClient (MF shared singleton) is frozen INLINE in the bundle
 * with a covariant type floor — append-only: SDK additions pass, removals
 * fail. For that to hold, the client must NEVER appear in an input position
 * (function parameter / component prop) on the surface: contravariance there
 * flips the check and additive SDK growth reads as a break. Components source
 * the client from useShellConnection()/getClient() instead — see the note in
 * freeze-shell-api.js.
 */
const _contractHold: ShellApiLatest = {} as ShellApiShape;
void _contractHold;
