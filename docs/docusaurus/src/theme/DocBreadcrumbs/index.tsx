import React, { type ReactNode } from 'react';
import DocBreadcrumbs from '@theme-original/DocBreadcrumbs';
import type { Props } from '@theme/DocBreadcrumbs';
import { useDoc } from '@docusaurus/plugin-content-docs/client';
import { SiGithub } from 'react-icons/si';

/**
 * Breadcrumb row with a right-aligned "View source" action. docs:gather lifts
 * each node doc's generated "### Source" section into `source_url` front
 * matter; pages without it (everything that isn't a node) render the stock
 * breadcrumbs unchanged.
 */
export default function DocBreadcrumbsWrapper(props: Props): ReactNode {
	const { frontMatter } = useDoc();
	const sourceUrl = (frontMatter as { source_url?: string }).source_url;
	if (!sourceUrl) return <DocBreadcrumbs {...props} />;
	return (
		<div className="rr-breadcrumbs-row">
			<DocBreadcrumbs {...props} />
			<a className="rr-view-source" href={sourceUrl} target="_blank" rel="noopener noreferrer">
				<SiGithub className="rr-inline-icon" aria-hidden="true" /> View source
			</a>
		</div>
	);
}
