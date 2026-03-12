/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ChartJsRenderer } from './ChartJsRenderer';

interface MarkdownRendererProps {
	content: string;
}

const HTML_WRAPPER_TEMPLATE = (bodyContent: string) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 16px; font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, Ubuntu, "Droid Sans", sans-serif); font-size: var(--vscode-font-size, 13px); }
  </style>
</head>
<body>
  ${bodyContent}
</body>
</html>`;

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			rehypePlugins={[rehypeRaw]}
			components={{
				pre: ({ children, ...rest }: any) => {
					// When the code renderer returns a non-code element (chart, iframe),
					// skip the <pre> wrapper so it doesn't break layout.
					if (React.isValidElement(children)) {
						const child = children as React.ReactElement<any>;
						if (child.type !== 'code') {
							return <>{children}</>;
						}
					}
					return <pre {...rest}>{children}</pre>;
				},
				code: (props: any) => {
					const { inline, className, children, ...rest } = props;
					const match = /language-(\w+)/.exec(className || '');
					const codeContent = String(children).replace(/\n$/, '');

					if (!inline && match && match[1] === 'html') {
						const isFullDocument = codeContent.trim().startsWith('<!DOCTYPE') ||
							codeContent.trim().startsWith('<html');
						const htmlContent = isFullDocument ? codeContent : HTML_WRAPPER_TEMPLATE(codeContent);

						return (
							<iframe
								srcDoc={htmlContent}
								sandbox="allow-scripts"
								className='html-iframe'
								title="Rendered HTML"
							/>
						);
					}

					if (!inline && match && match[1] === 'chartjs') {
						return <ChartJsRenderer config={codeContent} />;
					}

					return !inline && match ? (
						<SyntaxHighlighter
							style={oneDark}
							language={match[1]}
							PreTag="div"
							customStyle={{
								margin: 0,
								borderRadius: '6px',
								fontSize: 'var(--vscode-editor-font-size, 13px)'
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
				table: (props) => {
					return (
						<div className="table-wrapper">
							<table className="markdown-table">
								{props.children}
							</table>
						</div>
					);
				},
				a: (props) => {
					return (
						<a href={props.href} target="_blank" rel="noopener noreferrer" className="markdown-link">
							{props.children}
						</a>
					);
				},
				blockquote: (props) => {
					return (
						<blockquote className="markdown-blockquote">
							{props.children}
						</blockquote>
					);
				},
				ul: (props) => {
					return <ul className="markdown-list">{props.children}</ul>;
				},
				ol: (props) => {
					return <ol className="markdown-list">{props.children}</ol>;
				}
			}}
		>
			{content}
		</ReactMarkdown>
	);
};
