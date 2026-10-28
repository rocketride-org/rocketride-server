#!/usr/bin/env node
// Prints the engine's provenance as JSON: which engine launch started, built
// from what, and which store calls it has. launch.sh writes it to the state
// folder and drive.mjs copies it into every evidence record.
//
// Env (set by launch.sh): RR_MODE (source|image), RR_REQUESTED, RR_FALLBACK,
// RR_ROOT, RR_LAUNCHER, RR_IMAGE, RR_CONTAINER, RR_BUILD_RECORD, RR_STORE_URL,
// RR_VERIFY_STATE.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const env = process.env;
const root = env.RR_ROOT;
const run = (cmd, args, opts = {}) => {
	try {
		return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
	} catch (err) {
		return opts.keepFailure ? `${err.stdout || ''}${err.stderr || ''}`.trim() : '';
	}
};
const readJson = (file) => {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
};
const lines = (file) =>
	fs.existsSync(file)
		? fs
				.readFileSync(file, 'utf8')
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean)
		: [];

const version = (() => {
	try {
		return JSON.parse(run('curl', ['-sf', '--max-time', '5', 'http://127.0.0.1:5565/version']));
	} catch {
		return null;
	}
})();
const capabilities = (() => {
	try {
		return JSON.parse(run('node', [path.join(__dirname, 'engine-read.cjs'), 'probe']));
	} catch {
		return { fsPutJson: false, detail: 'the probe did not run' };
	}
})();
const checkout = {
	path: root,
	commit: run('git', ['-C', root, 'rev-parse', 'HEAD']),
	branch: run('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']),
	dirtyFiles: run('git', ['-C', root, 'status', '--porcelain']).split('\n').filter(Boolean).length,
};
const keys = {
	source: lines(path.join(env.RR_VERIFY_STATE, 'key-source.txt'))[0] || 'unknown',
	variables: lines(path.join(env.RR_VERIFY_STATE, 'engine-vars.txt')),
};

let out;
if (env.RR_MODE === 'source') {
	const runId = lines(path.join(env.RR_VERIFY_STATE, 'engine.run'))[0];
	const engineEnv = Object.fromEntries(
		lines(path.join(root, '.verify', runId, 'engine.env'))
			.map((l) => l.split('='))
			.filter(([k]) => ['ENGINE_PID', 'ENGINE_PORT', 'ENGINE_MOCK', 'ENGINE_LOG'].includes(k))
	);
	const build = readJson(env.RR_BUILD_RECORD);
	const state = readJson(path.join(root, 'build', 'state.json'))?.server || {};
	// The launcher's own read-only check: process, port, /version, and whether
	// dist/server matches this checkout's engine, ai and node code.
	const doctor = run(env.RR_LAUNCHER, ['doctor', '--id', runId], {
		keepFailure: true,
		env: { ...process.env, RR_VERIFY_APIKEY: env.RR_VERIFY_APIKEY },
	})
		.split('\n')
		.filter((l) => /^(ok|WARN|FAIL|info)\b/.test(l));
	const binary =
		build?.binary ||
		(state.downloadHash
			? { origin: 'downloaded by server:build', buildHash: state.downloadHash }
			: state.buildHash
				? { origin: 'compiled by server:build', buildHash: state.buildHash }
				: { origin: 'unknown' });
	out = {
		mode: 'source',
		requested: env.RR_REQUESTED,
		summary:
			`source: dist/server, Python synced from ${build?.python?.commit?.slice(0, 8) ?? 'unrecorded'}, ` +
			`binary ${binary.origin}${binary.tag ? ` ${binary.tag}` : ''}, checkout ${checkout.commit.slice(0, 8)}, ` +
			`fs_put_json ${capabilities.fsPutJson ? 'present' : 'MISSING'}`,
		checkout,
		launcher: { path: env.RR_LAUNCHER, runId, ...engineEnv },
		store: env.RR_STORE_URL,
		build: build || null,
		version,
		launcherDoctor: doctor,
		capabilities,
		keys,
	};
} else {
	const inspect = (fmt) => run('docker', ['inspect', '-f', fmt, env.RR_CONTAINER]);
	const imageId = inspect('{{.Image}}');
	out = {
		mode: 'image',
		requested: env.RR_REQUESTED,
		fallbackReason: env.RR_FALLBACK || null,
		summary:
			`image: ${env.RR_IMAGE} (${imageId.slice(0, 19)}), ` +
			`fs_put_json ${capabilities.fsPutJson ? 'present' : 'MISSING'}` +
			(env.RR_FALLBACK ? ' (fallback from source)' : ''),
		checkout,
		image: {
			ref: env.RR_IMAGE,
			id: imageId,
			repoDigests: (() => {
				try {
					return JSON.parse(run('docker', ['image', 'inspect', '-f', '{{json .RepoDigests}}', imageId]));
				} catch {
					return [];
				}
			})(),
			container: env.RR_CONTAINER,
		},
		version,
		capabilities,
		keys,
	};
}
out.recordedAt = new Date().toISOString();
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
