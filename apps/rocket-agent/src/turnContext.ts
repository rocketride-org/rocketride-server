/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { TurnState } from './types';

/** Build the per-turn `system` block from live state only. Empty string when nothing is live. */
export function buildTurnSystem(input: { openDocUri?: string; openDocShape?: string; turn: TurnState }): string {
	const lines: string[] = [];
	if (input.openDocUri) {
		lines.push(
			`OPEN PIPELINE: the user has \`${input.openDocUri}\` open on the canvas. Edit THAT file — ` +
			`not a new one. If it changed since your last turn, that was intentional.`,
		);
		if (input.openDocShape) lines.push(`Its current shape: ${input.openDocShape}.`);
	}
	if (input.turn.activePhase) {
		lines.push(`ACTIVE PHASE: ${input.turn.activePhase}. Follow that phase's skill; it stays active until you enter another.`);
	}
	if (input.turn.awaitingGate) {
		const g = input.turn.awaitingGate;
		lines.push(`AWAITING GATE ${g.id} (options: ${g.options.join(', ')}). The user's next message is the answer — apply it, do not re-ask.`);
	}
	return lines.length ? `<live-state>\n${lines.join('\n')}\n</live-state>` : '';
}

/**
 * Build the per-turn `system` block AND consume one-shot turn state in the same step. Today the
 * only one-shot field is `awaitingGate`: it is injected into EXACTLY ONE prompt's system (via
 * {@link buildTurnSystem}) and then cleared on `turn`, so it is never re-asserted on any later
 * turn. This is the single seam the prompt proxy calls to close the gate-answer loop — the turn
 * that answers a gate (the user's typed reply, or the follow-up prompt the gate button fires)
 * carries the awaiting-gate context once, then it's gone. Mutates `turn` in place and returns the
 * system string to inject. `activePhase`/`openDoc` are NOT one-shot — they persist across turns
 * and are left untouched.
 */
export function buildTurnSystemAndConsume(input: { openDocUri?: string; openDocShape?: string; turn: TurnState }): string {
	const system = buildTurnSystem(input);
	if (input.turn.awaitingGate) input.turn.awaitingGate = undefined;
	return system;
}

/** Set `.system` on a buffered prompt_async body. No-op for empty system or a non-JSON body. */
export function injectSystemIntoPromptBody(raw: Buffer, system: string): Buffer {
	if (!system) return raw;
	let obj: Record<string, unknown>;
	try { obj = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { return raw; }
	const existing = typeof obj.system === 'string' && obj.system ? `${obj.system}\n\n` : '';
	obj.system = `${existing}${system}`;
	return Buffer.from(JSON.stringify(obj));
}
