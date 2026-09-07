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

/**
 * Pure auto-install consent decision, kept out of `agent-manager.ts` so it is
 * testable without the `vscode` module (same seam as `gitignoreEntries.ts`).
 */

/** What the user picked in the consent prompt, or `undefined` if dismissed. */
export type ConsentChoice = 'Install' | 'Not now' | "Don't ask again";

/** The persisted answer, or `undefined` when the user has not answered yet. */
export type RecordedConsent = 'accepted' | 'declined';

/** The three prompt buttons, in the order they are presented. */
export const CONSENT_CHOICES: readonly ConsentChoice[] = ['Install', 'Not now', "Don't ask again"];

/**
 * The prompt body, minus the leading "RocketRide detected <names>" sentence.
 *
 * Every automatic write is named here on purpose. Issue #1186 is not "the
 * extension installed docs I did not want" so much as "the extension changed
 * files in my project without asking", and `.gitignore` is one of those files:
 * accepting also appends `.rocketride/` and `.env` to it (creating it when
 * absent). Consent that omits a write is not consent for that write, so the
 * text has to enumerate them.
 */
export const CONSENT_PROMPT_DETAIL = "Install RocketRide's agent integration docs? This adds a .rocketride/ folder and agent stub files, and adds .rocketride/ and .env to your .gitignore (creating it if needed).";

/** What the caller should do once the user has answered. */
export interface ConsentDecision {
	/** Whether the auto-detected installers may write to the workspace now. */
	grant: boolean;
	/**
	 * The answer to persist, or `undefined` to persist nothing.
	 *
	 * Only a deliberate, durable answer is stored. 'Not now' and dismissing the
	 * prompt are both momentary, so they leave no record and the user is asked
	 * again next activation.
	 */
	persist?: RecordedConsent;
}

/**
 * Decide whether auto-install may proceed.
 *
 * `recorded` short-circuits the prompt entirely: once the user has answered
 * durably, the answer holds across every workspace they open. Otherwise the
 * decision follows `choice`.
 */
export function decideAutoInstallConsent(recorded: RecordedConsent | undefined, choice: ConsentChoice | undefined): ConsentDecision {
	if (recorded === 'accepted') return { grant: true };
	if (recorded === 'declined') return { grant: false };

	if (choice === 'Install') return { grant: true, persist: 'accepted' };
	if (choice === "Don't ask again") return { grant: false, persist: 'declined' };

	// 'Not now', or the prompt dismissed without a choice: skip this activation
	// only. Persisting here would silently turn a one-off "not right now" into
	// "never ask again", which is the opposite of what the user asked for.
	return { grant: false };
}
