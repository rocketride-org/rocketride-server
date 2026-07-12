// =============================================================================
// JsonTree — Recursive collapsible JSON viewer
// =============================================================================

import React, { useState } from 'react';
import { styles } from '../styles';

interface JsonTreeProps {
	data: unknown;
	depth?: number;
	label?: string;
}

const COLLAPSE_DEPTH = 2;

const JsonTree: React.FC<JsonTreeProps> = ({ data, depth = 0, label }) => {
	const [collapsed, setCollapsed] = useState(depth >= COLLAPSE_DEPTH);

	const indent = '  '.repeat(depth);
	const childIndent = '  '.repeat(depth + 1);

	// Primitives
	if (data === null) {
		return (
			<div style={styles.jsonLine}>
				{indent}{label !== undefined && <><span style={styles.jsonKey}>{label}</span>: </>}
				<span style={styles.jsonNull}>null</span>
			</div>
		);
	}

	if (data === undefined) {
		return (
			<div style={styles.jsonLine}>
				{indent}{label !== undefined && <><span style={styles.jsonKey}>{label}</span>: </>}
				<span style={styles.jsonNull}>undefined</span>
			</div>
		);
	}

	if (typeof data === 'string') {
		const display = data.length > 200 ? data.slice(0, 200) + '...' : data;
		return (
			<div style={styles.jsonLine}>
				{indent}{label !== undefined && <><span style={styles.jsonKey}>{label}</span>: </>}
				<span style={styles.jsonString}>"{display}"</span>
			</div>
		);
	}

	if (typeof data === 'number') {
		return (
			<div style={styles.jsonLine}>
				{indent}{label !== undefined && <><span style={styles.jsonKey}>{label}</span>: </>}
				<span style={styles.jsonNumber}>{data}</span>
			</div>
		);
	}

	if (typeof data === 'boolean') {
		return (
			<div style={styles.jsonLine}>
				{indent}{label !== undefined && <><span style={styles.jsonKey}>{label}</span>: </>}
				<span style={styles.jsonBool}>{String(data)}</span>
			</div>
		);
	}

	// Arrays
	if (Array.isArray(data)) {
		if (data.length === 0) {
			return (
				<div style={styles.jsonLine}>
					{indent}{label !== undefined && <><span style={styles.jsonKey}>{label}</span>: </>}
					<span style={styles.jsonBracket}>[]</span>
				</div>
			);
		}

		return (
			<div>
				<div style={styles.jsonLine}>
					{indent}{label !== undefined && <><span style={styles.jsonKey}>{label}</span>: </>}
					<span style={styles.jsonToggle} onClick={() => setCollapsed(!collapsed)}>
						{collapsed ? '\u25b6' : '\u25bc'}
					</span>
					<span style={styles.jsonBracket}>[</span>
					{collapsed && (
						<span style={styles.jsonNull}> {data.length} items </span>
					)}
					{collapsed && <span style={styles.jsonBracket}>]</span>}
				</div>
				{!collapsed && (
					<>
						{data.map((item, i) => (
							<JsonTree key={i} data={item} depth={depth + 1} label={String(i)} />
						))}
						<div style={styles.jsonLine}>{childIndent}<span style={styles.jsonBracket}>]</span></div>
					</>
				)}
			</div>
		);
	}

	// Objects
	if (typeof data === 'object') {
		const entries = Object.entries(data as Record<string, unknown>);

		if (entries.length === 0) {
			return (
				<div style={styles.jsonLine}>
					{indent}{label !== undefined && <><span style={styles.jsonKey}>{label}</span>: </>}
					<span style={styles.jsonBracket}>{'{}'}</span>
				</div>
			);
		}

		return (
			<div>
				<div style={styles.jsonLine}>
					{indent}{label !== undefined && <><span style={styles.jsonKey}>{label}</span>: </>}
					<span style={styles.jsonToggle} onClick={() => setCollapsed(!collapsed)}>
						{collapsed ? '\u25b6' : '\u25bc'}
					</span>
					<span style={styles.jsonBracket}>{'{'}</span>
					{collapsed && (
						<span style={styles.jsonNull}> {entries.length} keys </span>
					)}
					{collapsed && <span style={styles.jsonBracket}>{'}'}</span>}
				</div>
				{!collapsed && (
					<>
						{entries.map(([key, value]) => (
							<JsonTree key={key} data={value} depth={depth + 1} label={key} />
						))}
						<div style={styles.jsonLine}>{childIndent}<span style={styles.jsonBracket}>{'}'}</span></div>
					</>
				)}
			</div>
		);
	}

	// Fallback
	return (
		<div style={styles.jsonLine}>
			{indent}{label !== undefined && <><span style={styles.jsonKey}>{label}</span>: </>}
			<span>{String(data)}</span>
		</div>
	);
};

export default JsonTree;
