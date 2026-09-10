/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 */

/**
 * The client side of node distribution: packing a node folder, and the calls
 * that control one afterwards.
 *
 * Packing runs against a real temp directory rather than a mocked fs — the
 * whole point of the packer is what it does with files on disk, and the two
 * rules that matter (the node folder is the zip root, Python leavings never
 * ship) are only observable there.
 *
 * The control calls run against a stub client that records what was sent.
 * These are wire-shape tests: the server's behaviour is pinned by the Python
 * suite, and what can drift here is the argument names.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { packNodeSource } from '../src/app-pack';
import { DeployApi } from '../src/client/deploy';
import type { RocketRideClient } from '../src/client/client';

// =============================================================================
// HELPERS
// =============================================================================

/** A node directory on disk, with whatever extra files a test needs. */
function makeNode(root: string, files: Record<string, string> = {}, manifest?: unknown): string {
	const dir = path.join(root, 'ticket_feed');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'services.json'), JSON.stringify(manifest ?? { protocol: 'ticket_feed://', title: 'Ticket Feed', version: '1.2.0' }));
	fs.writeFileSync(path.join(dir, 'IInstance.py'), 'class IInstance:\n    pass\n');
	for (const [name, content] of Object.entries(files)) {
		const target = path.join(dir, name);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	return dir;
}

/** Entry names inside a packed zip. */
function entriesOf(data: Uint8Array): string[] {
	return new AdmZip(Buffer.from(data))
		.getEntries()
		.map((entry) => entry.entryName)
		.sort();
}

/** A client that records the calls made through it instead of connecting. */
function stubClient(): { api: DeployApi; sent: { command: string; args: Record<string, unknown> }[] } {
	const sent: { command: string; args: Record<string, unknown> }[] = [];
	const client = {
		async call(command: string, args: Record<string, unknown>) {
			sent.push({ command, args });
			return {};
		},
	} as unknown as RocketRideClient;
	return { api: new DeployApi(client), sent };
}

// =============================================================================
// PACKING
// =============================================================================

describe('packNodeSource', () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-node-pack-'));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('puts the node folder at the zip root', () => {
		// services.json has to be at the top: it is where the server reads
		// identity from, and a wrapper folder would hide it.
		const packed = packNodeSource(makeNode(tmp));
		expect(entriesOf(packed.data)).toEqual(['IInstance.py', 'services.json']);
	});

	it('keeps the tree shape below the root', () => {
		const packed = packNodeSource(makeNode(tmp, { 'lib/helper.py': 'x = 1\n' }));
		expect(entriesOf(packed.data)).toContain('lib/helper.py');
	});

	it('never ships Python leavings', () => {
		// Machine-specific and regenerated on every run; shipping them wastes
		// bytes at best and confuses an import at worst.
		const packed = packNodeSource(
			makeNode(tmp, {
				'__pycache__/IInstance.cpython-312.pyc': 'bytecode',
				'lib/__pycache__/helper.pyc': 'bytecode',
				'IInstance.pyc': 'bytecode',
			})
		);
		expect(entriesOf(packed.data)).toEqual(['IInstance.py', 'services.json']);
	});

	it('reports the id the manifest declares', () => {
		expect(packNodeSource(makeNode(tmp)).nodeId).toBe('ticket_feed');
	});

	it('refuses a folder with no manifest', () => {
		const bare = path.join(tmp, 'not_a_node');
		fs.mkdirSync(bare);
		fs.writeFileSync(path.join(bare, 'IInstance.py'), 'x = 1\n');
		expect(() => packNodeSource(bare)).toThrow(/services\.json/);
	});

	it('refuses a manifest that is not valid JSON', () => {
		const dir = makeNode(tmp);
		fs.writeFileSync(path.join(dir, 'services.json'), '{ not json');
		expect(() => packNodeSource(dir)).toThrow(/not valid JSON/);
	});

	it('honours .gitignore inside the node', () => {
		const dir = makeNode(tmp, { '.gitignore': 'secrets.env\n', 'secrets.env': 'TOKEN=1\n' });
		expect(entriesOf(packNodeSource(dir).data)).not.toContain('secrets.env');
	});
});

// =============================================================================
// THE WIRE
// =============================================================================

describe('node control calls', () => {
	it('reads the version rail', async () => {
		const { api, sent } = stubClient();
		await api.nodeVersions('ticket_feed');
		expect(sent[0]).toEqual({ command: 'rrext_deploy_node', args: { subcommand: 'versions', nodeId: 'ticket_feed' } });
	});

	it('pins an audience to a registry version', async () => {
		const { api, sent } = stubClient();
		await api.nodeDeploy('ticket_feed', 3, '@team/Platform');
		expect(sent[0].args).toEqual({ subcommand: 'deploy', nodeId: 'ticket_feed', version: 3, target: '@team/Platform' });
	});

	it('pins to the caller when no target is given', async () => {
		const { api, sent } = stubClient();
		await api.nodeDeploy('ticket_feed', 1);
		expect(sent[0].args.target).toBe('@me');
	});

	it('asks where a node is pinned', async () => {
		const { api, sent } = stubClient();
		await api.nodeWhere('ticket_feed');
		expect(sent[0].args).toEqual({ subcommand: 'where', nodeId: 'ticket_feed' });
	});

	it('withdraws reversibly by default', async () => {
		// disable, not remove: the destructive one should never be the default.
		const { api, sent } = stubClient();
		await api.nodeWithdraw('ticket_feed');
		expect(sent[0].args).toEqual({ subcommand: 'disable', nodeId: 'ticket_feed', target: '@me' });
	});

	it('withdraws from every audience when asked', async () => {
		const { api, sent } = stubClient();
		await api.nodeWithdraw('ticket_feed', '@all', 'remove');
		expect(sent[0].args).toEqual({ subcommand: 'remove', nodeId: 'ticket_feed', target: '@all' });
	});
});

// =============================================================================
// PACK AND DEPLOY TOGETHER
// =============================================================================

describe('addNode', () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-node-add-'));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('sends the packed folder on the generic rail as a node', async () => {
		const { api, sent } = stubClient();
		await api.addNode(makeNode(tmp), { comment: 'first cut' });
		expect(sent[0].command).toBe('rrext_deploy');
		expect(sent[0].args.subcommand).toBe('add');
		expect(sent[0].args.kind).toBe('node');
		expect(sent[0].args.comment).toBe('first cut');
		expect(entriesOf(sent[0].args.data as Uint8Array)).toEqual(['IInstance.py', 'services.json']);
	});

	it('passes deployTo through so publish and bind are one call', async () => {
		const { api, sent } = stubClient();
		await api.addNode(makeNode(tmp), { deployTo: 'Platform' });
		expect(sent[0].args.deployTo).toBe('Platform');
	});

	it('omits deployTo when it was not asked for', async () => {
		// Its absence is what leaves the version inert, so it must not be
		// sent as an empty value.
		const { api, sent } = stubClient();
		await api.addNode(makeNode(tmp));
		expect('deployTo' in sent[0].args).toBe(false);
	});
});
