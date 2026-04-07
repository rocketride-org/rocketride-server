// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

/**
 * NodeAnnotation — Sticky-note style node for the flow canvas.
 *
 * Displays user-written markdown content with customizable foreground and
 * background colors. The header (title + gear icon) is hidden until hover,
 * giving a clean note-like appearance. Configuration (content, colors) is
 * done through the standard NodePanel accessed via the gear icon.
 *
 * Supports:
 *   - Markdown rendering with GFM tables, raw HTML, and syntax-highlighted code blocks
 *   - Resizable dimensions via NodeResizer (visible when selected)
 *   - Custom foreground and background colors (defaults to yellow sticky-note)
 */

import { ReactElement, useMemo } from 'react';
import { NodeResizer } from '@xyflow/react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

import { INodeData, INodeType } from '../../../types';
import ConditionalRender from '../../ConditionalRender';
import NodeHeader from '../node-component/header';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	/** Root container — fills the ReactFlow node wrapper, hides overflow. Hover reveal handled by .rr-annotation-root CSS class. */
	root: {
		position: 'relative' as const,
		width: '100%',
		height: '100%',
		borderRadius: '5px',
		border: 'none',
		outline: 'none',
		boxShadow: 'none',
		overflow: 'hidden',
		display: 'flex',
		flexDirection: 'column' as const,
	},

	/** Header bar — absolutely positioned, invisible until parent hover (via CSS). */
	header: {
		position: 'absolute' as const,
		top: 0,
		left: 0,
		right: 0,
		zIndex: 1,
		opacity: 0,
		pointerEvents: 'none' as const,
		transition: 'opacity 0.2s ease',
		borderRadius: '5px 5px 0 0',
	},

	/** Placeholder text shown when the annotation has no content. */
	placeholder: {
		color: 'var(--rr-text-disabled)',
		fontStyle: 'italic' as const,
		fontSize: '0.7rem',
	},
};

// =============================================================================
// Constants
// =============================================================================

/** Default background color for annotation nodes (light yellow). */
const DEFAULT_BG_COLOR = 'var(--rr-annotation-bg-default)';
/** Default foreground/text color for annotation nodes. */
const DEFAULT_FG_COLOR = 'var(--rr-text-primary)';

// =============================================================================
// Markdown components
// =============================================================================

/**
 * Custom component renderers for react-markdown.
 * Provides syntax-highlighted code blocks and safe external links.
 */
const markdownComponents = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	code: (props: any) => {
		const { inline, className, children, ...rest } = props;
		const match = /language-(\w+)/.exec(className || '');
		const codeContent = String(children).replace(/\n$/, '');

		return !inline && match ? (
			<SyntaxHighlighter
				style={oneDark}
				language={match[1]}
				PreTag="div"
				customStyle={{
					margin: 0,
					borderRadius: '4px',
					fontSize: '0.65rem',
				}}
			>
				{codeContent}
			</SyntaxHighlighter>
		) : (
			<code className={className} {...rest}>
				{children}
			</code>
		);
	},
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	a: (props: any) => (
		<a href={props.href} target="_blank" rel="noopener noreferrer">
			{props.children}
		</a>
	),
};

// =============================================================================
// Props
// =============================================================================

interface INodeAnnotationProps {
	/** Unique node ID assigned by ReactFlow. */
	id: string;
	/** Node data containing annotation content, colors, etc. */
	data: INodeData;
	/** Node type discriminator. */
	type?: string;
	/** Whether this node is currently selected. */
	selected?: boolean;
	/** Parent group ID, if any. */
	parentId?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders an annotation (sticky-note) node on the flow canvas.
 *
 * Receives flat props from ReactFlow.
 *
 * @returns The rendered annotation node.
 */
export default function NodeAnnotation({ id, data, type, parentId, selected }: INodeAnnotationProps): ReactElement {
	// Annotation-specific display fields from node config
	const bgColor = (data.config?.bgColor as string) || DEFAULT_BG_COLOR;
	const fgColor = (data.config?.fgColor as string) || DEFAULT_FG_COLOR;
	const title = data.name || 'Note';

	// Unescape legacy `\\n` sequences from older serialization format
	const content = useMemo(() => {
		const raw = data.config?.content as string;
		if (!raw) return '';
		return raw.replace(/\\n/g, '\n');
	}, [data.config?.content]);

	return (
		<>
			{/* Resize handles — only visible when the node is selected */}
			<NodeResizer minWidth={120} minHeight={80} isVisible={selected === true} lineStyle={{ borderWidth: 0, background: 'transparent' }} color="var(--rr-border)" />

			<div
				style={{
					...styles.root,
					backgroundColor: bgColor,
					color: fgColor,
				}}
				className="nowheel rr-annotation-root"
			>
				{/* Header — hidden until hover via CSS */}
				<div style={{ ...styles.header, color: 'var(--rr-text-primary)' }} className="annotation-header">
					<NodeHeader id={id} title={title} nodeType={type as INodeType} parentId={parentId} />
				</div>

				{/* Content area — rendered markdown */}
				<div className="rr-annotation-content">
					<ConditionalRender condition={content} fallback={<span style={styles.placeholder}>Double-click gear to add content...</span>}>
						<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={markdownComponents}>
							{content}
						</ReactMarkdown>
					</ConditionalRender>
				</div>
			</div>
		</>
	);
}
