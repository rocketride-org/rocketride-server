// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ChartRenderer } from './ChartRenderer';

const S = {
	wrapper: {
		fontSize: 13,
		lineHeight: 1.6,
		color: 'var(--rr-text-primary)',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	iframe: {
		width: '100%',
		minHeight: 300,
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		backgroundColor: 'var(--rr-bg-paper)',
	} as CSSProperties,

	table: {
		width: '100%',
		borderCollapse: 'collapse' as const,
		margin: '8px 0',
		fontSize: 12,
	} as CSSProperties,

	tableWrapper: {
		overflowX: 'auto' as const,
		margin: '6px 0',
	} as CSSProperties,

	inlineCode: {
		backgroundColor: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		padding: '1px 4px',
		fontSize: 12,
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	blockquote: {
		borderLeft: '3px solid var(--rr-brand)',
		paddingLeft: 12,
		margin: '6px 0',
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
	} as CSSProperties,

	link: {
		color: 'var(--rr-text-link)',
		textDecoration: 'none',
	} as CSSProperties,
};

const HTML_WRAPPER = (body: string) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:16px;font-family:system-ui,sans-serif;}</style></head><body>${body}</body></html>`;

interface MarkdownRendererProps {
	content: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => (
	<div style={S.wrapper}>
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			components={{
				pre: ({ children, ...rest }: any) => {
					// Skip <pre> wrapper for non-code elements (charts, iframes)
					if (React.isValidElement(children)) {
						const child = children as React.ReactElement<any>;
						if (child.type !== 'code') return <>{children}</>;
					}
					return <pre {...rest}>{children}</pre>;
				},
				code: ({ inline, className, children, ...rest }: any) => {
					const match = /language-(\w+)/.exec(className ?? '');
					const lang = match?.[1];
					const code = String(children).replace(/\n$/, '');

					if (!inline && lang === 'html') {
						const isDoc = code.trim().startsWith('<!DOCTYPE') || code.trim().startsWith('<html');
						return <iframe srcDoc={isDoc ? code : HTML_WRAPPER(code)} sandbox="allow-scripts" title="Rendered HTML" style={S.iframe} />;
					}

					if (!inline && lang === 'chartjs') return <ChartRenderer config={code} />;

					if (!inline && lang) {
						return (
							<SyntaxHighlighter style={oneDark} language={lang} PreTag="div" customStyle={{ margin: 0, borderRadius: 6, fontSize: 12 }}>
								{code}
							</SyntaxHighlighter>
						);
					}

					return (
						<code style={inline ? S.inlineCode : undefined} className={className} {...rest}>
							{children}
						</code>
					);
				},
				table: ({ children }: any) => (
					<div style={S.tableWrapper}>
						<table style={S.table}>{children}</table>
					</div>
				),
				th: ({ children }: any) => <th style={{ padding: '6px 10px', borderBottom: '1px solid var(--rr-border)', textAlign: 'left', fontWeight: 600, fontSize: 12, color: 'var(--rr-text-secondary)' }}>{children}</th>,
				td: ({ children }: any) => <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--rr-border)', fontSize: 12 }}>{children}</td>,
				a: ({ href, children }: any) => {
					// Only allow safe URL schemes — reject javascript:, data:, vbscript: etc.
					const safeHref = /^(https?|mailto|tel):/i.test(href ?? '') ? href : undefined;
					return (
						<a href={safeHref} target="_blank" rel="noopener noreferrer" style={S.link} onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')} onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}>
							{children}
						</a>
					);
				},
				blockquote: ({ children }: any) => <blockquote style={S.blockquote}>{children}</blockquote>,
				ul: ({ children }: any) => <ul style={{ margin: '6px 0', paddingLeft: 20 }}>{children}</ul>,
				ol: ({ children }: any) => <ol style={{ margin: '6px 0', paddingLeft: 20 }}>{children}</ol>,
				p: ({ children }: any) => <p style={{ margin: '4px 0', color: 'var(--rr-text-primary)' }}>{children}</p>,
			}}
		>
			{content}
		</ReactMarkdown>
	</div>
);
