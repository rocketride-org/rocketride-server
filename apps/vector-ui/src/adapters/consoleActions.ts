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
// ADAPTER - CONSOLE ACTIONS (pure): what the map, the document tab and the panels ask the console
// =============================================================================
//
// ConsoleActions (src/contract/types.ts) are the only way another part of the
// app changes what the console shows: open a document tab, show keys on the
// map, ask to remove documents (the console confirms first; nothing is sent
// here), scope the next chat question, refresh after an upload, announce.
// Two helpers tell the map a question before they highlight: a chat answer's
// (showAnswerOnMap) and Search's two compared questions (showCompareOnMap).
// =============================================================================

import type { ConsoleActions, HighlightSource, SelectionStore, VectorKey } from '../contract/types';
import type { IRemoveTarget } from '../vector/confirm';
import { DEFAULT_LIMITS } from '../vector/results';
import type { IConnectionEntry } from './connections';

/**
 * What "Ask about these" says instead of scoping the chat to more documents than the node takes.
 *
 * @param count - Documents asked about.
 * @param cap - `limits.scope_keys_max`.
 * @returns The sentence.
 */
export function askAboutTooMany(count: number, cap: number): string {
	return `Too many documents to ask about (${count.toLocaleString('en-US')}; at most ${cap.toLocaleString('en-US')}). Narrow the selection.`;
}

/** What the actions need from the app around them. */
export interface IConsoleActionDeps {
	/** Open (or focus) the document tab of one document. */
	openDocument(objectId: string, chunkId?: number): void;
	/**
	 * Bring this connection's console tab to the front (reopening it if it was closed). An action that changes
	 * what the console shows may come from a document tab, which would otherwise stay in front of it.
	 */
	showConsole(): void;
	/** Speak through the polite live region. */
	announce(text: string): void;
}

/**
 * The remove targets for objectIds: the directory's rows where it has them (path
 * and chunk count), else the objectId alone with an unknown count.
 *
 * @param entry - The connection.
 * @param objectIds - The documents.
 * @returns The targets, in the order asked.
 */
export function removeTargets(entry: Pick<IConnectionEntry, 'controller' | 'selection'>, objectIds: readonly string[]): IRemoveTarget[] {
	const rows = new Map(entry.controller.getState().directory.rows.map((row) => [row.objectId, row]));
	const selected = entry.selection.getState().document;
	return objectIds.map((objectId) => {
		const row = rows.get(objectId);
		if (row) return { objectId, path: row.path, chunks: row.chunks };
		return { objectId, path: selected?.objectId === objectId ? selected.path : objectId, chunks: null };
	});
}

/**
 * Show a chat answer's sources on the map. The map is told the answer's
 * question first, so the highlight that brings it to the front finds the
 * question there: the map embeds it and places the answer's star exactly, and
 * falls back to the centre of the sources only when the embedding node cannot
 * be reached (src/map/queryProjection.ts chatQueryPlan). This is the one way
 * the chat highlights.
 *
 * @param selection - The connection's selection.
 * @param actions - The console's actions.
 * @param question - The question the answer is for.
 * @param keys - The sources to highlight.
 */
export function showAnswerOnMap(selection: Pick<SelectionStore, 'setQuery'>, actions: Pick<ConsoleActions, 'showOnMap'>, question: string, keys: readonly VectorKey[]): void {
	selection.setQuery(question);
	actions.showOnMap(keys, 'chat');
}

/**
 * Show two searches side by side on the map (Search's Compare): question A is
 * the map's query and question B the second one, both told to the map before
 * the highlight brings it to the front, so it can place a star for each (A ★,
 * B ☆). The highlighted keys are both result lists, each key once, A's first.
 *
 * @param selection - The connection's selection.
 * @param actions - The console's actions.
 * @param questionA - The first question.
 * @param questionB - The question compared with it.
 * @param keysA - A's results.
 * @param keysB - B's results.
 */
export function showCompareOnMap(selection: Pick<SelectionStore, 'setQuery' | 'setQueryB'>, actions: Pick<ConsoleActions, 'showOnMap'>, questionA: string, questionB: string, keysA: readonly VectorKey[], keysB: readonly VectorKey[]): void {
	selection.setQuery(questionA);
	selection.setQueryB(questionB);
	const seen = new Set<string>();
	const keys: VectorKey[] = [];
	for (const key of [...keysA, ...keysB]) {
		const id = `${key[0]}#${key[1]}`;
		if (seen.has(id)) continue;
		seen.add(id);
		keys.push(key);
	}
	actions.showOnMap(keys, 'search');
}

/**
 * The console's actions for one connection.
 *
 * @param entry - The connection's objects.
 * @param deps - Opening a document tab, fronting the connection's console and announcing.
 * @returns The actions.
 */
export function makeConsoleActions(entry: Pick<IConnectionEntry, 'controller' | 'selection' | 'tab' | 'chatScope'> & Partial<Pick<IConnectionEntry, 'ctx'>>, deps: IConsoleActionDeps): ConsoleActions {
	return {
		openDocument: (objectId: string, chunkId?: number) => deps.openDocument(objectId, chunkId),
		showOnMap: (keys: readonly VectorKey[], source: HighlightSource) => {
			entry.selection.setHighlight({ source, keys });
			entry.tab.set('map');
			deps.showConsole();
		},
		requestRemove: (objectIds: readonly string[]) => entry.controller.requestRemove(removeTargets(entry, objectIds)),
		askAbout: (objectIds: readonly string[]) => {
			// The chat's question carries the ids as its filter: never more than the node takes.
			const cap = entry.ctx?.limits.scope_keys_max ?? DEFAULT_LIMITS.scope_keys_max;
			if (objectIds.length > cap) {
				deps.announce(askAboutTooMany(objectIds.length, cap));
				return;
			}
			entry.chatScope.set(objectIds.length === 0 ? null : [...objectIds]);
			entry.tab.set('console');
			deps.showConsole();
		},
		documentsChanged: () => entry.controller.documentsChanged(),
		announce: (text: string) => deps.announce(text),
	};
}
