/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * `rocketride init` — headless project scaffolding.
 *
 * Writes RocketRide docs, per-agent instruction stubs, a .gitignore entry, a
 * .env template, and (optionally) a service-catalog snapshot into the target
 * directory, by delegating to @rocketride/agents-core. No vscode dependency.
 */

/** Ergonomic CLI slugs mapped to agents-core canonical installer names. */
const AGENT_SLUGS: Record<string, string> = {
	'claude-code': 'Claude Code',
	cursor: 'Cursor',
	windsurf: 'Windsurf',
	copilot: 'Copilot',
	'claude-md': 'CLAUDE.md',
	'agents-md': 'AGENTS.md',
};

/**
 * Map `--agent` slugs to canonical agents-core names.
 * Returns null to mean "install all agents" (no --agent given).
 * Throws on an unknown slug, listing the valid slugs.
 */
export function resolveAgents(slugs: string[] | undefined): string[] | null {
	if (!slugs || slugs.length === 0) {
		return null;
	}
	const names: string[] = [];
	for (const raw of slugs) {
		const slug = raw.trim().toLowerCase();
		const name = AGENT_SLUGS[slug];
		if (!name) {
			throw new Error(`Unknown agent '${raw}'. Valid: ${Object.keys(AGENT_SLUGS).join(', ')}`);
		}
		names.push(name);
	}
	return names;
}
