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
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// GRAPH - THE NODE'S `dialect` ANSWER (engine, identity, capabilities, limits)
// =============================================================================
//
// `dialect` is the probe every endpoint gets once. Current nodes answer with the
// engine and its version, the database or graph, whether `execute` is allowed,
// capability flags and limits (contract v1 section 1.5). An OLD node answers
// `{ dialect }` only, and then nothing can be assumed: no `read_query`, no
// refresh, no limits. The app turns that into an upgrade message and never
// falls back to `execute` (or FalkorDB's writable `query`) to browse.
//
// Only safe identity fields come through here; nothing in a dialect answer is a
// credential, and this module never reads one.
// =============================================================================

import { DEFAULT_ROW_LIMIT } from './budgets';
import { isPlainObject } from './values';
import type { GraphDialect } from '../cypher/quote';

// =============================================================================
// TYPES
// =============================================================================

/** How the node keeps `read_query` read-only (descriptive: what the database enforces, as the node reports it). */
export type ReadBoundary = 'database_role' | 'read_session' | 'ro_command' | 'read_only_tx' | 'unknown';

/** Limits the node reports. */
export interface IGraphLimits {
	defaultRows: number;
	/** What "All" means: the node's cap, never unlimited. */
	maxRows: number;
	maxElements: number;
	maxValues: number;
	statementTimeoutMs: number;
	/** FalkorDB's own result-set cap, when it has one. */
	serverResultCap: number | null;
}

/** The node's answer, normalised. */
export interface IGraphDialect {
	dialect: GraphDialect;
	engineName: string | null;
	engineVersion: string | null;
	/** Neo4j `community` or `enterprise`; null elsewhere or when unknown. */
	edition: string | null;
	database: string | null;
	graph: string | null;
	/** True only when the node reports `allow_execute` (the write console is shown only then). */
	allowExecute: boolean;
	capabilities: Readonly<Record<string, boolean>>;
	limits: IGraphLimits;
	readBoundary: ReadBoundary;
	/** True only when the node verified its own database permissions. */
	readBoundaryVerified: boolean;
}

/** Fallbacks when a node does not report its limits. */
export const FALLBACK_LIMITS: IGraphLimits = { defaultRows: DEFAULT_ROW_LIMIT, maxRows: 1000, maxElements: 10000, maxValues: 500000, statementTimeoutMs: 30000, serverResultCap: null };

// =============================================================================
// PARSING
// =============================================================================

/**
 * Read a positive integer field.
 *
 * @param value - The wire value.
 * @param fallback - Used when the value is not a positive integer.
 * @returns The integer.
 */
