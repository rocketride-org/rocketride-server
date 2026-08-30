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
// CANVAS — TABLE NODE (titled box with per-column FK handles)
// =============================================================================
//
// Structural adaptation of the pipeline canvas's NodeLanes row pattern: a
// titled box whose rows each own a left target handle and a right source
// handle, so FK edges anchor to the exact column.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { ErNode } from './erModel';
import { HEADER_HEIGHT, NODE_WIDTH, ROW_HEIGHT, sourceHandle, targetHandle } from './erModel';
import { TableIcon } from '../icons';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Node shell — brand ring while selected.
	node: (selected: boolean): CSSProperties => ({
		width: NODE_WIDTH,
		borderRadius: 6,
		border: `1px solid ${selected ? 'var(--rr-brand)' : 'var(--rr-border)'}`,
		boxShadow: selected ? '0 0 0 1px var(--rr-brand), 0 2px 8px rgba(0,0,0,.15)' : '0 1px 4px rgba(0,0,0,.08)',
		background: 'var(--rr-bg-paper)',
		fontSize: 11.5,
		overflow: 'hidden',
	}),

	header: {
		height: HEADER_HEIGHT,
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '0 10px',
		background: 'var(--rr-bg-widget-header)',
		borderBottom: '1px solid var(--rr-border)',
		fontWeight: 700,
		fontSize: 12,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	headerIcon: {
		width: 13,
		height: 13,
		color: 'var(--rr-text-secondary)',
		flex: 'none',
	} as CSSProperties,

	row: {
		position: 'relative',
		height: ROW_HEIGHT,
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '0 10px',
		borderBottom: '1px solid var(--rr-bg-widget)',
	} as CSSProperties,

	name: (pk: boolean): CSSProperties => ({
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 11,
		fontWeight: pk ? 700 : 400,
		color: 'var(--rr-text-primary)',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	}),

	// Key marker: PK gets the chart-yellow key, FK members the chart-red key.
	keyDot: (color: string): CSSProperties => ({
		width: 7,
		height: 7,
		borderRadius: '50%',
		flex: 'none',
		background: color,
	}),

	keySpacer: {
		width: 7,
		flex: 'none',
	} as CSSProperties,

	type: {
		marginLeft: 'auto',
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 9.5,
		color: 'var(--rr-text-disabled)',
		flex: 'none',
	} as CSSProperties,

	// Per-row handles: invisible dots on the row's vertical midline.
	handle: {
		width: 7,
		height: 7,
		border: 'none',
		background: 'transparent',
		minWidth: 0,
		minHeight: 0,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * ER table node: header (table name) + one row per column, each row carrying
 * a left target handle and a right source handle so FK edges connect column
 * to column. PK columns render bold with the yellow key dot; FK members get
 * the red dot.
 */
export const TableNode: React.FC<NodeProps<ErNode>> = ({ data, selected }) => {
	return (
		<div style={styles.node(!!selected)}>
			<div style={styles.header}>
				<span style={styles.headerIcon}>
					<TableIcon />
				</span>
				{data.table}
			</div>
			{data.columns.map((col) => (
				<div key={col.name} style={styles.row}>
					{/* FK destination anchor (left) and origin anchor (right). */}
					<Handle type="target" position={Position.Left} id={targetHandle(col.name)} style={styles.handle} isConnectable={false} />
					{col.pk ? <span style={styles.keyDot('var(--rr-chart-yellow)')} /> : col.fk ? <span style={styles.keyDot('var(--rr-chart-red)')} /> : <span style={styles.keySpacer} />}
					<span style={styles.name(col.pk)}>{col.name}</span>
					<span style={styles.type}>{col.type}</span>
					<Handle type="source" position={Position.Right} id={sourceHandle(col.name)} style={styles.handle} isConnectable={false} />
				</div>
			))}
		</div>
	);
};

export default TableNode;
