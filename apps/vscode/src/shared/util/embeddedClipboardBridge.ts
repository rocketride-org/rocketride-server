// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

export type EmbeddedClipboardCommand = 'copy' | 'cut' | 'paste' | 'selectAll';

export interface EmbeddedClipboardMessageTarget {
	postMessage(message: unknown): Thenable<boolean> | Promise<boolean>;
}

export interface EmbeddedClipboardReader {
	readText(): Thenable<string> | Promise<string>;
}

/**
 * Routes editor-level clipboard shortcuts to the active embedded application.
 *
 * Provides an extension-host fallback for editors that resolve clipboard
 * keybindings before dispatching them into a nested iframe.
 */
export async function routeEmbeddedClipboardCommand(
	target: EmbeddedClipboardMessageTarget | undefined,
	clipboard: EmbeddedClipboardReader,
	command: EmbeddedClipboardCommand
): Promise<boolean> {
	if (!target) return false;

	try {
		if (command === 'paste') {
			const text = await clipboard.readText();
			return await target.postMessage({ type: 'pasteContent', text });
		}

		return await target.postMessage({ type: 'clipboardCommand', command });
	} catch {
		return false;
	}
}
