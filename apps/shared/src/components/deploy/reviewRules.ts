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
// REVIEW RULES — which verbs a deployed-version card offers, by review state
// =============================================================================

/**
 * The store-review rules of a deployed-version card, shared by both DEPLOY
 * screens (apps and pipelines) so the ladder lives once (plan 10.1: a
 * version is born 'private', 'private' → submit → 'ready' | 'rejected', and
 * only 'ready' reaches the store):
 *
 * - Publish (point an audience at the version) needs servable bytes and a
 *   version that did not fail; internal audiences accept any other state.
 * - Submit for review exists only on the NEWEST non-failed version while it
 *   is a 'private' draft (latest-only review, which the server enforces too:
 *   older code that should ship is deployed again).
 * - Withdraw exists only on a version in review ('submit').
 * - The store row of the Publish dialog opens on an approved ('ready')
 *   version where the server reviews, and on any version that did not fail
 *   where it does not (a server without a reviewer).
 *
 * The screens own the abilities (what their host can do at all); these
 * functions only decide what one card offers.
 */

import type { IPublishTarget } from './PublishToDialog';

// =============================================================================
// TYPES
// =============================================================================

/** One deployed version as the rules read it. */
export interface IReviewVersion {
	/** Registry version int, the wire identity. */
	version: number;
	/** The version's review state ('private' | 'submit' | 'ready' | 'rejected' | 'failed'); absent when unknown. */
	state?: string;
}

/** What the screen's host can do at all; a verb the host lacks is never offered. */
export interface IVersionCardAbilities {
	/** The host can point an audience at a version. */
	publish: boolean;
	/** The host can submit a version for review (a server with a review ladder). */
	submit: boolean;
	/** The host can withdraw a pending review. */
	withdraw: boolean;
}

/** The verbs one version card offers. */
export interface IVersionCardActions {
	/** "Publish to…" (or the one-audience "Publish"). */
	publish: boolean;
	/** "Submit for review". */
	submit: boolean;
	/** "Withdraw". */
	withdraw: boolean;
}

/** What the store row of the Publish dialog needs to decide and say. */
export interface IStoreTargetInput {
	/** The row label ('Public: the app store', 'Public: the store'). */
	label: string;
	/** The chosen version's review state. */
	state: string | undefined;
	/** The server reviews store versions: only 'ready' opens the row. */
	needsApproval: boolean;
	/** What the store serves now, shown when the row is open. */
	note: string;
}

// =============================================================================
// RULES
// =============================================================================

/** The store target id: the one spelling of the public rung on the wire. */
export const STORE_TARGET_ID = '@public';

/**
 * The newest version that may be submitted for review: the newest one that
 * did not fail (0 when none).
 *
 * @param versions - The rail, any order.
 * @returns The registry version, or 0.
 */
export function newestSubmittableOf(versions: readonly IReviewVersion[]): number {
	return versions.reduce((max, v) => (v.state !== 'failed' && v.version > max ? v.version : max), 0);
}

/**
 * The verbs one version card offers: only legal moves render.
 *
 * @param v - The version, with whether its bytes can serve (an app whose
 *            build has not finished cannot; a pipe always can).
 * @param newestSubmittable - {@link newestSubmittableOf} over the rail.
 * @param can - What the screen's host can do at all.
 * @returns The card's verbs.
 */
export function versionCardActionsOf(v: IReviewVersion & { servable: boolean }, newestSubmittable: number, can: IVersionCardAbilities): IVersionCardActions {
	return {
		publish: can.publish && v.servable && v.state !== 'failed',
		submit: can.submit && v.servable && v.state === 'private' && v.version === newestSubmittable,
		withdraw: can.withdraw && v.state === 'submit',
	};
}

/**
 * Whether the store row of the Publish dialog is open for a version.
 *
 * @param state - The version's review state.
 * @param needsApproval - The server reviews store versions.
 * @returns True when publishing the version to the store is allowed.
 */
export function storeOpenFor(state: string | undefined, needsApproval: boolean): boolean {
	return needsApproval ? state === 'ready' : state !== 'failed';
}

/**
 * The store row of the Publish dialog: open with what the store serves now,
 * or visible and closed with the reason, so the ladder is learnable and the
 * server never has to bounce the choice.
 *
 * @param input - See {@link IStoreTargetInput}.
 * @returns The dialog row.
 */
export function storeTargetOf({ label, state, needsApproval, note }: IStoreTargetInput): IPublishTarget {
	if (storeOpenFor(state, needsApproval)) return { id: STORE_TARGET_ID, label, note };
	return { id: STORE_TARGET_ID, label, note: 'needs review approval', disabled: true, disabledTitle: "The store needs an approved ('ready') version; submit it for review first" };
}
