/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 */

export interface ClipboardTextControl {
	tagName: string;
	value: string;
	selectionStart: number | null;
	selectionEnd: number | null;
	setSelectionRange(start: number, end: number): void;
}

export type ChatSelectionTarget = 'editable' | 'transcript' | 'none';
export type EmbeddedClipboardCommand = 'copy' | 'cut' | 'paste' | 'selectAll';

export interface EmbeddedClipboardKeyboardEvent {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
}

export interface ChatHostCapabilities {
	isVSCode: boolean;
	isEmbeddedVSCode: boolean;
}

/** Returns whether the chat URL explicitly opts into the nested VS Code bridge. */
export function isVSCodeEmbeddedChat(search: string): boolean {
	return new URLSearchParams(search).get('_rocketrideHost') === 'vscode';
}

/** Separates top-level editor theming from nested clipboard integration. */
export function getChatHostCapabilities(
	hasVSCodeApi: boolean,
	search: string
): ChatHostCapabilities {
	return {
		isVSCode: hasVSCodeApi,
		isEmbeddedVSCode: isVSCodeEmbeddedChat(search),
	};
}

/** Removes transient query parameters while retaining the non-secret host marker. */
export function getSanitizedChatPath(pathname: string, search: string): string {
	return isVSCodeEmbeddedChat(search)
		? `${pathname}?_rocketrideHost=vscode`
		: pathname;
}

/** Maps platform clipboard shortcuts to commands understood by the bridge. */
export function getEmbeddedClipboardCommand(
	event: EmbeddedClipboardKeyboardEvent
): EmbeddedClipboardCommand | undefined {
	if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return undefined;

	switch (event.key.toLowerCase()) {
		case 'a':
			return 'selectAll';
		case 'c':
			return 'copy';
		case 'v':
			return 'paste';
		case 'x':
			return 'cut';
		default:
			return undefined;
	}
}

/** Copies message text through the editor bridge or the browser clipboard. */
export async function copyChatText(
	text: string,
	isEmbedded: boolean,
	postMessage: (message: unknown) => void,
	writeText: (text: string) => Promise<void>
): Promise<boolean> {
	if (isEmbedded) {
		postMessage({ type: 'copyText', text });
		return true;
	}

	try {
		await writeText(text);
		return true;
	} catch {
		return false;
	}
}

/** Identifies editable controls whose selection can be read or changed. */
export function isClipboardTextControl(element: unknown): element is ClipboardTextControl {
	if (!element || typeof element !== 'object') return false;

	const candidate = element as Partial<ClipboardTextControl>;
	return (
		(candidate.tagName === 'INPUT' || candidate.tagName === 'TEXTAREA') &&
		typeof candidate.value === 'string' &&
		typeof candidate.setSelectionRange === 'function'
	);
}

/** Verifies that a text control is the document's exact active element. */
export function isActiveClipboardTextControl(
	activeElement: unknown,
	textControl: unknown
): textControl is ClipboardTextControl {
	return activeElement === textControl && isClipboardTextControl(textControl);
}

function clampSelection(value: string, start: number | null, end: number | null): [number, number] {
	const safeStart = Math.max(0, Math.min(value.length, start ?? value.length));
	const safeEnd = Math.max(safeStart, Math.min(value.length, end ?? safeStart));
	return [safeStart, safeEnd];
}

/** Returns the active input selection, or the transcript selection otherwise. */
export function getSelectedClipboardText(activeElement: unknown, documentSelection: string): string {
	if (!isClipboardTextControl(activeElement)) return documentSelection;

	const [start, end] = clampSelection(activeElement.value, activeElement.selectionStart, activeElement.selectionEnd);
	return activeElement.value.slice(start, end);
}

/** Selects the focused input, falling back to the complete transcript. */
export function selectAllChatContent(
	activeElement: unknown,
	selectTranscript: () => boolean
): ChatSelectionTarget {
	if (isClipboardTextControl(activeElement)) {
		activeElement.setSelectionRange(0, activeElement.value.length);
		return 'editable';
	}

	return selectTranscript() ? 'transcript' : 'none';
}

/** Replaces the selected input range with pasted text and returns its new caret. */
export function insertClipboardText(
	value: string,
	selectionStart: number | null,
	selectionEnd: number | null,
	text: string
): { value: string; caret: number } {
	const [start, end] = clampSelection(value, selectionStart, selectionEnd);
	return {
		value: value.slice(0, start) + text + value.slice(end),
		caret: start + text.length,
	};
}

/** Removes the selected input range and returns both clipboard text and caret. */
export function cutClipboardText(
	value: string,
	selectionStart: number | null,
	selectionEnd: number | null
): { value: string; text: string; caret: number } {
	const [start, end] = clampSelection(value, selectionStart, selectionEnd);
	return {
		value: value.slice(0, start) + value.slice(end),
		text: value.slice(start, end),
		caret: start,
	};
}
