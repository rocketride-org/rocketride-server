#!/usr/bin/env node
// Reads (and, for fixtures, writes) the agent's workspace through the engine,
// the same store the Agent tab writes to. A second, read-only view of what the
// agent did, independent of the page.
//
//   node engine-read.cjs ping
//   node engine-read.cjs probe                          which store calls this engine has (fs_put_json), JSON out
//   node engine-read.cjs ls [pipelines|apps/<x>|nodes/<x>]
//   node engine-read.cjs cat <workspace path>          e.g. pipelines/verify-chat.pipe
//   node engine-read.cjs validate <workspace path>     engine validate of a .pipe, JSON out
//   node engine-read.cjs write <workspace path> <local file>   seed a fixture
//   node engine-read.cjs reset                         delete every workspace file, agent session and
//                                                      the saved workbench layout
//   node engine-read.cjs snapshot <dir>                copy workspace files and agent sessions into <dir>
//   node engine-read.cjs start <workspace path> <name> start a .pipe as the user would from another tab
//                                                      (an execute run, which outlives this connection), JSON out
//   node engine-read.cjs status <token>                the run's status, or {"gone": true}, JSON out
//   node engine-read.cjs terminate <token>             stop a run (cleanup)
//
// Env: RR_VERIFY_APIKEY (default local-test), RR_VERIFY_CANARY (fake keys,
// comma-separated, allowed through the evidence scrubber so a leak stays
// visible). The engine is always http://127.0.0.1:5565, where launch starts it;
// RR_VERIFY_ENGINE is launch's mode (source or image), not a URL.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = execSync('git rev-parse --show-toplevel', { cwd: __dirname }).toString().trim();
// The checkout's built client, resolved from apps/shared, not from this folder.
// eslint-disable-next-line n/no-missing-require
const { RocketRideClient } = require(require.resolve('rocketride', { paths: [path.join(ROOT, 'apps/shared')] }));
// Pinned, like ENGINE_PORT in lib.sh, because the shell's dev proxy sends the page there.
const URI = 'http://127.0.0.1:5565';
const APIKEY = process.env.RR_VERIFY_APIKEY || 'local-test';
const CANARIES = (process.env.RR_VERIFY_CANARY || '').split(',').filter(Boolean);
const PROJECTS = '.projects';
// Outside the workspace mounts and .agents, so no journey or reset sees it.
const PROBE_PATH = '.rr-verify-agent/probe.json';
const DIR_MARKER = '.dirmarker';

/** Blanks real-key shapes in evidence, keeping the known fake canaries visible. */
function scrub(text) {
	const keep = (m) => (CANARIES.some((c) => m.includes(c)) ? m : '[redacted]');
	return text.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, keep).replace(/sk-(proj-)?[A-Za-z0-9_-]{16,}/g, keep);
}

/** Same rule as resolveWorkspaceScope in apps/rocket-ui/src/surfaces/workspace/vfs/workspace.ts. */
function scopePrefix(info) {
	const devTeam = info && info.devTeam;
	const teams = (info && info.organization && info.organization.teams) || [];
	if (!devTeam || !/^[A-Za-z0-9_-]+$/.test(devTeam) || !teams.some((t) => t.id === devTeam)) return '';
	return `@/Team/=${devTeam}/`;
}

/** Workspace path (apps/, nodes/, pipelines/) to the store path, as workspace.ts maps it. */
function storePath(prefix, vpath) {
	const [mount, ...rest] = vpath.replace(/^\/+/, '').split('/').filter(Boolean);
	const r = rest.join('/');
	if (mount === 'pipelines') return `${prefix}${PROJECTS}${r ? '/' + r : ''}`;
	if (mount === 'apps') return `${prefix}${PROJECTS}/.appdev${r ? '/' + r : ''}`;
	if (mount === 'nodes') return `${prefix}${PROJECTS}/.nodes${r ? '/' + r : ''}`;
	throw new Error(`not a workspace path: ${vpath} (use pipelines/, apps/ or nodes/)`);
}

async function listFiles(client, dir, hideDotDirs) {
	let entries = [];
	try {
		entries = (await client.fsListDir(dir)).entries || [];
	} catch {
		return [];
	}
	const out = [];
	for (const e of entries) {
		if (e.name === DIR_MARKER) continue;
		const full = `${dir}/${e.name}`;
		if (e.type === 'dir') {
			if (hideDotDirs && e.name.startsWith('.')) continue;
			out.push(...(await listFiles(client, full, false)));
		} else out.push(full);
	}
	return out;
}

