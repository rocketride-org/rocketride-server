// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// EXTERNAL LINK — open a docs URL from the project editor
// =============================================================================
//
// Opens the URL in the system browser via the VS Code shell (node
// documentation, the endpoint modal's links, the sandboxed plan CTAs). A
// node's front end is never a URL: it opens as a dev-tool panel through
// `host.pipeline.openTool` (plan 3.6), so there is no embedded page here.
// =============================================================================

import * as vscode from 'vscode';
import { getLogger } from '../../shared/util/output';
import { assertExternalUrl } from 'shared/ops/hostOps';

/**
 * Opens a URL in the system browser (scheme-allowlisted).
 *
 * @param url - The URL to open.
 */
export function openExternalLink(url: string): void {
	// URL comes from a webview message — the shared host.openExternal
	// guard (ONE scheme allowlist, not a parallel copy) gates it.
	try {
		void vscode.env.openExternal(vscode.Uri.parse(assertExternalUrl(url)));
	} catch (error) {
		getLogger().error(`[PipelineProvider] ${error}`);
	}
}
