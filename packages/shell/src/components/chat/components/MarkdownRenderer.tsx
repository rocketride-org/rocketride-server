// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { type CSSProperties } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
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

	// An image never grows past the column it sits in; its declared width
	// holds up to that, and its height follows its aspect ratio.
	image: {
		maxWidth: '100%',
		height: 'auto',
	} as CSSProperties,
};

const HTML_WRAPPER = (body: string) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:16px;font-family:system-ui,sans-serif;}</style></head><body>${body}</body></html>`;

/**
 * Sanitize schema: the default (GitHub) schema only admits http/https image
 * sources, but hosts with no filesystem access (VS Code webviews) pre-read
 * local images and inline them as data: URIs — admit data: for img src, and
 * keep the width/height sizing attributes the default schema strips. A data:
 * src cannot execute script from an <img>, so the widening is inert.
 */
const SANITIZE_SCHEMA = {
	...defaultSchema,
	protocols: {
		...defaultSchema.protocols,
		src: [...(defaultSchema.protocols?.src ?? []), 'data'],
	},
	attributes: {
		...defaultSchema.attributes,
		img: [...(defaultSchema.attributes?.img ?? []), 'width', 'height'],
	},
};
// =============================================================================
// URL RESOLUTION AND ADMISSION
// =============================================================================

/** The slice of a hast node the base resolver touches (structural; no `hast` type dependency). */
interface HastNodeLike {
	type: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: HastNodeLike[];
}

/** A URL that names a scheme (`https:`, `data:`, `javascript:`, ...). */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The same-origin paths the renderer admits beyond http(s) and data:image —
 * the server's versioned artifact routes, where a store README's icon and
 * images live (`/apps/<id>/v<N>/...`, `/pipelines/<id>/v<N>/...`). The
 * entitlement cookie the shell primes rides those fetches.
 */
const ARTIFACT_PATH_PREFIXES = ['/apps/', '/pipelines/'];

/** The page origin, when there is one (tests and SSR have none). */
function pageOrigin(): string | undefined {
	const origin = typeof window !== 'undefined' ? window.location?.origin : undefined;
	return origin && origin !== 'null' ? origin : undefined;
}

/**
 * Tells whether a URL is an artifact path on THIS origin: path-only under
 * one of the artifact prefixes, or absolute on the page origin under one.
 *
 * @param url - The (already resolved) URL.
 * @returns True when the artifact rule admits it.
 */
function isArtifactUrl(url: string): boolean {
	// Step 1: a path-only URL under an artifact prefix
	if (ARTIFACT_PATH_PREFIXES.some((prefix) => url.startsWith(prefix))) return true;
	// Step 2: an absolute URL on the page origin under an artifact prefix
	const origin = pageOrigin();
	if (!origin || !url.startsWith(origin)) return false;
	const path = url.slice(origin.length);
	return ARTIFACT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Resolves a relative URL against the renderer's base URL with `new URL(rel,
 * base)` semantics. A path-only base keeps the result path-only (the page
 * origin stays implicit, so the same-origin admit rule still sees a path);
 * an absolute base gives an absolute result. Scheme-bearing, fragment-only
 * and empty URLs are returned untouched; without a base nothing changes.
 *
 * @param url - The URL as written in the markdown.
 * @param baseUrl - The document the markdown came from (its directory is the base).
 * @returns The resolved URL.
 */
function resolveAgainstBase(url: string, baseUrl?: string): string {
	if (!baseUrl || !url || url.startsWith('#') || HAS_SCHEME.test(url)) return url;
	try {
		// Step 1: anchor a path-only base on the page origin (any origin does
		// for a path-only result; the placeholder never leaks into it)
		const baseIsAbsolute = HAS_SCHEME.test(baseUrl);
		const anchor = new URL(baseIsAbsolute ? baseUrl : new URL(baseUrl, pageOrigin() ?? 'http://localhost').href);
		const resolved = new URL(url, anchor);
		// Step 2: a result on another origin (a scheme-relative `//cdn/...`
		// carries an authority) keeps its host: absolute with an absolute base,
		// scheme-relative with a path-only one so the placeholder scheme never leaks
		if (resolved.origin !== anchor.origin) return baseIsAbsolute ? resolved.href : `//${resolved.host}${resolved.pathname}${resolved.search}${resolved.hash}`;
		// Step 3: a same-origin result takes the shape the base had
		return baseIsAbsolute ? resolved.href : `${resolved.pathname}${resolved.search}${resolved.hash}`;
	} catch {
		return url;
	}
}

