import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ThemeClassNames } from '@docusaurus/theme-common';
import { useDoc } from '@docusaurus/plugin-content-docs/client';
import { useLocation } from '@docusaurus/router';
import Heading from '@theme/Heading';
import MDXContent from '@theme/MDXContent';
import type { Props } from '@theme/DocItem/Content';
import { LuClipboard } from 'react-icons/lu';
import { SiMarkdown } from 'react-icons/si';
import { markdownUrl } from '../../../lib/format.mjs';

/**
 * Renders the doc title ourselves so the View/Copy-as-Markdown controls can sit
 * directly beneath it (Docusaurus' default puts the title inside the MDX body,
 * leaving no DOM seam between it and the content). The body's leading `# Title`
 * is hidden via CSS (`.rr-doc-header + h1`) to avoid a duplicate heading.
 *
 * @param props - The doc's MDX `children`.
 * @return The markdown container with a custom header and the rendered content.
 */
export default function DocItemContent({ children }: Props): ReactNode {
	const { metadata, frontMatter } = useDoc();
	const { pathname } = useLocation();
	const showActions = pathname !== '/';
	const mdUrl = markdownUrl(pathname);
	const [copied, setCopied] = useState(false);
	const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Clear a pending "Copied" reset if the component unmounts mid-window, so the
	// timer never fires against an unmounted component.
	useEffect(
		() => () => {
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
		},
		[]
	);

	const copyMarkdown = async () => {
		// Best-effort: a failed fetch or a denied clipboard write should be a
		// silent no-op, not an unhandled rejection.
		try {
			const res = await fetch(mdUrl);
			if (!res.ok) return;
			const text = await res.text();
			await navigator.clipboard.writeText(text);
			// Reset any in-flight timer so rapid clicks don't stack timeouts.
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
			setCopied(true);
			copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
		} catch {
			/* clipboard unavailable or fetch failed — ignore */
		}
	};

	return (
		<div className={clsx(ThemeClassNames.docs.docMarkdown, 'markdown')}>
			{!frontMatter.hide_title && (
				<header className="rr-doc-header">
					<Heading as="h1">{metadata.title}</Heading>
					{showActions && (
						<div className="docs-md-actions">
							<a className="button button--secondary button--sm" href={mdUrl} target="_blank" rel="noopener noreferrer">
								<SiMarkdown className="docs-md-actions__icon" /> View as Markdown
							</a>
							<button type="button" className="button button--secondary button--sm" onClick={copyMarkdown}>
								<LuClipboard className="docs-md-actions__icon" /> {copied ? 'Copied' : 'Copy as Markdown'}
							</button>
						</div>
					)}
				</header>
			)}
			<MDXContent>{children}</MDXContent>
		</div>
	);
}
