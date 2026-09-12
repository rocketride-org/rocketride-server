import React, { type ReactNode } from 'react';
import MDXComponents from '@theme-original/MDXComponents';
import Link from '@docusaurus/Link';
import clsx from 'clsx';

/**
 * Linked guide card (Dify-style: accent icon tile, title, blurb). Styling
 * lives on the `.rr-side-card` family in custom.css, shared with the raw-HTML
 * cards on older pages, so both author styles render identically. Rendered
 * through Docusaurus `Link` so internal hrefs are seen by the broken-link
 * checker (a raw `<a>` is never collected).
 *
 * @param props.href - Destination route or external URL.
 * @param props.title - Card heading.
 * @param props.icon - Optional icon element (typically a react-icons component).
 * @param props.children - Card body text.
 * @return The card anchor.
 */
export function Card({ href, title, icon, children }: { href: string; title: string; icon?: ReactNode; children?: ReactNode }): ReactNode {
	return (
		<Link className="rr-side-card" to={href}>
			<span className="rr-side-card__head">
				{icon && <span className="rr-card-icon">{icon}</span>}
				<span className="rr-side-card__title">{title}</span>
			</span>
			<span className="rr-side-card__body">{children}</span>
		</Link>
	);
}

/**
 * Responsive grid of Cards. Two columns by default, three with `columns={3}`;
 * both collapse on narrow viewports (see `.rr-card-grid` in custom.css).
 *
 * @param props.columns - 2 (default) or 3.
 * @param props.children - The Card elements.
 * @return The grid container.
 */
export function CardGrid({ columns = 2, children }: { columns?: 2 | 3; children: ReactNode }): ReactNode {
	return <div className={clsx('rr-card-grid', columns === 3 && 'rr-card-grid--3')}>{children}</div>;
}

export default { ...MDXComponents, Card, CardGrid };
