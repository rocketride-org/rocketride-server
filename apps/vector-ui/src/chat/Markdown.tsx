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
// VECTOR-UI — Markdown (renders a chat answer from the safe node tree)
// =============================================================================
//
// Renders what src/vector/markdown.ts parsed, with plain React elements only:
// text is always a React child (escaped), links carry LINK_REL and open in a
// new tab, code is <pre><code>. No element here can load a resource or run
// anything, whatever the answer says. Theme tokens only; no 'shell' import.
// =============================================================================

import React, { useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { LINK_REL, parseMarkdown } from '../vector/markdown';
import type { MdAlign, MdBlock, MdInline } from '../vector/markdown';

/** Props of {@link Markdown}. */
export interface MarkdownProps {
	/** The answer text. */
	text: string;
	/** Characters parsed before the answer is cut with an ellipsis. */
	maxChars?: number;
}

const S = {
	root: { fontSize: 13, lineHeight: 1.55, color: 'var(--rr-text-primary)', overflowWrap: 'anywhere' } as CSSProperties,
	p: { margin: '4px 0' } as CSSProperties,
	heading: { margin: '8px 0 4px', fontSize: 13, fontWeight: 600, color: 'var(--rr-text-primary)' } as CSSProperties,
	pre: { margin: '6px 0', padding: 8, borderRadius: 4, overflowX: 'auto', background: 'var(--rr-bg-widget)', border: '1px solid var(--rr-border)', fontSize: 12 } as CSSProperties,
	codeBlock: { fontFamily: 'var(--rr-font-mono, monospace)', whiteSpace: 'pre' } as CSSProperties,
	code: { fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 12, padding: '0 3px', borderRadius: 3, background: 'var(--rr-bg-widget)', border: '1px solid var(--rr-border)' } as CSSProperties,
	list: { margin: '4px 0', paddingLeft: 20 } as CSSProperties,
	quote: { margin: '6px 0', paddingLeft: 10, borderLeft: '3px solid var(--rr-border)', color: 'var(--rr-text-secondary)' } as CSSProperties,
	rule: { border: 0, borderTop: '1px solid var(--rr-border)', margin: '8px 0' } as CSSProperties,
	tableWrap: { overflowX: 'auto', margin: '6px 0' } as CSSProperties,
	table: { borderCollapse: 'collapse', fontSize: 12 } as CSSProperties,
	cell: { padding: '4px 8px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	link: { color: 'var(--rr-text-link)', textDecoration: 'underline' } as CSSProperties,
};

/**
 * Render inline nodes.
 *
 * @param nodes - The nodes.
 * @returns React children.
 */
function renderInline(nodes: readonly MdInline[]): ReactNode[] {
	return nodes.map((node, index) => {
		switch (node.type) {
			case 'text':
				return node.text;
			case 'code':
				return (
					<code key={index} style={S.code}>
						{node.text}
					</code>
				);
			case 'strong':
				return <strong key={index}>{renderInline(node.children)}</strong>;
			case 'em':
				return <em key={index}>{renderInline(node.children)}</em>;
			case 'del':
				return <del key={index}>{renderInline(node.children)}</del>;
			case 'link':
				return (
					<a key={index} href={node.href} target="_blank" rel={LINK_REL} style={S.link}>
						{renderInline(node.children)}
					</a>
				);
			case 'break':
				return <br key={index} />;
		}
		return null;
	});
}

/**
 * CSS text-align of a table column.
 *
 * @param align - The column's alignment.
 * @returns The style.
 */
function cellStyle(align: MdAlign | undefined): CSSProperties {
	return align ? { ...S.cell, textAlign: align } : S.cell;
}

/**
 * Render blocks.
 *
 * @param blocks - The blocks.
 * @returns React children.
 */
function renderBlocks(blocks: readonly MdBlock[]): ReactNode[] {
	return blocks.map((block, index) => {
		switch (block.type) {
			case 'paragraph':
				return (
					<p key={index} style={S.p}>
						{renderInline(block.children)}
					</p>
				);
			case 'heading': {
				// Answers sit deep inside the console; their headings start at h3.
				const Tag = `h${Math.min(6, block.level + 2)}` as 'h3' | 'h4' | 'h5' | 'h6';
				return (
					<Tag key={index} style={S.heading}>
						{renderInline(block.children)}
					</Tag>
				);
			}
			case 'code':
				return (
					<pre key={index} style={S.pre}>
						<code style={S.codeBlock} data-lang={block.lang ?? undefined}>
							{block.text}
						</code>
					</pre>
				);
			case 'list': {
				const items = block.items.map((item, at) => <li key={at}>{renderBlocks(item)}</li>);
				return block.ordered ? (
					<ol key={index} style={S.list} start={block.start !== 1 ? block.start : undefined}>
						{items}
					</ol>
				) : (
					<ul key={index} style={S.list}>
						{items}
					</ul>
				);
			}
			case 'quote':
				return (
					<blockquote key={index} style={S.quote}>
						{renderBlocks(block.children)}
					</blockquote>
				);
			case 'rule':
				return <hr key={index} style={S.rule} />;
			case 'table':
				return (
					<div key={index} style={S.tableWrap}>
						<table style={S.table}>
							<thead>
								<tr>
									{block.header.map((cell, column) => (
										<th key={column} scope="col" style={cellStyle(block.align[column])}>
											{renderInline(cell)}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{block.rows.map((row, at) => (
									<tr key={at}>
										{row.map((cell, column) => (
											<td key={column} style={cellStyle(block.align[column])}>
												{renderInline(cell)}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				);
		}
		return null;
	});
}

/**
 * A chat answer rendered as safe Markdown.
 *
 * @param props - {@link MarkdownProps}.
 * @returns The rendered answer.
 */
export function Markdown({ text, maxChars }: MarkdownProps): React.ReactElement {
	const blocks = useMemo(() => parseMarkdown(text, { maxChars }), [text, maxChars]);
	return (
		<div style={S.root} data-markdown="answer">
			{renderBlocks(blocks)}
		</div>
	);
}

export default Markdown;
