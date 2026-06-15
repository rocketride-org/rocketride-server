import path from 'path';
import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import redirects from './redirects';

// Use Algolia DocSearch when credentials are present; otherwise fall back to the
// local search index (matches the previous site).
const algolia = process.env.ALGOLIA_APP_ID && process.env.ALGOLIA_API_KEY ? { appId: process.env.ALGOLIA_APP_ID, apiKey: process.env.ALGOLIA_API_KEY, indexName: process.env.ALGOLIA_INDEX_NAME || 'rocketride' } : null;

// This runs in Node.js - don't use client-side code here (browser APIs, JSX...).

// docs:gather assembles the content tree under build/docs-content and points us
// at it via ROCKETRIDE_DOCS_CONTENT. Falling back to a local ./content dir lets
// `pnpm build` work standalone after a gather has run.
const contentPath = process.env.ROCKETRIDE_DOCS_CONTENT || path.resolve(__dirname, 'content');

const config: Config = {
	title: 'RocketRide Documentation',
	tagline: 'Build, run, and ship data + AI pipelines',
	favicon: 'img/rocketride-favicon.jpg',

	future: {
		v4: true,
	},

	url: 'https://docs.rocketride.org/',
	baseUrl: '/',

	// Inter for body + headings (loaded from Google Fonts).
	stylesheets: ['https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'],

	onBrokenLinks: 'throw',
	onBrokenMarkdownLinks: 'warn',

	// Migrated, co-located docs are CommonMark. Parsing .md as CommonMark (and
	// reserving MDX for .mdx) avoids JSX/expression pitfalls like `<128 GB` or
	// bare `{` in hand-written node prose.
	markdown: {
		format: 'detect',
	},

	i18n: {
		defaultLocale: 'en',
		locales: ['en'],
	},

	// Build metadata threaded through from `builder docs:build --version/--hash/...`.
	customFields: {
		version: process.env.DOCS_VERSION || '',
		hash: process.env.DOCS_HASH || '',
		stamp: process.env.DOCS_STAMP || '',
		saas: process.env.DOCS_SAAS === '1',
	},

	presets: [
		[
			'classic',
			{
				docs: {
					path: contentPath,
					routeBasePath: '/',
					sidebarPath: './sidebars.ts',
				},
				blog: false,
				theme: {
					customCss: './src/css/custom.css',
				},
			} satisfies Preset.Options,
		],
	],

	// Local search only when Algolia is not configured (they conflict).
	themes: algolia
		? []
		: [
				[
					'@easyops-cn/docusaurus-search-local',
					{
						hashed: true,
						docsRouteBasePath: '/',
					},
				],
			],

	plugins: [['@docusaurus/plugin-client-redirects', { redirects }]],

	themeConfig: {
		...(algolia ? { algolia } : {}),
		// Follow the visitor's OS theme: respectPrefersColorScheme makes the
		// system `prefers-color-scheme` win on first visit. defaultMode is only the
		// fallback when the browser reports no preference; the manual toggle still
		// overrides and persists per-visitor.
		colorMode: {
			defaultMode: 'dark',
			respectPrefersColorScheme: true,
		},
		navbar: {
			title: '',
			hideOnScroll: false,
			logo: {
				alt: 'RocketRide',
				src: 'img/rocketride-wordmark-positive.png',
				srcDark: 'img/rocketride-wordmark-negative.png',
				href: 'https://rocketride.ai',
				target: '_self',
				className: 'navbar__logo--wordmark',
			},
			items: [
				{ to: '/', label: 'Home', position: 'left', className: 'navbar__link--colored' },
				{ type: 'custom-discord', href: 'https://discord.gg/9hr3tdZmEG', label: 'Discord', position: 'right' },
				{ type: 'custom-githubStars', href: 'https://github.com/rocketride-org/rocketride-server', label: 'GitHub', position: 'right' },
			],
		},
		footer: {
			copyright: `© ${new Date().getFullYear()} RocketRide`,
		},
		prism: {
			theme: prismThemes.github,
			darkTheme: prismThemes.dracula,
		},
	} satisfies Preset.ThemeConfig,
};

export default config;
