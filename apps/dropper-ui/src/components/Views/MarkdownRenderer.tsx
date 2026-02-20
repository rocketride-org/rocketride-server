/**
 * MIT License
 * Copyright (c) 2026 RocketRide, Inc.
 * See LICENSE file for details.
 */

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

/**
 * Props for the MarkdownRenderer component
 */
interface MarkdownRendererProps {
	/** Markdown-formatted string to render as HTML */
	content: string;
}

/**
 * MarkdownRenderer - Advanced markdown parser with syntax highlighting
 * 
 * Renders markdown content with GitHub Flavored Markdown (GFM) support and
 * custom styling. This component provides a rich text display experience with:
 * 
 * Features:
 * - GitHub Flavored Markdown (tables, strikethrough, task lists, etc.)
 * - Syntax-highlighted code blocks using Prism
 * - Custom table styling with responsive wrapper
 * - External links with proper security attributes
 * - Styled blockquotes and lists
 * - Inline code highlighting
 * - Safe rendering (escapes potentially dangerous HTML)
 * 
 * Code Block Support:
 * - Detects language from code fence (```language)
 * - Applies syntax highlighting for 100+ languages
 * - Uses oneDark theme for consistent appearance
 * - Inline code uses simple background styling
 * 
 * Security:
 * - External links open in new tab with rel="noopener noreferrer"
 * - Does not render raw HTML to prevent XSS and invalid tag errors
 * - All content is escaped by default
 * 
 * Styling:
 * - Custom CSS classes applied via markdown-* prefixes
 * - Integrates with application's design system
 * - Responsive tables with horizontal scroll wrapper
 * 
 * @component
 * @example
 * ```tsx
 * <MarkdownRenderer content={`
 * # Hello World
 * 
 * Here's some **bold** text and a [link](https://example.com).
 * 
 * \`\`\`javascript
 * console.log('Syntax highlighted!');
 * \`\`\`
 * `} />
 * ```
 * 
 * @param props - Component props
 * @param props.content - Markdown string to render
 */
export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
	return (
		<ReactMarkdown
			// Enable GitHub Flavored Markdown extensions
			remarkPlugins={[remarkGfm]}
			// NOTE: rehypeRaw removed to prevent invalid HTML tags from PDFs
			// Custom component renderers for specific elements
			components={{
				/**
				 * Code block renderer with syntax highlighting
				 * Distinguishes between inline code and code blocks
				 */
				code: (props: any) => {
					const { inline, className, children, ...rest } = props;
					// Extract language from className (format: language-xxx)
					const match = /language-(\w+)/.exec(className || '');
					// Remove trailing newline from code content
					const codeContent = String(children).replace(/\n$/, '');

					// Render syntax-highlighted block for non-inline code with language
					return !inline && match ? (
						<SyntaxHighlighter
							style={oneDark}
							language={match[1]}
							PreTag="div"
							customStyle={{
								margin: 0,
								borderRadius: '6px',
								fontSize: '14px'
							}}
						>
							{codeContent}
						</SyntaxHighlighter>
					) : (
						// Render simple inline code with background
						<code className={className} {...rest}>
							{children}
						</code>
					);
				},

				/**
				 * Table renderer with responsive wrapper
				 * Prevents table overflow on small screens
				 */
				table: (props) => {
					return (
						<div className="table-wrapper">
							<table className="markdown-table">
								{props.children}
							</table>
						</div>
					);
				},

				/**
				 * Link renderer with security attributes
				 * Opens external links in new tab safely
				 */
				a: (props) => {
					return (
						<a
							href={props.href}
							target="_blank"
							rel="noopener noreferrer"
							className="markdown-link"
						>
							{props.children}
						</a>
					);
				},

				/**
				 * Blockquote renderer with custom styling
				 */
				blockquote: (props) => {
					return (
						<blockquote className="markdown-blockquote">
							{props.children}
						</blockquote>
					);
				},

				/**
				 * Unordered list renderer with custom styling
				 */
				ul: (props) => {
					return <ul className="markdown-list">{props.children}</ul>;
				},

				/**
				 * Ordered list renderer with custom styling
				 */
				ol: (props) => {
					return <ol className="markdown-list">{props.children}</ol>;
				}
			}}
		>
			{content}
		</ReactMarkdown>
	);
};