async function main() {
	const [cmd, a, b] = process.argv.slice(2);
	const client = new RocketRideClient({ uri: URI, env: {}, module: 'rr-verify' });
	await client.connect(APIKEY);
	const info = client.getAccountInfo() || {};
	const prefix = scopePrefix(info);
	const mounts = {
		pipelines: storePath(prefix, 'pipelines'),
		apps: storePath(prefix, 'apps'),
		nodes: storePath(prefix, 'nodes'),
	};
	try {
		switch (cmd) {
			case 'ping': {
				await client.fsListDir('');
				console.log(
					JSON.stringify({ ok: true, uri: URI, scope: prefix || 'user', devTeam: info.devTeam || null })
				);
				break;
			}
			case 'probe': {
				// Session saves go through fsWriteJson, which sends fs_put_json. An
				// engine without it answers "Unknown subcommand: fs_put_json".
				let fsPutJson = true;
				let detail = 'fs_put_json wrote and fs_get_json read back a probe file';
				try {
					await client.fsWriteJson(PROBE_PATH, { probe: 1 });
					const back = await client.fsReadJson(PROBE_PATH);
					if (!back || back.probe !== 1)
						[fsPutJson, detail] = [false, 'fs_put_json returned, but the probe file did not read back'];
				} catch (err) {
					[fsPutJson, detail] = [false, (err && err.message ? err.message : String(err)).split('\n')[0]];
				}
				try {
					await client.fsDelete(PROBE_PATH);
				} catch {
					/* absent when the write failed */
				}
				console.log(JSON.stringify({ fsPutJson, detail }));
				break;
			}
			case 'ls': {
				const v = a || 'pipelines';
				const dir = storePath(prefix, v);
				const files = await listFiles(client, dir, v === 'pipelines');
				for (const f of files) console.log(path.posix.join(v, path.posix.relative(dir, f)));
				break;
			}
			case 'cat':
				process.stdout.write(scrub(await client.fsReadString(storePath(prefix, a))));
				break;
			case 'validate': {
				const pipe = JSON.parse(await client.fsReadString(storePath(prefix, a)));
				const r = await client.validate({ pipeline: pipe });
				console.log(JSON.stringify({ path: a, errors: r.errors || [], warnings: r.warnings || [] }, null, 2));
				process.exitCode = (r.errors || []).length ? 3 : 0;
				break;
			}
			case 'write':
				await client.fsWriteString(storePath(prefix, a), fs.readFileSync(b, 'utf8'));
				console.log(`wrote ${a}`);
				break;
			case 'reset': {
				for (const [m, dir] of Object.entries(mounts))
					for (const f of await listFiles(client, dir, m === 'pipelines')) await client.fsDelete(f);
				for (const f of await listFiles(client, '.agents', false)) await client.fsDelete(f);
				// The workbench layout (open editor and session tabs) persists per app
				// in .workspace/<appId>.workspace.json; clear it so no tab carries over.
				for (const dir of ['.workspace', `${prefix}.workspace`])
					for (const f of await listFiles(client, dir, false)) await client.fsDelete(f);
				console.log('workspace files, agent sessions and workbench layout cleared');
				break;
			}
			case 'snapshot': {
				const out = path.resolve(a);
				for (const [m, dir] of Object.entries(mounts)) {
					for (const f of await listFiles(client, dir, m === 'pipelines')) {
						const dest = path.join(out, 'workspace', m, path.posix.relative(dir, f));
						fs.mkdirSync(path.dirname(dest), { recursive: true });
						fs.writeFileSync(dest, scrub(await client.fsReadString(f)));
					}
				}
				for (const f of await listFiles(client, '.agents', false)) {
					const dest = path.join(out, 'sessions', path.posix.relative('.agents', f));
					fs.mkdirSync(path.dirname(dest), { recursive: true });
					fs.writeFileSync(dest, scrub(await client.fsReadString(f)));
				}
				console.log(`snapshot written to ${out}`);
				break;
			}
			case 'start': {
				const pipe = JSON.parse(await client.fsReadString(storePath(prefix, a)));
				const r = await client.use({ pipeline: pipe.pipeline || pipe, name: b || undefined, ttl: 900 });
				console.log(
					JSON.stringify({ token: r.token, projectId: r.projectId, source: r.source, reused: r.reused })
				);
				break;
			}
			case 'status': {
				try {
					const st = await client.getTaskStatus(a);
					console.log(JSON.stringify({ name: st.name, state: st.state, completed: st.completed }));
				} catch (err) {
					console.log(
						JSON.stringify({
							gone: true,
							error: (err && err.message ? err.message : String(err)).split('\n')[0],
						})
					);
				}
				break;
			}
			case 'terminate':
				await client.terminate(a);
				console.log(`terminated ${a.slice(0, 11)}…`);
				break;
			default:
				console.error(
					'usage: engine-read.cjs ping|probe|ls|cat|validate|write|reset|snapshot|start|status|terminate'
				);
				process.exitCode = 2;
		}
	} finally {
		await client.disconnect();
	}
}

main().catch((err) => {
	console.error(`engine-read: ${err && err.message ? err.message : err}`);
	process.exit(1);
});
