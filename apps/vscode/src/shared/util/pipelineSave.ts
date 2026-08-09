// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * pipelineSave — the save flow for pipeline documents in the grid editor.
 *
 * Saved (titled) documents save in place through VS Code. UNTITLED documents
 * run the native OS Save dialog ourselves, because VS Code's built-in untitled
 * Save As can neither default into a subfolder nor force the `.pipe` extension
 * (and we deliberately do not register a `.pipe` language). Driving the dialog
 * lets us default into the configured pipelines directory — created first so it
 * can never fall back to the process CWD — with a `.pipe` filter.
 *
 * One implementation for both save surfaces (the Ctrl+S keybinding scoped to
 * the grid editor and the webview Save button via `project:requestSave`) so the
 * two can never diverge.
 */

import * as vscode from 'vscode';
import { ConfigManager } from '../../config';

// =============================================================================
// SETTINGS
// =============================================================================

/**
 * Resolves `rocketride.defaultPipelinePath` to a workspace-relative,
 * '/'-separated directory (e.g. "pipelines").
 *
 * The setting's default carries a `${workspaceFolder}/` prefix, stripped here
 * because callers root the value at the workspace folder. An empty string means
 * "the workspace root itself".
 */
export function resolveDefaultPipelineDir(): string {
	// Fall back to the documented default when the setting is unset/empty.
	const raw = ConfigManager.getInstance().getConfig()?.defaultPipelinePath || 'pipelines';
	return raw
		.replace(/^\$\{workspaceFolder\}[/\\]?/, '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '');
}

// =============================================================================
// SAVE FLOW
// =============================================================================

/**
 * Saves a pipeline document.
 *
 * Titled documents save in place (`document.save()`). Untitled documents open
 * the native Save dialog defaulted into the configured pipelines directory with
 * a `.pipe` filter; on confirm the content is written, the untitled buffer is
 * reverted-and-closed (its content is on disk, so no discard prompt), and the
 * saved `.pipe` re-opens in the grid editor. A cancelled dialog leaves the
 * dirty untitled document open.
 *
 * @param document - The pipeline document backing the active grid editor.
 */
export async function savePipelineDocument(document: vscode.TextDocument): Promise<void> {
	// step: titled files are plain native in-place saves.
	if (!document.isUntitled) {
		await document.save();
		return;
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showErrorMessage('Cannot save pipeline: no workspace folder open');
		return;
	}

	// step: ensure the configured pipelines directory exists so the Save dialog
	// can default INTO it (a missing dir is what made the OS dialog fall back to
	// the CWD during the demo).
	const dir = resolveDefaultPipelineDir();
	const dirUri = dir ? vscode.Uri.joinPath(folder.uri, ...dir.split('/')) : folder.uri;
	await vscode.workspace.fs.createDirectory(dirUri);

	// step: native OS Save dialog — the untitled name suggested inside the
	// pipelines directory, .pipe filter so the OS appends the extension.
	const base = document.uri.path.split('/').pop() || 'Untitled-1';
	const suggestedName = base.toLowerCase().endsWith('.pipe') ? base : `${base}.pipe`;
	const target = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.joinPath(dirUri, suggestedName),
		filters: { 'RocketRide Pipeline': ['pipe'] },
		saveLabel: 'Save Pipeline',
	});
	if (!target) {
		// User cancelled — keep the dirty untitled document open.
		return;
	}

	// step: write the content, drop the untitled buffer without a discard
	// prompt (its content is on disk now), then reopen the saved file in the
	// grid editor via the *.pipe custom-editor association.
	await vscode.workspace.fs.writeFile(target, Buffer.from(document.getText(), 'utf8'));
	await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
	await vscode.commands.executeCommand('vscode.openWith', target, 'rocketride.PageProject');
}
