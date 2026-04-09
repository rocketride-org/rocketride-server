// =============================================================================
// Trace Renderer: Table Lane
//
// Text in markdown table format. Parses and renders as an actual HTML table.
// =============================================================================

import { ReactElement } from 'react';
import type { CSSProperties } from 'react';

// =============================================================================
// TYPE GUARD
// =============================================================================

interface TableData {
	text: string;
	length?: number;
}

export function isTable(data: unknown): data is TableData {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	return typeof d.text === 'string';
}

// =============================================================================
// SUMMARY
// =============================================================================

export function summaryTable(data: TableData): string {
	// Count rows for summary
	const lines = data.text.split('\n').filter((l) => l.trim().startsWith('|'));
	const dataRows = lines.filter((l) => !l.match(/^\|[\s-:|]+\|$/));
	return `${dataRows.length} rows`;
}

// =============================================================================
// MARKDOWN TABLE PARSER
// =============================================================================

function parseMarkdownTable(text: string): { headers: string[]; rows: string[][] } | null {
	const lines = text
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.startsWith('|'));
	if (lines.length < 2) return null;

	const parseLine = (line: string): string[] =>
		line
			.split('|')
			.slice(1, -1)
			.map((cell) => cell.trim());

	const headers = parseLine(lines[0]);

	// Skip separator line (line with dashes)
	const dataStart = lines[1].match(/^[\s|:-]+$/) ? 2 : 1;
	const rows = lines.slice(dataStart).map(parseLine);

	if (headers.length === 0) return null;
	return { headers, rows };
}

// =============================================================================
// RENDERER
// =============================================================================

const tableStyles = {
	table: {
		width: '100%',
		borderCollapse: 'collapse',
		fontSize: 11,
		fontFamily: 'var(--rr-font-mono, monospace)',
	} as CSSProperties,
	th: {
		textAlign: 'left',
		padding: '4px 8px',
		borderBottom: '2px solid var(--rr-border)',
		fontSize: 10,
		fontWeight: 700,
		color: 'var(--rr-text-secondary)',
		textTransform: 'uppercase',
		letterSpacing: '0.04em',
	} as CSSProperties,
	td: {
		padding: '3px 8px',
		borderBottom: '1px solid var(--rr-border-subtle, rgba(0,0,0,0.04))',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
};

export function renderTable(data: TableData): ReactElement {
	const parsed = parseMarkdownTable(data.text);

	if (!parsed) {
		// Fallback: just show the text
		return (
			<div>
				<div style={{ backgroundColor: 'var(--rr-bg-paper)', borderRadius: 4, padding: '6px 8px', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflow: 'auto', borderLeft: '3px solid var(--rr-chart-yellow)' }}>{data.text}</div>
			</div>
		);
	}

	return (
		<div style={{ overflow: 'auto', maxHeight: 300 }}>
			<table style={tableStyles.table}>
				<thead>
					<tr>
						{parsed.headers.map((h, i) => (
							<th key={i} style={tableStyles.th}>
								{h}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{parsed.rows.map((row, ri) => (
						<tr key={ri}>
							{row.map((cell, ci) => (
								<td key={ci} style={tableStyles.td}>
									{cell}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
			<div style={{ fontSize: 10, color: 'var(--rr-text-secondary)', marginTop: 4 }}>
				{parsed.rows.length} rows {'\u00B7'} {parsed.headers.length} columns
			</div>
		</div>
	);
}
