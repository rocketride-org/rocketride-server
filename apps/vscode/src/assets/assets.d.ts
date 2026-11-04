// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

declare module '*.svg' {
	import type * as React from 'react';
	const Component: React.FC<React.SVGProps<SVGSVGElement>>;
	export default Component;
}

// Append `?inline` to import an SVG as a data URI string — always inlined,
// never an emitted file (required where the consumer cannot resolve emitted
// asset paths, e.g. URLs rendered inside VS Code webviews). Mirrors the
// declaration in apps/shared/src/types/global.d.ts, which the webview
// tsconfig does not include.
declare module '*.svg?inline' {
	const dataUri: string;
	export default dataUri;
}

declare module '*.png' {
	const url: string;
	export default url;
}

// Side-effect stylesheet imports (theme CSS from the installed shell
// package and the webview root styles) carry no exports.
declare module '*.css' {}
