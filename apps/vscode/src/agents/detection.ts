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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// Pure, vscode-free agent-detection helpers. Kept separate from agent-manager.ts
// so they can be unit-tested with node:test (see src/test/agent-detection.test.ts).
// The adapter reads vscode APIs and passes their values in via DetectionInput.

/** Inputs the adapter gathers from vscode before calling detectAgentNames. */
export interface DetectionInput {
	/** vscode.env.appName (any casing). */
	appName: string;
	/** Whether the anthropic.claude-code extension is installed. */
	hasClaudeExtension: boolean;
	/** Whether a ~/.claude config dir exists (Claude Code CLI was used). */
	hasClaudeCli: boolean;
}

/**
 * Map the IDE environment to the list of agent names to install.
 * Mirrors the original agent-manager.detectEnvironment() logic, but returns
 * names (strings) instead of installer instances, since the installers now
 * live in @rocketride/agents-core.
 */
export function detectAgentNames(env: DetectionInput): string[] {
	const names: string[] = [];
	const appName = env.appName.toLowerCase();

	if (appName.includes('cursor')) {
		names.push('Cursor');
	}
	if (appName.includes('windsurf')) {
		names.push('Windsurf');
	}
	if (appName.includes('visual studio code') || appName === 'code') {
		names.push('Copilot');
	}
	if (env.hasClaudeExtension || env.hasClaudeCli) {
		names.push('Claude Code');
	}

	return names;
}

/**
 * Union of auto-detected names and individually settings-checked names,
 * de-duplicated, preserving first-seen order (detected first).
 */
export function mergeSelectedAgents(detected: string[], settingsChecked: string[]): string[] {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const name of [...detected, ...settingsChecked]) {
		if (!seen.has(name)) {
			seen.add(name);
			merged.push(name);
		}
	}
	return merged;
}
