/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Stand-in for react-syntax-highlighter (see resolve.ts). A note's code
 * block is drawn as plain monospace text: the real Prism build carries
 * every grammar (about 1 MB) and would push the single-file widget past
 * its size budget.
 */
import type { CSSProperties, ReactElement, ReactNode } from 'react';

interface Props {
	children?: ReactNode;
	language?: string;
	customStyle?: CSSProperties;
	style?: unknown;
	PreTag?: string;
}

const BLOCK: CSSProperties = {
	margin: 0,
	padding: '6px 8px',
	overflowX: 'auto',
	fontFamily: 'ui-monospace, monospace',
	background: 'color-mix(in srgb, currentcolor 8%, transparent)',
	whiteSpace: 'pre',
};

/** Same name and props as the library's Prism export; draws unhighlighted code. */
export function Prism({ children, language, customStyle }: Props): ReactElement {
	return (
		<pre style={{ ...BLOCK, ...customStyle }}>
			<code className={language ? `language-${language}` : undefined}>{children}</code>
		</pre>
	);
}

/** The theme object the builder passes; unused by the stand-in. */
export const oneDark: Record<string, CSSProperties> = {};
