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

// =============================================================================
// CAPABILITY TABLE — the v1 rows the gate allows, and their type names
// =============================================================================
//
// The data is `packages/shell/isolation/capabilities.json` (the same bytes
// the server hashes into the runtime marker). Loading validates it: an
// unknown capability, op shape or type name fails module load, so a table
// the gate cannot enforce never ships silently.
// =============================================================================

import tableJson from '../../isolation/capabilities.json';

/** One row: what `(op, command, subcommand)` may carry, and the capability it needs. */
export interface CapabilityRow {
	cap: string;
	op: string;
	command?: string;
	/** The subcommands this row covers (`arguments.subcommand`). */
	subcommands?: string[];
	/** Argument name → type name (plan section 4.3). */
	args: Record<string, string>;
	/** DAP top-level keys allowed besides `type`, `seq`, `command`, `arguments`. */
	top?: string[];
}

export interface CapabilityTable {
	v: number;
	rows: CapabilityRow[];
}

/** The v1 capabilities. */
export const KNOWN_CAPS: ReadonlySet<string> = new Set(['core', 'pipelines.run', 'fs.app']);

/** The type names of plan section 4.3 (each may also be prefixed `optional:`). */
export const BASE_TYPES: ReadonlySet<string> = new Set(['string', 'int', 'int<=3600', 'bool', 'string[]', 'json', 'object', 'object:mint-project', 'object:handle-project', 'empty-array', 'empty-object', 'bytes<=8MiB', 'run-handle', 'owned-pipe', 'owned-fs-handle', 'app-path', 'app-partition', 'https-url', 'minted-project', 'monitor-key:run-handle', "'r'|'w'"]);

const OPTIONAL = 'optional:';

/** A type name split into its base type and whether the argument may be absent. */
export function parseType(name: string): { base: string; optional: boolean } {
	return name.startsWith(OPTIONAL) ? { base: name.slice(OPTIONAL.length), optional: true } : { base: name, optional: false };
}

const fail = (why: string): never => {
	throw new Error(`capabilities.json: ${why}`);
};

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Validates a table. An unknown capability, type name or row shape throws.
 *
 * @param json - The parsed table.
 * @returns The table.
 */
export function loadTable(json: unknown): CapabilityTable {
	const t = json as { v?: unknown; rows?: unknown };
	if (!t || typeof t !== 'object' || t.v !== 1 || !Array.isArray(t.rows)) fail('expected {v: 1, rows: [...]}');
	const rows: CapabilityRow[] = [];
	for (const raw of t.rows as unknown[]) {
		const r = raw as Record<string, unknown>;
		const where = `${String(r?.op)} ${String(r?.command ?? '')}`;
		if (!r || typeof r !== 'object' || typeof r.op !== 'string' || typeof r.cap !== 'string') fail(`row ${where}: cap and op are required`);
		if (!KNOWN_CAPS.has(r.cap as string)) fail(`row ${where}: unknown capability ${String(r.cap)}`);
		if (r.op === 'client.request' && typeof r.command !== 'string') fail(`row ${where}: client.request rows need a command`);
		if (r.command !== undefined && typeof r.command !== 'string') fail(`row ${where}: command must be a string`);
		if (r.subcommands !== undefined && !isStringArray(r.subcommands)) fail(`row ${where}: subcommands must be strings`);
		if (r.top !== undefined && !(isStringArray(r.top) && (r.top.length === 0 || (r.top.length === 1 && r.top[0] === 'token')))) fail(`row ${where}: top must be [] or ["token"]`);
		const args = r.args as Record<string, unknown> | undefined;
		if (!args || typeof args !== 'object' || Array.isArray(args)) fail(`row ${where}: args must be an object`);
		for (const [name, type] of Object.entries(args as Record<string, unknown>)) {
			if (typeof type !== 'string' || !BASE_TYPES.has(parseType(type).base)) fail(`row ${where}: argument ${name} has unknown type ${JSON.stringify(type)}`);
		}
		if (r.subcommands !== undefined && (args as Record<string, unknown>).subcommand === undefined) fail(`row ${where}: a subcommand row must declare the subcommand argument`);
		rows.push({
			cap: r.cap as string,
			op: r.op as string,
			...(r.command !== undefined ? { command: r.command as string } : {}),
			...(r.subcommands !== undefined ? { subcommands: [...(r.subcommands as string[])] } : {}),
			args: { ...(args as Record<string, string>) },
			...(r.top !== undefined ? { top: [...(r.top as string[])] } : {}),
		});
	}
	return { v: 1, rows };
}

/** The shipped table, validated at module load. */
export const TABLE: CapabilityTable = loadTable(tableJson);

/**
 * The row for `(op, command?, subcommand?)`, or undefined.
 *
 * Without a subcommand this is a lookup by op and command (the first such
 * row). The gate always passes the message's subcommand: a row that lists
 * subcommands matches only those, and a row without a subcommand list
 * matches only a message without one.
 *
 * @param op - The bus op.
 * @param command - The DAP command (client.request rows).
 * @param subcommand - `arguments.subcommand`, when present.
 * @returns The row.
 */
export function rowFor(op: string, command?: string, subcommand?: string): CapabilityRow | undefined {
	return TABLE.rows.find((r) => r.op === op && r.command === command && (subcommand === undefined || (r.subcommands?.includes(subcommand) ?? false)));
}

/**
 * The gate's strict match: like {@link rowFor}, but a message without a
 * subcommand never matches a subcommand row.
 */
export function matchRow(op: string, command: string | undefined, subcommand: string | undefined): CapabilityRow | undefined {
	if (subcommand === undefined) return TABLE.rows.find((r) => r.op === op && r.command === command && r.subcommands === undefined);
	return rowFor(op, command, subcommand);
}
