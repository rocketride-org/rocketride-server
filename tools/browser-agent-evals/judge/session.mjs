// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';

// No Anthropic credential or endpoint: a session runs on the key it is given, never on one from the shell.
const INHERITED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'CLAUDE_CONFIG_DIR', 'PLAYWRIGHT_BROWSERS_PATH'];

/** Throws unless `apiKey` is a non-empty string, before a session or its scratch files exist. */
export function checkApiKey(apiKey) {
	if (typeof apiKey !== 'string' || apiKey === '') throw new Error('a judge session needs an Anthropic API key (EVAL_ANTHROPIC_KEY)');
}

/**
 * The minimal environment a `claude -p` session gets: `INHERITED_ENV` from this process, with background features off,
 * plus `extra`, and `apiKey` as `ANTHROPIC_API_KEY`, its only Anthropic credential.
 */
export function sessionEnv(apiKey, extra = {}) {
	checkApiKey(apiKey);
	const inherited = INHERITED_ENV.filter((name) => process.env[name]).map((name) => [name, process.env[name]]);
	return { ...Object.fromEntries(inherited), LANG: 'en_US.UTF-8', TERM: 'dumb', ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', ...extra, ANTHROPIC_API_KEY: apiKey };
}

/** Reads a `stream-json` transcript into its events, skipping lines that don't parse. */
export function parseEvents(text) {
	return text.split('\n').flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
}

/** Replaces each value of 8 characters or more with `[redacted]` in the files. */
export function scrub(files, values) {
	// Short values such as 'dark' are settings, and replacing them would garble the evidence.
	const secrets = values.filter((value) => value.length >= 8).map((value) => JSON.stringify(value).slice(1, -1));
	for (const file of files) {
		fs.writeFileSync(
			file,
			secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), fs.readFileSync(file, 'utf8'))
		);
	}
}

/** Runs `claude` with `args`, writing stdout to `transcript` and stderr to `stderr`, and kills it at `timeoutMs`. */
export function runClaude(args, { cwd, env, transcript, stderr, timeoutMs }) {
	const out = fs.openSync(transcript, 'w');
	const err = fs.openSync(stderr, 'w');
	return new Promise((resolve) => {
		let failure = null;
		const child = spawn('claude', args, { cwd, env, stdio: ['ignore', out, err] });
		// Not spawn's timeout option, whose timer survives a failed start and holds the process open.
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.on('error', (error) => {
			failure = `could not start claude: ${error.message}`;
		});
		child.on('close', (exit) => {
			clearTimeout(timer);
			fs.closeSync(out);
			fs.closeSync(err);
			resolve({ exit, failure: child.killed ? `timed out after ${timeoutMs} ms` : failure });
		});
	});
}
