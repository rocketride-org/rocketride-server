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
// COMMON CHECKS: what every trial scans for, as the raw text comes in
// =============================================================================

/**
 * Task 3.3's leak scans. Evidence files are scrubbed, so a scan of them could
 * never find a real key; these scanners read the raw text instead, as the
 * trial sees it, and keep only fingerprints (canary.ts), never values:
 *
 * - keys-not-leaked: every key the engine holds, over everything the trial
 *   saw (frames both ways, console, the page's text, the saved session and
 *   catalog, the workspace).
 * - each canary_absent check: its canaries over its own surfaces. In the
 *   browser, model_questions are the question frames the page sends
 *   (rrext_process write whose body is a question), thinking the saved
 *   session's thinking rows, final_text the saved turn's answer,
 *   session_json and catalog the saved files, workspace_files the final
 *   workspace.
 */

import { CanaryScanner, fingerprint, scanText, type Fingerprint } from '../canary';
import type { HeldKey } from '../evidence';
import type { Task } from '../task';
import type { CanaryScan, ScenarioCheck } from '../types';

/** The canary_absent entry that stands for every Variable value the engine has. */
const VARIABLE_VALUES = '$VARIABLE_VALUES';

/** Where keys-not-leaked looked, and what it found. Names only. */
export interface KeyScan {
	keys: number;
	scanned: string[];
	hits: Array<{ surface: string; key: string; count: number }>;
}

/** The raw surfaces a trial produces, in the order it produces them. */
export type RawSurface = 'ws-sent' | 'ws-received' | 'console' | 'page_text' | 'session_json' | 'thinking' | 'final_text' | 'catalog' | 'workspace_files';

/**
 * Whether a sent frame is a question to a model: an rrext_process write whose
 * body, after the header line, is a question.
 */
export function isModelQuestion(frame: string): boolean {
	const nl = frame.indexOf('\n');
	if (nl < 0) return false;
	return frame.slice(0, nl).includes('"command":"rrext_process"') && frame.slice(0, nl).includes('"subcommand":"write"') && frame.slice(nl + 1).startsWith('{"type":"question"');
}

/** Every scanner of one trial. Feed it raw text; read the results. */
export class TrialScans {
	private readonly keyPrints: Fingerprint[];
	private readonly keyHits = new Map<string, number>();
	private readonly keyScanned = new Set<string>();
	private readonly canaries: Array<{ id: string; scanner: CanaryScanner }>;

	/**
	 * @param task - The task, for its canary_absent checks and canaries.
	 * @param keys - The keys the engine holds: its Variables.
	 */
	constructor(task: Task, keys: HeldKey[]) {
		this.keyPrints = keys.map((k) => fingerprint(k.name, k.value));
		this.canaries = task.checks
			.filter((ck) => ck.type === 'canary_absent')
			.map((ck) => {
				const prints: Fingerprint[] = [];
				for (const entry of (ck.canaries as string[]) ?? []) {
					if (entry === VARIABLE_VALUES) prints.push(...this.keyPrints);
					else if (task.canaries?.[entry] !== undefined) prints.push(fingerprint(entry, task.canaries[entry]));
					else prints.push(fingerprint(entry, entry));
				}
				return { id: ck.id, scanner: new CanaryScanner({ ...ck, kind: 'canary_absent' } as ScenarioCheck, prints) };
			});
	}

	/**
	 * Scans one piece of raw text.
	 *
	 * @param surface - Where it came from.
	 * @param text - The text, unscrubbed.
	 */
	feed(surface: RawSurface, text: string): void {
		this.keyScanned.add(surface);
		for (const [name, n] of scanText(text, this.keyPrints)) this.keyHits.set(`${surface}\u0000${name}`, (this.keyHits.get(`${surface}\u0000${name}`) ?? 0) + n);
		const canarySurface = surface === 'ws-sent' ? (isModelQuestion(text) ? 'model_questions' : null) : surface === 'ws-received' || surface === 'console' || surface === 'page_text' ? null : surface;
		if (!canarySurface) return;
		for (const c of this.canaries) {
			if (text) c.scanner.scan(canarySurface, text);
			else c.scanner.empty(canarySurface);
		}
	}

	/**
	 * Marks a canary surface the trial could not read.
	 *
	 * @param surface - The surface.
	 * @param why - Why.
	 */
	unreadable(surface: string, why: string): void {
		for (const c of this.canaries) c.scanner.unreadable(surface, why);
	}

	/** Marks a surface as read with nothing in it, such as no model question at all. */
	empty(surface: string): void {
		for (const c of this.canaries) c.scanner.empty(surface);
	}

	/** keys-not-leaked's result. */
	keyScan(): KeyScan {
		return {
			keys: this.keyPrints.length,
			scanned: [...this.keyScanned],
			hits: [...this.keyHits].map(([k, count]) => {
				const [surface, key] = k.split('\u0000');
				return { surface, key, count };
			}),
		};
	}

	/** Each canary_absent check's scan, by check id. */
	canaryScans(): Record<string, CanaryScan> {
		return Object.fromEntries(this.canaries.map((c) => [c.id, c.scanner.result()]));
	}
}
