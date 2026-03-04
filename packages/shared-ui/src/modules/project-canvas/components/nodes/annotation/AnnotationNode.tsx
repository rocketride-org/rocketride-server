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

import { ReactElement, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Typography } from '@mui/material';
import { Node as NodeProps, NodeResizer } from '@xyflow/react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

import { styles } from './index.style';
import ProjectNodeHeader from '../../node-header/ProjectNodeHeader';
import { NodeType } from '../../../../../constants';
import { INodeData } from '../../../types';

/** Default background color for annotation nodes (light yellow). */
const DEFAULT_BG_COLOR = '#fff9c4';
/** Default foreground/text color for annotation nodes. */
const DEFAULT_FG_COLOR = '#000000';

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

/**
 * Renders an annotation (sticky-note) node on the project canvas.
 *
 * Annotation nodes display user-written markdown content with customizable
 * foreground and background colors. They look like regular pipeline nodes
 * but with the title bar hidden until hover, providing a clean note-like
 * appearance. Configuration (content, colors) is done through the standard
 * NodePanel accessed via the gear icon.
 *
 * @param id - Unique identifier of this node within the flow.
 * @param type - The node type discriminator (NodeType.Annotation).
 * @param parentId - Optional parent group node id.
 * @param data - Node data containing content, fgColor, bgColor, and name.
 */
export default function AnnotationNode({ id, type, parentId, data, selected }: NodeProps): ReactElement {
	const { t } = useTranslation();
	const nodeData = data as INodeData;

	const bgColor = (nodeData.bgColor as string) || DEFAULT_BG_COLOR;
	const fgColor = (nodeData.fgColor as string) || DEFAULT_FG_COLOR;
	const title = (nodeData.name as string) || t('flow.annotationNode.title', 'Note');

	// Unescape legacy `\\n` sequences from older serialization format
	const content = useMemo(() => {
		const raw = nodeData.content as string;
		if (!raw) return '';
		return raw.replace(/\\n/g, '\n');
	}, [nodeData.content]);

	return (
		<>
			<NodeResizer
				minWidth={120}
				minHeight={80}
				isVisible={selected === true}
				lineStyle={{ borderWidth: 0, background: 'transparent' }}
				color="#DCDCDC"
			/>
			<Box
				sx={{
					...styles.root,
					backgroundColor: bgColor,
					color: fgColor,
				}}
				className="nowheel"
			>
				{/* Header — hidden until hover via CSS */}
				<Box sx={{ ...styles.header, color: 'text.primary' }} className="annotation-header">
					<ProjectNodeHeader
						id={id}
						title={title}
						nodeType={type as NodeType}
						parentId={parentId}
					/>
				</Box>

				{/* Content area — rendered markdown */}
				<Box sx={styles.contentArea}>
					{content ? (
						<ReactMarkdown
							remarkPlugins={[remarkGfm]}
							rehypePlugins={[rehypeRaw]}
							components={markdownComponents}
						>
							{content}
						</ReactMarkdown>
					) : (
						<Typography sx={styles.placeholder}>
							{t('flow.annotationNode.placeholder', 'Double-click gear to add content...')}
						</Typography>
					)}
				</Box>
			</Box>
		</>
	);
}
