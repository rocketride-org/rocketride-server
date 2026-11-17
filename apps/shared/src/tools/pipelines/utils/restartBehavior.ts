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

/**
 * The IDE's restart-behavior setting as the server's `onChange` answer (plan
 * §3.4). The setting (`rocketride.pipeBuilder.pipelineRestartBehavior`) says
 * what the IDE does when a pipeline file changes while its run is live; the
 * same intent is passed to a Play against a live `@dev` run that holds OTHER
 * content, so one setting governs both: `auto` repoints the run to the new
 * content, `manual` keeps delivering to the running engine, `prompt` leaves
 * the server default (`error`, the run fails with `spec_changed`) and the IDE
 * asks, as it does for a file change.
 */

// =============================================================================
// Types
// =============================================================================

/** The setting's values. */
export type RestartBehavior = 'auto' | 'manual' | 'prompt';

/** The server's `onChange` values (plan §3.4). */
export type OnChange = 'error' | 'keep' | 'auto';

// =============================================================================
// Mapping
// =============================================================================

/**
 * Maps the restart-behavior setting to the `onChange` a spec call sends.
 *
 * @param behavior - The setting's value; anything unknown reads as `prompt`.
 * @returns The `onChange` value, or undefined for the server default.
 */
export function onChangeOf(behavior: string | undefined): OnChange | undefined {
	switch (behavior) {
		case 'auto':
			return 'auto';
		case 'manual':
			return 'keep';
		default:
			return undefined;
	}
}

/**
 * The `onChange` argument spread into a `use()` call: `{ onChange }` when the
 * setting names one, `{}` for the server default, so a call site reads
 * `client.use({ ...onChangeArgs(setting), pipeline })`.
 *
 * @param behavior - The setting's value.
 * @returns The argument object to spread.
 */
export function onChangeArgs(behavior: string | undefined): { onChange?: OnChange } {
	const onChange = onChangeOf(behavior);
	return onChange ? { onChange } : {};
}
