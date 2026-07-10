import * as vscode from 'vscode';

/** True when `raw` parses to an allowlisted external scheme (https/http/mailto). */
export function isAllowedExternalUrl(raw: string): boolean {
	try {
		const scheme = vscode.Uri.parse(raw).scheme.toLowerCase();
		return scheme === 'https' || scheme === 'http' || scheme === 'mailto';
	} catch {
		return false;
	}
}
