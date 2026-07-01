import React from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import ThemedImage from '@theme/ThemedImage';
import { isExternal } from '../../lib/format.mjs';

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
			{ label: 'IDE Extensions', href: '/ide-extensions/overview' },
			{ label: 'Self-hosting', href: '/self-hosting' },
		],
	},
	{
		title: 'RocketRide',
		items: [
			{ label: 'Home', href: 'https://rocketride.org' },
			{ label: 'Cloud', href: 'https://rocketride.ai' },
			{ label: 'About us', href: 'https://rocketride.org/about-us' },
			{ label: 'Blog', href: 'https://rocketride.org/blog' },
			{ label: 'Events', href: 'https://rocketride.org/events' },
			{ label: 'Careers', href: 'https://app.trinethire.com/companies/1071922-rocketride-inc/jobs' },
		],
	},
];

const SOCIALS: SocialLink[] = [
	{
		label: 'X',
		href: 'https://x.com/RocketRideAI',
		icon: (
			<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
				<path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
			</svg>
		),
	},
	{
		label: 'LinkedIn',
		href: 'https://www.linkedin.com/company/rocketride-ai/',
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
	{
		label: 'Discord',
		href: 'https://discord.gg/9hr3tdZmEG',
		icon: (
			<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
				<path
					fill="currentColor"
					d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"
				/>
			</svg>
		),
	},
	{
		label: 'YouTube',
		href: 'https://www.youtube.com/@RocketRide-ai',
		icon: (
			<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
				<path fill="currentColor" d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
			</svg>
		),
	},
	{
		label: 'Instagram',
		href: 'https://www.instagram.com/rocketride.ai/',
		icon: (
			<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
				<path
					fill="currentColor"
					d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z"
				/>
			</svg>
		),
	},
];

/** Site footer: brand, social links, and the docs navigation spine. */
export default function Footer(): React.ReactNode {
	const { siteConfig } = useDocusaurusContext();
	const logoLight = useBaseUrl('img/rocketride-wordmark-positive.png');
	const logoDark = useBaseUrl('img/rocketride-wordmark-negative.png');
	const year = new Date().getFullYear();

	return (
		<footer className="footer rr-footer">
			<div className="rr-footer__inner">
				<div className="rr-footer__brand">
					<Link className="rr-footer__logo" to="/">
						<ThemedImage alt={siteConfig.title} height={26} sources={{ light: logoLight, dark: logoDark }} />
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
										{isExternal(item.href) ? (
											<a className="rr-footer__link" href={item.href} target="_blank" rel="noopener noreferrer">
												{item.label}
											</a>
										) : (
											<Link className="rr-footer__link" to={item.href}>
												{item.label}
											</Link>
										)}
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
