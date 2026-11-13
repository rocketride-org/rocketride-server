import React, { type ReactNode } from 'react';
import Head from '@docusaurus/Head';
import { useBreadcrumbsStructuredData } from '@docusaurus/plugin-content-docs/client';
import type { Props } from '@theme/DocBreadcrumbs/StructuredData';
import { withTrailingSlash } from '../../../lib/format.mjs';

/**
 * BreadcrumbList JSON-LD, same as the stock component except every `item` URL
 * ends with a slash. Docusaurus builds `item` from the sidebar href, which has
 * no trailing slash even with `trailingSlash: true`, so each crumb pointed at a
 * URL that redirects.
 */
export default function DocBreadcrumbsStructuredData(props: Props): ReactNode {
	const structuredData = useBreadcrumbsStructuredData({ breadcrumbs: props.breadcrumbs });
	const withSlash = {
		...structuredData,
		itemListElement: (structuredData.itemListElement as unknown as { item?: unknown }[]).map((entry) => ({
			...entry,
			item: withTrailingSlash(entry.item),
		})),
	};
	return (
		<Head>
			<script type="application/ld+json">{JSON.stringify(withSlash)}</script>
		</Head>
	);
}
