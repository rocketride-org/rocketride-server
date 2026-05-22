// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * IDE Detection Utility
 *
 * Detects which IDE fork is running the extension (VS Code, Cursor,
 * Windsurf, Antigravity, etc.) using vscode.env.appName.
 */

import * as vscode from 'vscode';

/**
 * Returns the friendly name of the IDE running this extension.
 * Falls back to the raw appName for unknown forks.
 */
export function getIdeName(): string {
	const appName = vscode.env.appName.toLowerCase();
	if (appName.includes('cursor')) return 'Cursor';
	if (appName.includes('windsurf')) return 'Windsurf';
	if (appName.includes('antigravity')) return 'Antigravity';
	if (appName.includes('visual studio code') || appName === 'code') return 'VS Code';
	return vscode.env.appName;
}
