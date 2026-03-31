import React, { useState } from 'react';

// ============================================================================
// JSON TREE VIEWER
// ============================================================================

interface JsonTreeProps {
	data: unknown;
	defaultExpanded?: number; // auto-expand to this depth (default 1)
}

interface JsonNodeProps {
	label?: string;
	value: unknown;
	depth: number;
	defaultExpandDepth: number;
}

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

const JsonNode: React.FC<JsonNodeProps> = ({ label, value, depth, defaultExpandDepth }) => {
	const isExpandable = isObject(value) || (Array.isArray(value) && value.length > 0);
	const [expanded, setExpanded] = useState(depth < defaultExpandDepth);

	if (isExpandable) {
		const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
		const bracket = Array.isArray(value) ? ['[', ']'] : ['{', '}'];

		return (
			<div className="jt-node">
				<div className="jt-row jt-expandable" onClick={() => setExpanded(!expanded)}>
					<span className="jt-arrow">{expanded ? '\u25BC' : '\u25B6'}</span>
					{label !== undefined && <span className="jt-key">{label}: </span>}
					{!expanded && <span className="jt-preview">{preview(value)}</span>}
					{expanded && <span className="jt-bracket">{bracket[0]}</span>}
				</div>
				{expanded && (
					<div className="jt-children">
						{entries.map(([k, v]) => (
							<JsonNode key={k} label={k} value={v} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} />
						))}
						<div className="jt-row">
							<span className="jt-bracket">{bracket[1]}</span>
						</div>
					</div>
				)}
			</div>
		);
	}

	// Leaf value
	let className = 'jt-val';
	let display: string;

	if (value === null) {
		className += ' jt-null';
		display = 'null';
	} else if (typeof value === 'boolean') {
		className += ' jt-bool';
		display = String(value);
	} else if (typeof value === 'number') {
		className += ' jt-num';
		display = String(value);
	} else if (typeof value === 'string') {
		className += ' jt-str';
		display = JSON.stringify(value);
	} else {
		display = String(value);
	}

	return (
		<div className="jt-node">
			<div className="jt-row">
				{label !== undefined && <span className="jt-key">{label}: </span>}
				<span className={className}>{display}</span>
			</div>
		</div>
	);
};

export const JsonTree: React.FC<JsonTreeProps> = ({ data, defaultExpanded = 1 }) => {
	if (data === undefined || data === null) {
		return <div className="jt-root jt-empty">No data</div>;
	}

	return (
		<div className="jt-root">
			<JsonNode value={data} depth={0} defaultExpandDepth={defaultExpanded} />
		</div>
	);
};
