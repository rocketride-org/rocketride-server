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
// SQL-UI — EXPLAIN PANEL (the query plan drawer)
// =============================================================================
//
// Self-contained: give it an endpoint, a dialect and the statement exactly as
// it would run, and it performs the EXPLAIN itself through the connection's
// session. Nothing here executes the statement — plain EXPLAIN only, no
// ANALYZE, in any dialect.
//
// THE RAW OUTPUT IS THE DEFAULT VIEW. The interpreted tree is a convenience
// layered over text the database actually sent; when the plan shape is not one
// the parser recognises, that is an INFO note next to the raw output, never an
// error, because nothing went wrong on the database's side.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, Button, DetailPanel, EmptyState, ToggleGroup, useShellConnection } from 'shell';
import type { ISqlEndpoint, SqlDialect } from '../connect';
import { announce } from '../a11y/announce';
import { getSession } from '../schema/schemaStore';
import { ALLOW_EXECUTE_OFF_TEXT, DATABASE_SAID_LABEL, GENERIC_ERROR_TEXT, describeFailure, maxRowsText } from '../sql/failure';
import type { PlanParseResult } from '../sql/explain';
import { buildExplain, countPlanNodes, formatRawPlan, parseExplain } from '../sql/explain';
import { PlanTree } from './PlanTree';
import { DatabaseIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link ExplainPanel} component. */
export interface IExplainPanelProps {
	/** The connection to explain against. */
	endpoint: ISqlEndpoint;
	/** The connection's dialect (drives the EXPLAIN form and the empty state). */
	dialect: SqlDialect;
	/**
	 * The statement to explain, EXACTLY as it would run — the same text Run
	 * would send, including any LIMIT the results header applied. The panel
	 * only prefixes the dialect's EXPLAIN form; it never rewrites the body.
	 */
	sql: string;
	/** Whether the drawer is open. The EXPLAIN runs when this turns true. */
	open: boolean;
	/** Fired when the user dismisses the drawer. */
	onClose: () => void;
}

/** Which view of the plan the drawer is showing. */
type PlanView = 'raw' | 'interpreted';

/** A finished EXPLAIN round trip. */
interface IExplainResult {
	/** Wall-clock ms the result landed at. */
	at: number;
	/** Round-trip seconds, measured client-side. */
	seconds: number;
	/** The database's output as text. */
	raw: string;
	/** The interpretation attempt (a miss is a normal outcome). */
	parsed: PlanParseResult;
}

// =============================================================================
// TEXT
// =============================================================================

/** Shown on the Interpreted tab when the plan shape is not one the parser knows. */
const PARSE_MISS = 'Could not interpret this plan shape; raw output shown';

/**
 * Format a wall-clock time as HH:MM.
 *
 * @param ms - Unix milliseconds.
 * @returns The local time, zero-padded.
 */
function clockTime(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Raw output: focusable so a keyboard reader can scroll it.
	raw: {
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12,
		lineHeight: 1.6,
		whiteSpace: 'pre-wrap' as const,
		wordBreak: 'break-word' as const,
		margin: 0,
		padding: 10,
		background: 'var(--rr-bg-widget)',
		borderRadius: 4,
		maxHeight: '60vh',
		overflow: 'auto',
	} as CSSProperties,

	toggleRow: {
		marginBottom: 12,
	} as CSSProperties,

	gap: {
		marginBottom: 12,
	} as CSSProperties,
};

/** The view options; raw output leads because it is what the database sent. */
const VIEW_OPTIONS: { id: PlanView; label: string }[] = [
	{ id: 'raw', label: 'Raw output' },
	{ id: 'interpreted', label: 'Interpreted' },
];

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The query plan drawer. Runs a plain EXPLAIN for the given statement and
 * shows the database's raw output, with an interpreted tree beside it when the
 * plan shape is one the parser recognises.
 *
 * Every number the tree shows is a planner ESTIMATE: plain EXPLAIN does not run
 * the statement, so nothing here was measured.
 */
