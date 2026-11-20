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
// GRAPH - BADGES (the letters inside a node, distinct per label)
// =============================================================================
//
// A node shows the start of its label inside its circle. The first letter alone
// is not enough: Person and Product are both "P". Over the labels of one
// connection, each badge is the shortest start of the label (the first letter in
// capitals, the rest in lower case) that no other label shares: "Pe", "Pr" and
// "T". Past three characters the start is numbered instead ("Cu1", "Cu2"), so
// every label always has a badge of its own.
//
// A badge depends on the other labels: when a label that starts like another is
// added, the badges of both get longer. The colour does not move when that
// happens (see colors.ts).
// =============================================================================

import type { INodeLook } from '../canvas/GraphCanvas';
import type { IConnectionStyle } from './userData';

/** The longest start of a label used as a badge before numbers take over. */
const MAX_START = 3;

/**
 * The first `count` characters of a label as a badge: the first in capitals, the rest in lower case.
 *
 * @param chars - The label as characters (code points, so an emoji is one).
 * @param count - How many to keep.
 * @returns The badge text.
 */
function start(chars: readonly string[], count: number): string {
	return chars.slice(0, count).map((c, i) => (i === 0 ? c.toUpperCase() : c.toLowerCase())).join('');
}

/**
 * Distinct badges for a connection's labels.
 *
 * @param labels - The labels (any order, duplicates allowed; the empty label has no badge).
 * @returns A badge per distinct label, none shared.
 */
export function distinctBadges(labels: Iterable<string>): Map<string, string> {
	const distinct = Array.from(new Set(labels))
		.filter((label) => label !== '')
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const chars = new Map(distinct.map((label) => [label, Array.from(label)] as const));
	const out = new Map<string, string>();
	const pending = new Set(distinct);
	// Lengthen the start for every label that still shares its badge, until none does or the limit is reached.
	for (let length = 1; length <= MAX_START && pending.size > 0; length++) {
		const groups = new Map<string, string[]>();
		for (const label of pending) {
			const badge = start(chars.get(label) as string[], length);
			groups.set(badge, [...(groups.get(badge) ?? []), label]);
		}
		for (const [badge, members] of groups) {
			const exhausted = members.every((m) => (chars.get(m) as string[]).length <= length);
			if (members.length === 1) {
				out.set(members[0], badge);
				pending.delete(members[0]);
			} else if (exhausted) {
				// Labels that are the same text up to case: nothing left to extend, so the label itself (it differs).
				for (const m of members) {
					out.set(m, m);
					pending.delete(m);
				}
			}
		}
	}
	// Still sharing at the limit: number the members of each group in sorted order.
	const taken = new Set(out.values());
	const groups = new Map<string, string[]>();
	for (const label of pending) {
		const prefix = start(chars.get(label) as string[], MAX_START - 1);
		groups.set(prefix, [...(groups.get(prefix) ?? []), label]);
	}
	for (const [prefix, members] of groups) {
		let n = 1;
		for (const member of members) {
			while (taken.has(`${prefix}${n}`)) n += 1;
			out.set(member, `${prefix}${n}`);
			taken.add(`${prefix}${n}`);
		}
	}
	return out;
}

/**
 * How each label's nodes are drawn: its badge, and the size and badge mode the connection's style gives it.
 *
 * @param labels - The connection's labels (the schema's and the drawn ones).
 * @param style - The connection's style.
 * @returns A look per distinct label.
 */
export function nodeLooks(labels: Iterable<string>, style: IConnectionStyle): Map<string, INodeLook> {
	const distinct = Array.from(new Set(labels)).filter((label) => label !== '');
	const badges = distinctBadges(distinct);
	const out = new Map<string, INodeLook>();
	for (const label of distinct) {
		const own = Object.prototype.hasOwnProperty.call(style.labels, label) ? style.labels[label] : undefined;
		out.set(label, { badge: badges.get(label) as string, size: own?.size ?? 'M', badgeMode: own?.badge ?? 'initials' });
	}
	return out;
}
