// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// OBJECT IDS WITHOUT crypto.subtle (grep-pinned)
// =============================================================================
//
// The app derives a dropped file's objectId (uuid5 of 'null://Stream/' +
// path) to ask whether the path is already stored. `crypto.subtle` exists
// only in secure contexts: on a LAN origin (http://<host-ip>) it is undefined,
// and the check would throw there. So the derivation is pure JavaScript
// (vector/sha1.ts) and no source file may reach for `crypto.subtle`. The
// derivation's own vectors are pinned by its lane's tests.
//
// Two more properties are grep-pinned here. No source file keeps anything in
// the browser's storage (every per-connection state lives in memory and is
// emptied through the cache registry on an identity change). And the export
// modules cannot reach a call module: following their relative imports never
// arrives at map/calls, chat/toolCalls or adapters/, so an export can only
// write what the screen already holds and never asks a store for more.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const SRC = path.resolve(__dirname, '..', 'src');

/** Every source file of the app. */
function sources(dir: string = SRC): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(path.join(dir, entry.name)) : /\.(ts|tsx)$/.test(entry.name) ? [path.join(dir, entry.name)] : []));
}

test('no source file uses crypto.subtle (undefined on a LAN origin)', () => {
	const files = sources();
	assert.ok(files.length > 30, "the premise: the app's sources were read");
	for (const file of files) {
		const text = fs.readFileSync(file, 'utf8');
		assert.doesNotMatch(text, /crypto\s*\.\s*subtle|\bsubtle\s*\.\s*digest|window\.crypto|globalThis\.crypto/, `${path.relative(SRC, file)} reaches for the Web Crypto API`);
	}
});

test('the objectId derivation is pure JavaScript over vector/sha1.ts', () => {
	const objectId = path.join(SRC, 'vector', 'objectId.ts');
	assert.ok(fs.existsSync(objectId), 'vector/objectId.ts derives the objectId the uploads check for collisions');
	assert.match(fs.readFileSync(objectId, 'utf8'), /from '\.\/sha1'/);
	assert.ok(fs.existsSync(path.join(SRC, 'vector', 'sha1.ts')));
});

test('no source file uses browser storage (per-connection state lives in memory, cleared through the registry)', () => {
	const files = sources();
	assert.ok(files.length > 30, "the premise: the app's sources were read");
	// Spelled in pieces, so a grep of the app for these names finds only real uses.
	const names = ['local', 'session'].map((s) => `${s}Storage`).concat(['indexed' + 'DB']);
	const pattern = new RegExp(`\\b(${names.join('|')})\\b`, 'i');
	for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), pattern, `${path.relative(SRC, file)} reaches for browser storage`);
});

/**
 * The relative imports of one source file (value and type imports alike, and re-exports).
 *
 * @param file - The file.
 * @returns Absolute paths of the files it imports.
 */
function importsOf(file: string): string[] {
	const text = fs.readFileSync(file, 'utf8');
	const out: string[] = [];
	for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+'(\.{1,2}\/[^']+)'|import\(\s*'(\.{1,2}\/[^']+)'\s*\)|require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) {
		const spec = (match[1] ?? match[2] ?? match[3]) as string;
		const base = path.resolve(path.dirname(file), spec);
		const hit = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
		assert.ok(hit, `${path.relative(SRC, file)} imports ${spec}, which was not found`);
		out.push(hit);
	}
	return out;
}

/**
 * Every file reachable from `start` through relative imports, with the path that reached it.
 *
 * @param start - The first file.
 * @returns File to the import chain that reached it.
 */
function reachable(start: string): Map<string, string[]> {
	const seen = new Map<string, string[]>([[start, [start]]]);
	const queue = [start];
	while (queue.length > 0) {
		const file = queue.shift() as string;
		for (const next of importsOf(file)) {
			if (seen.has(next)) continue;
			seen.set(next, [...(seen.get(file) as string[]), next]);
			queue.push(next);
		}
	}
	return seen;
}

test('the export modules have no import path to a call module (map/calls, chat/toolCalls, adapters/)', () => {
	const forbidden = (file: string): boolean => {
		const rel = path.relative(SRC, file).split(path.sep).join('/');
		return rel === 'map/calls.ts' || rel === 'chat/toolCalls.ts' || rel.startsWith('adapters/');
	};
	for (const name of ['vector/export.ts', 'map/exportPng.ts', 'vector/savedViews.ts']) {
		const start = path.join(SRC, name);
		assert.ok(fs.existsSync(start), `${name} exists`);
		for (const [file, chain] of reachable(start)) {
			assert.ok(!forbidden(file), `${name} reaches ${path.relative(SRC, file)}: ${chain.map((f) => path.relative(SRC, f)).join(' -> ')}`);
		}
	}
	// The walk itself works: MapView does reach map/calls.
	assert.ok([...reachable(path.join(SRC, 'views', 'MapView.tsx')).keys()].some(forbidden), 'the premise: the walk finds a call module where there is one');
});