export const ExplainPanel: React.FC<IExplainPanelProps> = ({ endpoint, dialect, sql, open, onClose }) => {
	const { client } = useShellConnection();
	const [view, setView] = useState<PlanView>('raw');
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<IExplainResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	// The verbatim driver text starts collapsed on every run.
	const [showVerbatim, setShowVerbatim] = useState(false);

	const notice = useMemo(() => (error === null ? null : describeFailure(error)), [error]);

	const explainSql = useMemo(() => buildExplain(dialect, sql), [dialect, sql]);

	/**
	 * Run the EXPLAIN and record what came back.
	 *
	 * @param signal - Set when the effect that started this call was torn down.
	 */
	const run = useCallback(async (signal: { cancelled: boolean }): Promise<void> => {
		if (!client || !explainSql) return;
		setRunning(true);
		setError(null);
		setResult(null);
		setShowVerbatim(false);
		const started = Date.now();
		try {
			const session = getSession(client, endpoint);
			// Plain EXPLAIN only plans, so re-running it after a token refresh
			// cannot change anything on the database.
			const { rows } = await session.execute(explainSql, { idempotent: true });
			if (signal.cancelled) return;
			const at = Date.now();
			const parsed = parseExplain(dialect, rows);
			setResult({
				at,
				seconds: (at - started) / 1000,
				raw: formatRawPlan(rows),
				parsed,
			});
			// The plan itself is a tree and a `pre`, neither of which announces
			// itself the way a Banner does — so say that it arrived.
			announce(parsed.ok ? `Plan ready: ${countPlanNodes(parsed.root)} nodes` : 'Plan ready: raw output shown');
		} catch (err) {
			if (signal.cancelled) return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (!signal.cancelled) setRunning(false);
		}
	}, [client, endpoint, dialect, explainSql]);

	// Opening the drawer (or changing the statement while it is open) explains.
	useEffect(() => {
		if (!open || !explainSql) return;
		// A response landing after the drawer closed must not set state.
		const signal = { cancelled: false };
		// Raw output leads every time: a previous session's Interpreted choice
		// must not hide a new plan's actual text behind a parse miss.
		setView('raw');
		void run(signal);
		return () => { signal.cancelled = true; };
	}, [open, explainSql, run]);

	const meta = result
		? `EXPLAIN ran ${clockTime(result.at)} · round trip ${result.seconds.toFixed(3)} s · Planner estimates, not measurements.`
		: undefined;

	// ── Body ─────────────────────────────────────────────────────────────────

	let body: React.ReactNode;
	if (!explainSql) {
		body = (
			<EmptyState
				icon={<DatabaseIcon />}
				title="No plan available"
				description={`EXPLAIN is not available for ${dialect} in SQL Explorer`}
			/>
		);
	} else if (notice) {
		body = (
			<Banner variant="error">
				{/* A node that predates the error-text fix returns its own
				    placeholder. Say the message is missing rather than quoting
				    the placeholder as if the database had said it. */}
				<div>{notice.generic ? GENERIC_ERROR_TEXT : notice.headline}</div>
				{notice.allowExecuteOff && <div>{ALLOW_EXECUTE_OFF_TEXT}</div>}
				{notice.maxExecuteRows !== null && <div>{maxRowsText(notice.maxExecuteRows)}</div>}
				{!notice.generic && notice.verbatim && (
					<>
						<Button
							variant="ghost"
							small
							ariaExpanded={showVerbatim}
							onClick={() => setShowVerbatim((shown) => !shown)}
						>
							{showVerbatim ? `Hide “${DATABASE_SAID_LABEL}”` : DATABASE_SAID_LABEL}
						</Button>
						{showVerbatim && <pre style={styles.raw} tabIndex={0} aria-label="Database error text">{notice.verbatim}</pre>}
					</>
				)}
			</Banner>
		);
	} else if (!client) {
		// `run` returns before sending anything when there is no client, so
		// `running` never becomes true and `result` never arrives: the
		// "Explaining…" state below would claim work that was never started.
		body = <EmptyState icon={<DatabaseIcon />} title="Not connected" description="The plan cannot be read while the shell connection is down." />;
	} else if (running || !result) {
		body = <EmptyState icon={<DatabaseIcon />} title="Explaining…" description="Asking the database how it would run this statement." />;
	} else {
		body = (
			<>
				<div style={styles.toggleRow}>
					<ToggleGroup<PlanView> options={VIEW_OPTIONS} value={view} onChange={setView} />
				</div>
				{view === 'raw' ? (
					<pre style={styles.raw} tabIndex={0} aria-label="Raw EXPLAIN output">{result.raw}</pre>
				) : result.parsed.ok ? (
					<PlanTree root={result.parsed.root} />
				) : (
					<>
						{/* A shape the parser does not know is not a failure. */}
						<div style={styles.gap}><Banner variant="info">{PARSE_MISS}</Banner></div>
						<pre style={styles.raw} tabIndex={0} aria-label="Raw EXPLAIN output">{result.raw}</pre>
					</>
				)}
			</>
		);
	}

	return (
		<DetailPanel
			open={open}
			onClose={onClose}
			title="Plan"
			subtitle={meta}
			side="right"
			modeless
			width={620}
		>
			{body}
		</DetailPanel>
	);
};

export default ExplainPanel;
