import React from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import ThemedImage from '@theme/ThemedImage';

type FooterLink = { label: string; href: string };
type FooterColumn = { title: string; items: FooterLink[] };
type SocialLink = { label: string; href: string; icon: React.ReactNode };

// Footer navigation wired to the docs spine (routeBasePath is '/'). Category
// labels with no landing page point at their first leaf.
const COLUMNS: FooterColumn[] = [
	{
		title: 'Documentation',
		items: [
			{ label: 'Home', href: '/' },
			{ label: 'Quickstart', href: '/quickstart' },
			{ label: 'Concepts', href: '/concepts/pipelines' },
			{ label: 'Components', href: '/nodes' },
			{ label: 'Pipeline reference', href: '/pipeline-reference' },
			{ label: 'Troubleshooting', href: '/troubleshooting' },
		],
	},
	{
		title: 'SDKs & API',
		items: [
			{ label: 'TypeScript SDK', href: '/develop/typescript' },
			{ label: 'Python SDK', href: '/develop/python' },
			{ label: 'MCP', href: '/protocols/mcp' },
			{ label: 'Server protocol', href: '/protocols/websocket' },
			{ label: 'Nodes', href: '/nodes' },
			{ label: 'Glossary', href: '/glossary' },
		],
	},
	{
		title: 'Resources',
		items: [
			{ label: 'Changelog', href: 'https://github.com/rocketride-org/rocketride-server/releases' },
			{ label: 'Cloud', href: '/cloud' },
			{ label: 'Cursor', href: '/ide-extensions/cursor' },
			{ label: 'Windsurf', href: '/ide-extensions/windsurf' },
			{ label: 'Self-hosting', href: '/self-hosting' },
			{ label: 'GitHub', href: 'https://github.com/rocketride-org/rocketride-server' },
		],
	},
];

const SOCIALS: SocialLink[] = [
	{
		label: 'X',
		href: '#',
		icon: (
			<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
				<path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
			</svg>
		),
	},
	{
		label: 'LinkedIn',
		href: '#',
		icon: (
			<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
				<path fill="currentColor" d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.35V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 110-4.13 2.07 2.07 0 010 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
			</svg>
		),
	},
	{
		label: 'GitHub',
		href: 'https://github.com/rocketride-org/rocketride-server',
		icon: (
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
				<path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
			</svg>
		),
	},
];

export default function Footer(): React.ReactNode {
	const { siteConfig } = useDocusaurusContext();
	const logoLight = useBaseUrl('img/rocketride-icon-colored.svg');
	const logoDark = useBaseUrl('img/rocketride-icon-white.svg');
	const year = new Date().getFullYear();

	return (
		<footer className="footer rr-footer">
			<div className="rr-footer__inner">
				<div className="rr-footer__brand">
					<Link className="rr-footer__logo" to="/">
						<ThemedImage alt={siteConfig.title} height={28} sources={{ light: logoLight, dark: logoDark }} />
						<span>{siteConfig.themeConfig?.navbar?.['title'] ?? 'RocketRide'}</span>
					</Link>
					<p className="rr-footer__tagline">{siteConfig.tagline}</p>
					<div className="rr-footer__socials">
						{SOCIALS.map((social) => (
							<a key={social.label} className="rr-footer__social" href={social.href} aria-label={social.label} target="_blank" rel="noopener noreferrer">
								{social.icon}
							</a>
						))}
					</div>
				</div>

				<div className="rr-footer__columns">
					{COLUMNS.map((column) => (
						<div key={column.title} className="rr-footer__column">
							<h3 className="rr-footer__title">{column.title}</h3>
							<ul className="rr-footer__list">
								{column.items.map((item) => (
									<li key={item.label}>
										<Link className="rr-footer__link" to={item.href}>
											{item.label}
										</Link>
									</li>
								))}
							</ul>
						</div>
					))}
				</div>
			</div>

			<div className="rr-footer__bottom">
				<span>Copyright © {year} RocketRide</span>
			</div>
		</footer>
	);
}
