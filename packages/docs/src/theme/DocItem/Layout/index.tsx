import React from 'react';
import Layout from '@theme-original/DocItem/Layout';
import type LayoutType from '@theme/DocItem/Layout';
import type { WrapperProps } from '@docusaurus/types';
import { useLocation } from '@docusaurus/router';

type Props = WrapperProps<typeof LayoutType>;

// Map the current route to its raw .md sibling emitted by docs:gather.
function markdownUrl(pathname: string): string {
	if (pathname === '/') return '/index.md';
	return `${pathname.replace(/\/$/, '')}.md`;
}

export default function DocItemLayout(props: Props): React.ReactNode {
	const { pathname } = useLocation();
	const mdUrl = markdownUrl(pathname);

	const copyMarkdown = async () => {
		const res = await fetch(mdUrl);
		if (!res.ok) return;
		const text = await res.text();
		await navigator.clipboard.writeText(text);
	};

	return (
		<>
			<div className="docs-md-actions">
				<a className="button button--secondary button--sm" href={mdUrl} target="_blank" rel="noopener noreferrer">
					View as Markdown
				</a>
				<button type="button" className="button button--secondary button--sm" onClick={copyMarkdown}>
					Copy as Markdown
				</button>
			</div>
			<Layout {...props} />
		</>
	);
}
