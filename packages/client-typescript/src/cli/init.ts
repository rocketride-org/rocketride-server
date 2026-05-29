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

import * as fs from 'fs';
import * as path from 'path';
import { AgentManager, defaultBundle, syncServiceCatalog } from '@rocketride/agents-core';
import { CONST_DEFAULT_WEB_LOCAL } from '../client/constants';

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

/** Contents written to a freshly-created .env. */
const ENV_TEMPLATE = `# RocketRide configuration
ROCKETRIDE_APIKEY=
ROCKETRIDE_URI=http://localhost:5565
# ROCKETRIDE_PIPELINE=./my-pipeline.json
# ROCKETRIDE_TOKEN=
`;

export interface InitOptions {
	/** Agent slugs from --agent; undefined means all. */
	agent?: string[];
	/** commander sets this to false when --no-catalog is passed (default true). */
	catalog?: boolean;
	/** API key for the catalog fetch (from --apikey / ROCKETRIDE_APIKEY). */
	apikey?: string;
	/** Server URI for the catalog fetch (from --uri / ROCKETRIDE_URI). */
	uri?: string;
}

export interface InitDeps {
	/** Target directory; defaults to process.cwd(). Injected for test isolation. */
	cwd?: string;
	/** Line logger; production uses console.log. */
	log: (msg: string) => void;
	/**
	 * Fetch the service catalog. Returns the services map, or null when no
	 * apikey is available or the server cannot be reached. Injected so tests
	 * run without a websocket.
	 */
	fetchCatalog: (opts: { apikey?: string; uri: string }) => Promise<Record<string, unknown> | null>;
}

/**
 * Create .env from the template when absent (never overwrite — it may hold a
 * real key), then ensure `.env` is listed in .gitignore so a later-filled-in
 * key is not committed. Idempotent.
 */
function scaffoldEnv(cwd: string, log: (msg: string) => void): void {
	const envPath = path.join(cwd, '.env');
	if (!fs.existsSync(envPath)) {
		fs.writeFileSync(envPath, ENV_TEMPLATE, 'utf8');
		log('Created .env');
	}

	const gitignorePath = path.join(cwd, '.gitignore');
	let gitignore = '';
	try {
		gitignore = fs.readFileSync(gitignorePath, 'utf8');
	} catch {
		// Will create.
	}
	if (!gitignore.split('\n').some((line) => line.trim() === '.env')) {
		const next = gitignore.trimEnd() + (gitignore ? '\n' : '') + '.env\n';
		fs.writeFileSync(gitignorePath, next, 'utf8');
	}
}

/**
 * Core init routine. Returns a process exit code. Throws on an unknown agent
 * slug (validated before any file is written).
 */
export async function runInit(opts: InitOptions, deps: InitDeps): Promise<number> {
	const cwd = deps.cwd ?? process.cwd();
	const agents = resolveAgents(opts.agent); // throws on bad slug before any write

	const manager = new AgentManager();
	const bundle = defaultBundle();
	if (agents === null) {
		await manager.installAll(bundle, cwd, deps.log);
	} else {
		await manager.installFromList(agents, bundle, cwd, deps.log);
	}

	scaffoldEnv(cwd, deps.log);

	if (opts.catalog !== false) {
		const uri = opts.uri || process.env.ROCKETRIDE_URI || CONST_DEFAULT_WEB_LOCAL;
		const services = await deps.fetchCatalog({ apikey: opts.apikey, uri });
		if (services && Object.keys(services).length > 0) {
			await syncServiceCatalog(cwd, services, deps.log);
		} else {
			deps.log('⚠ Skipped service catalog (no apikey or server unreachable). Pass --no-catalog to silence.');
		}
	}

	deps.log('RocketRide project initialized.');
	return 0;
}