/**
 * A rehype plugin (unified attacher: `[rehypeResolveBase, baseUrl]`) that
 * resolves every relative `img src` and `a href` against the base URL BEFORE
 * the sanitizer runs, so the sanitizer judges the URL that will actually be
 * fetched.
 *
 * @param baseUrl - The base; without one the plugin is a no-op.
 * @returns The transformer.
 */
function rehypeResolveBase(baseUrl?: string): (tree: HastNodeLike) => void {
	return (tree: HastNodeLike): void => {
		if (!baseUrl) return;
		const walk = (node: HastNodeLike): void => {
			const props = node.properties;
			if (node.type === 'element' && props) {
				if (node.tagName === 'img' && typeof props.src === 'string') props.src = resolveAgainstBase(props.src, baseUrl);
				if (node.tagName === 'a' && typeof props.href === 'string') props.href = resolveAgainstBase(props.href, baseUrl);
			}
			for (const child of node.children ?? []) walk(child);
		};
		walk(tree);
	};
}

/**
 * react-markdown's OWN url sanitizer runs independently of rehype-sanitize
 * and empties every src/href outside http(s)/irc/mailto/xmpp — including
 * the data: URIs the README preview inlines, so the widened sanitize schema
 * alone never sees them. Pass data:image/* and same-origin artifact paths
 * through untouched; every other scheme keeps the stock transform, so
 * scriptable URLs stay blocked.
 */
const urlTransform = (url: string): string => (url.startsWith('data:image/') || isArtifactUrl(url) ? url : (defaultUrlTransform(url) ?? ''));

/** The link schemes the anchor renderer follows; artifact paths are admitted beside them. */
const SAFE_LINK_SCHEME = /^(https?|mailto|tel):/i;

/**
 * The href the anchor renderer follows, or undefined for a link it keeps as
 * text: a safe scheme, a same-origin artifact path, or a scheme-relative
 * `//host/...` (a network-path reference can only ever resolve to http(s))
 * given the page's scheme — https where the page is not http(s) itself (a
 * VS Code webview), so the host stays reachable.
 *
 * @param href - The href as resolved.
 * @returns The href to follow, or undefined.
 */
function followableHref(href: string | undefined): string | undefined {
	if (!href) return undefined;
	if (SAFE_LINK_SCHEME.test(href) || isArtifactUrl(href)) return href;
	if (href.startsWith('//')) {
		const pageScheme = typeof window !== 'undefined' ? window.location?.protocol : undefined;
		return `${pageScheme && /^https?:$/.test(pageScheme) ? pageScheme : 'https:'}${href}`;
	}
	return undefined;
}

export interface MarkdownRendererProps {
	content: string;
	/**
	 * The URL of the document the markdown came from (a served README);
	 * relative image sources and links resolve against its directory.
	 */
	baseUrl?: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, baseUrl }) => (
	<div style={S.wrapper}>
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			rehypePlugins={[rehypeRaw, [rehypeResolveBase, baseUrl], [rehypeSanitize, SANITIZE_SCHEMA]]}
			urlTransform={urlTransform}
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
					// Only safe URL schemes, same-origin artifact paths and
					// scheme-relative hosts — never javascript:, data:, vbscript: etc.
					const safeHref = followableHref(href);
					return (
						<a href={safeHref} target="_blank" rel="noopener noreferrer" style={S.link} onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')} onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}>
							{children}
						</a>
					);
				},
				blockquote: ({ children }: any) => <blockquote style={S.blockquote}>{children}</blockquote>,
				img: ({ node: _node, ...rest }: React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) => <img {...rest} style={S.image} />,
				ul:({ children }: any) => <ul style={{ margin: '6px 0', paddingLeft: 20 }}>{children}</ul>,
				ol: ({ children }: any) => <ol style={{ margin: '6px 0', paddingLeft: 20 }}>{children}</ol>,
				p: ({ children }: any) => <p style={{ margin: '4px 0', color: 'var(--rr-text-primary)' }}>{children}</p>,
			}}
		>
			{content}
		</ReactMarkdown>
	</div>
);
