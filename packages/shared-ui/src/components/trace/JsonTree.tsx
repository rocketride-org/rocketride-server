/**
 * @file JsonTree — recursive JSON viewer for the Trace detail panel
 * @license MIT
 *
 * Ported from apps/vscode TraceSection/JsonTree.tsx.
 * All styles are inline CSSProperties objects; no external CSS files.
 * Colour tokens use the --rr-* namespace.
 */
import React, { useState, CSSProperties } from 'react';

// =============================================================================
// TYPES
// =============================================================================

interface JsonTreeProps {
	data: unknown;
	/** Auto-expand to this depth (default 1) */
	defaultExpanded?: number;
}

interface JsonNodeProps {
	label?: string;
	value: unknown;
	depth: number;
	defaultExpandDepth: number;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	root: {
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12,
		lineHeight: '18px',
		color: 'var(--rr-text-primary)',
		userSelect: 'text',
	} as CSSProperties,

	empty: {
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12,
		lineHeight: '18px',
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
		userSelect: 'text',
	} as CSSProperties,

	node: {
		/* wrapper — no special styling needed */
	} as CSSProperties,

	row: {
		display: 'flex',
		alignItems: 'baseline',
		gap: 2,
		paddingLeft: 4,
		minHeight: 18,
	} as CSSProperties,

	rowExpandable: {
		display: 'flex',
		alignItems: 'baseline',
		gap: 2,
		paddingLeft: 4,
		minHeight: 18,
		cursor: 'pointer',
	} as CSSProperties,

	arrow: {
		width: 12,
		flexShrink: 0,
		fontSize: 8,
		color: 'var(--rr-text-secondary)',
		textAlign: 'center',
	} as CSSProperties,

	key: {
		color: 'var(--rr-chart-purple, #9c27b0)',
		fontWeight: 600,
		whiteSpace: 'nowrap',
	} as CSSProperties,

	preview: {
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	} as CSSProperties,

	bracket: {
		color: 'var(--rr-text-secondary)',
		fontWeight: 600,
	} as CSSProperties,

	children: {
		paddingLeft: 14,
		borderLeft: '1px solid var(--rr-border-subtle, rgba(128,128,128,0.15))',
		marginLeft: 5,
	} as CSSProperties,

	val: {
		color: 'var(--rr-text-primary)',
		wordBreak: 'break-all',
	} as CSSProperties,

	valNull: {
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
		wordBreak: 'break-all',
	} as CSSProperties,

	valBool: {
		color: 'var(--rr-chart-blue, #1976d2)',
		fontWeight: 600,
		wordBreak: 'break-all',
	} as CSSProperties,

	valNum: {
		color: 'var(--rr-chart-green, #2e7d32)',
		wordBreak: 'break-all',
	} as CSSProperties,

	valStr: {
		color: 'var(--rr-chart-orange, #e65100)',
		wordBreak: 'break-all',
	} as CSSProperties,
} as const;

// =============================================================================
// HELPERS
// =============================================================================

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function preview(v: unknown): string {
	if (Array.isArray(v)) return `Array(${v.length})`;
	if (isObject(v)) {
		const keys = Object.keys(v);
		if (keys.length === 0) return '{}';
		if (keys.length <= 3) return `{ ${keys.join(', ')} }`;
		return `{ ${keys.slice(0, 3).join(', ')}, \u2026 }`;
	}
	return '';
}

// =============================================================================
// SUB-COMPONENT: JsonNode (recursive)
// =============================================================================

const JsonNode: React.FC<JsonNodeProps> = ({ label, value, depth, defaultExpandDepth }) => {
	const isExpandable = isObject(value) || (Array.isArray(value) && value.length > 0);
	const [expanded, setExpanded] = useState(depth < defaultExpandDepth);

	if (isExpandable) {
		const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
		const bracket = Array.isArray(value) ? ['[', ']'] : ['{', '}'];

		return (
			<div style={styles.node}>
				<div style={styles.rowExpandable} onClick={() => setExpanded(!expanded)}>
					<span style={styles.arrow}>{expanded ? '\u25BC' : '\u25B6'}</span>
					{label !== undefined && <span style={styles.key}>{label}:&nbsp;</span>}
					{!expanded && <span style={styles.preview}>{preview(value)}</span>}
					{expanded && <span style={styles.bracket}>{bracket[0]}</span>}
				</div>
				{expanded && (
					<div style={styles.children}>
						{entries.map(([k, v]) => (
							<JsonNode key={k} label={k} value={v} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} />
						))}
						<div style={styles.row}>
							<span style={styles.bracket}>{bracket[1]}</span>
						</div>
					</div>
				)}
			</div>
		);
	}

	// Leaf value
	let valStyle: CSSProperties = styles.val;
	let display: string;

	if (value === null) {
		valStyle = styles.valNull;
		display = 'null';
	} else if (typeof value === 'boolean') {
		valStyle = styles.valBool;
		display = String(value);
	} else if (typeof value === 'number') {
		valStyle = styles.valNum;
		display = String(value);
	} else if (typeof value === 'string') {
		valStyle = styles.valStr;
		display = JSON.stringify(value);
	} else {
		display = String(value);
	}

	return (
		<div style={styles.node}>
			<div style={styles.row}>
				{label !== undefined && <span style={styles.key}>{label}:&nbsp;</span>}
				<span style={valStyle}>{display}</span>
			</div>
		</div>
	);
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export const JsonTree: React.FC<JsonTreeProps> = ({ data, defaultExpanded = 1 }) => {
	if (data === undefined || data === null) {
		return <div style={styles.empty}>No data</div>;
	}

	return (
		<div style={styles.root}>
			<JsonNode value={data} depth={0} defaultExpandDepth={defaultExpanded} />
		</div>
	);
};