function positive(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Read an optional text field.
 *
 * @param value - The wire value.
 * @returns A non-empty string, or null.
 */
function text(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Normalise a `dialect` answer.
 *
 * @param info - The probe's `info` (the whole tool answer), or null.
 * @returns The dialect, or null when the node is not one of the three supported engines.
 */
export function parseDialect(info: Record<string, unknown> | null): IGraphDialect | null {
	if (!info) return null;
	const dialect = info.dialect;
	if (dialect !== 'age' && dialect !== 'neo4j' && dialect !== 'falkordb') return null;

	const engine = isPlainObject(info.engine) ? info.engine : {};
	const caps: Record<string, boolean> = {};
	if (isPlainObject(info.capabilities)) for (const key of Object.keys(info.capabilities)) caps[key] = info.capabilities[key] === true;
	const limits = isPlainObject(info.limits) ? info.limits : {};
	const boundary = info.read_boundary;
	return {
		dialect,
		engineName: text(engine.name),
		engineVersion: text(engine.version),
		edition: text(engine.edition),
		database: text(info.database),
		graph: text(info.graph),
		allowExecute: info.allow_execute === true,
		capabilities: caps,
		limits: {
			defaultRows: positive(limits.default_rows, FALLBACK_LIMITS.defaultRows),
			maxRows: positive(limits.max_rows, FALLBACK_LIMITS.maxRows),
			maxElements: positive(limits.max_elements, FALLBACK_LIMITS.maxElements),
			maxValues: positive(limits.max_values, FALLBACK_LIMITS.maxValues),
			statementTimeoutMs: positive(limits.statement_timeout_ms, FALLBACK_LIMITS.statementTimeoutMs),
			serverResultCap: typeof limits.server_result_cap === 'number' && limits.server_result_cap > 0 ? limits.server_result_cap : null,
		},
		readBoundary: boundary === 'database_role' || boundary === 'read_session' || boundary === 'ro_command' || boundary === 'read_only_tx' ? boundary : 'unknown',
		readBoundaryVerified: info.read_boundary_verified === true,
	};
}

// =============================================================================
// WHAT THE NODE CAN DO
// =============================================================================

/**
 * Whether a node advertises a capability.
 *
 * A node that publishes no `capabilities` block (an old node) advertises nothing:
 * the app then shows the upgrade message and sends nothing. It never substitutes
 * `execute`, or FalkorDB's writable `query`, for a read.
 *
 * @param dialect - The parsed dialect, or null.
 * @param key - The capability key.
 * @returns True only when the node says `true`.
 */
function capable(dialect: IGraphDialect | null, key: string): boolean {
	return dialect !== null && dialect.capabilities[key] === true;
}

/**
 * Whether the node supports the read path the app browses with.
 *
 * @param dialect - The parsed dialect, or null for an unprobed or unsupported node.
 * @returns True only when the node says so; an old node (no capabilities) is false.
 */
export function supportsReadQuery(dialect: IGraphDialect | null): boolean {
	return capable(dialect, 'read_query');
}

/**
 * Whether the node can refresh its schema.
 *
 * @param dialect - The parsed dialect.
 * @returns True only when the node says so.
 */
export function supportsRefresh(dialect: IGraphDialect | null): boolean {
	return capable(dialect, 'refresh_schema');
}

/**
 * Whether the write console may be shown: the node must allow execute AND speak
 * the graph shape (`execute` with `shape: 'graph'`).
 *
 * @param dialect - The parsed dialect.
 * @returns True when writes are possible through this endpoint.
 */
export function canWrite(dialect: IGraphDialect | null): boolean {
	return dialect !== null && dialect.allowExecute && capable(dialect, 'execute_shape_graph');
}

/**
 * The row limit to send for the editor's choice. "All" is the node's cap, never
 * unlimited, and nothing above the cap is ever sent.
 *
 * @param choice - 200, 1000, or null for All.
 * @param dialect - The parsed dialect (null uses the fallbacks).
 * @returns A limit within 1..cap.
 */
export function rowLimitFor(choice: number | null, dialect: IGraphDialect | null): number {
	const cap = dialect ? dialect.limits.maxRows : FALLBACK_LIMITS.maxRows;
	const wanted = choice === null ? cap : choice;
	return Math.max(1, Math.min(cap, Math.floor(wanted)));
}

/** What the row-limit chip says. */
export interface IRowLimitChip {
	/** The chip's text. */
	text: string;
	/** A longer explanation for the tooltip; null when there is nothing to explain. */
	title: string | null;
}

/**
 * The row-limit chip: the limit that is sent, and, when it is lower than what the toggle asks for, why.
 * (The toggle offers 200, 1,000 and All; a node with a lower `max_rows` than the choice silently sends
 * its own maximum, so the two controls would disagree with no explanation.)
 *
 * @param choice - 200, 1000, or null for All.
 * @param dialect - The parsed dialect (null uses the fallbacks).
 * @returns Text and tooltip.
 */
export function rowLimitChip(choice: number | null, dialect: IGraphDialect | null): IRowLimitChip {
	const cap = dialect ? dialect.limits.maxRows : FALLBACK_LIMITS.maxRows;
	const sent = rowLimitFor(choice, dialect);
	const text = `limit ${sent.toLocaleString('en-US')}`;
	if (choice === null || choice <= cap) return { text, title: null };
	return {
		text: `${text} (this connection's maximum)`,
		title: `This connection allows at most ${cap.toLocaleString('en-US')} rows per query (the node's max_rows). You chose ${choice.toLocaleString('en-US')}, so ${sent.toLocaleString('en-US')} is sent.`,
	};
}

// =============================================================================
// WORDING
// =============================================================================

/**
 * An honest sentence about how reads are kept read-only on this endpoint.
 *
 * @param dialect - The parsed dialect.
 * @returns Text for the connection card and drawer.
 */
export function readBoundaryText(dialect: IGraphDialect): string {
	switch (dialect.readBoundary) {
		case 'database_role':
			return dialect.readBoundaryVerified ? 'Reads are limited by the database user: its permissions were checked and hold no write or administration grant.' : 'Reads rely on the database user’s permissions, which this node could not verify.';
		case 'read_session':
			return 'Reads use a read-only session, which is a routing hint and not access control. Connect with a read-only database user for a real guarantee.';
		case 'ro_command':
			return 'Reads use FalkorDB’s read-only command, which the server enforces.';
		case 'read_only_tx':
			return 'Reads run in a read-only transaction, which the database enforces.';
		default:
			return 'This node did not say how it keeps reads read-only.';
	}
}

/**
 * One-line engine text for a card ("Neo4j 5.26.31 Community").
 *
 * @param dialect - The parsed dialect.
 * @returns Engine, version and edition.
 */
export function engineText(dialect: IGraphDialect): string {
	const name = dialect.engineName ?? { age: 'Apache AGE', neo4j: 'Neo4j', falkordb: 'FalkorDB' }[dialect.dialect];
	const edition = dialect.edition ? ` ${dialect.edition.charAt(0).toUpperCase()}${dialect.edition.slice(1)}` : '';
	return `${name}${dialect.engineVersion ? ` ${dialect.engineVersion}` : ''}${edition}`;
}

/**
 * The database or graph the endpoint points at ("graph rocketride", "database neo4j").
 *
 * @param dialect - The parsed dialect.
 * @returns Text, or null when the node did not say.
 */
export function targetText(dialect: IGraphDialect): string | null {
	if (dialect.graph) return `graph ${dialect.graph}`;
	if (dialect.database) return `database ${dialect.database}`;
	return null;
}
