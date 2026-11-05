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
// GRAPH-UI - THE ONE CYPHER COMPLETION PROVIDER (and the editor marks)
// =============================================================================
//
// `registerCompletionItemProvider` is global to a language id, and every query
// editor in the realm stays mounted (hidden documents, one editor per query tab).
// Registering one per editor would stack providers and show every suggestion once
// per editor. So ONE provider is registered per Monaco namespace, for the module's
// lifetime, and what varies per editor (its schema and engine) is looked up by the
// editor MODEL's URI in a map each editor adds to on mount and removes on unmount.
//
// Kept apart from QueryEditor so the registration can be tested with a fake
// namespace, without loading Monaco.
// =============================================================================

import type * as MonacoNS from 'monaco-editor';
import { suggestAt } from '../cypher/completion';
import type { CandidateKind, ICompletionModel } from '../cypher/completion';

/** Per-editor completion state, keyed by the editor model's URI. */
const contexts = new Map<string, ICompletionModel>();

/** The Monaco namespaces a provider has been registered on (one registration each). */
const registered = new WeakSet<object>();

/**
 * Set or clear what an editor's suggestions are made from.
 *
 * @param uri - The editor model's URI.
 * @param model - The schema and engine, or null to remove the editor's entry.
 */
export function setCompletionContext(uri: string, model: ICompletionModel | null): void {
	if (model === null) contexts.delete(uri);
	else contexts.set(uri, model);
}

/**
 * How many editors have an entry (for tests and leak checks).
 *
 * @returns The number of entries.
 */
export function completionContextCount(): number {
	return contexts.size;
}

/**
 * The Monaco item kind for a suggestion.
 *
 * @param monaco - The Monaco namespace.
 * @param kind - The suggestion's kind.
 * @returns The item kind.
 */
function itemKind(monaco: typeof MonacoNS, kind: CandidateKind): MonacoNS.languages.CompletionItemKind {
	const kinds = monaco.languages.CompletionItemKind;
	switch (kind) {
		case 'label':
			return kinds.Struct;
		case 'type':
			return kinds.Reference;
		case 'property':
			return kinds.Field;
		case 'keyword':
			return kinds.Keyword;
		default:
			return kinds.Snippet;
	}
}

/**
 * Register the Cypher provider on a Monaco namespace, once. Triggers are `:` (labels and types) and `.` (properties).
 * It is never disposed: it belongs to the module, and disposing it when one tab closes would break every other tab.
 *
 * @param monaco - The Monaco namespace.
 */
export function ensureCypherCompletion(monaco: typeof MonacoNS): void {
	if (registered.has(monaco)) return;
	registered.add(monaco);
	monaco.languages.registerCompletionItemProvider('cypher', {
		triggerCharacters: [':', '.'],
		provideCompletionItems: (model, position) => {
			const context = contexts.get(model.uri.toString());
			if (!context) return { suggestions: [] };
			const word = model.getWordUntilPosition(position);
			// Replace the word being typed, so accepting does not leave its first letters in front of the suggestion.
			const range: MonacoNS.IRange = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
			const before = model.getValue().slice(0, model.getOffsetAt(position));
			return {
				suggestions: suggestAt(context, before).map((candidate) => ({
					label: candidate.label,
					kind: itemKind(monaco, candidate.kind),
					detail: candidate.detail,
					documentation: candidate.documentation,
					sortText: candidate.sortText,
					insertText: candidate.insertText,
					insertTextRules: candidate.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
					range,
				})),
			};
		},
	});
}

/** One mark in the editor text, by buffer offset. */
export interface IEditorMarker {
	start: number;
	end: number;
	message: string;
	severity: 'error' | 'warning';
}

/** The owner name of this app's marks, so setting them never touches another owner's. */
export const MARKER_OWNER = 'graph-ui';

/**
 * Show marks in an editor model, replacing the ones this app set before.
 *
 * @param monaco - The Monaco namespace.
 * @param model - The editor's model.
 * @param markers - The marks to show (an empty list clears them).
 */
export function applyMarkers(monaco: typeof MonacoNS, model: MonacoNS.editor.ITextModel, markers: readonly IEditorMarker[]): void {
	const length = model.getValueLength();
	monaco.editor.setModelMarkers(
		model,
		MARKER_OWNER,
		markers.map((marker) => {
			const start = model.getPositionAt(Math.max(0, Math.min(marker.start, length)));
			const end = model.getPositionAt(Math.max(0, Math.min(Math.max(marker.end, marker.start + 1), length)));
			return {
				severity: marker.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
				message: marker.message,
				startLineNumber: start.lineNumber,
				startColumn: start.column,
				endLineNumber: end.lineNumber,
				endColumn: end.column,
			};
		})
	);
}

/**
 * A value that changes only when the marks themselves do, so a caller may build the array fresh on every render without
 * bringing a cleared mark back.
 *
 * @param markers - The marks, or undefined.
 * @returns A string identifying their content.
 */
export function markersKey(markers: readonly IEditorMarker[] | undefined): string {
	return (markers ?? []).map((m) => `${m.severity}:${m.start}:${m.end}:${m.message}`).join('|');
}
