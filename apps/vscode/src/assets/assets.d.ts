// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

declare module '*.svg' {
	import type * as React from 'react';
	const Component: React.FC<React.SVGProps<SVGSVGElement>>;
	export default Component;
}

declare module '*.svg?url' {
	const url: string;
	export default url;
}

declare module '*.png' {
	const url: string;
	export default url;
}

// Side-effect stylesheet imports (theme CSS from the installed shell
// package and the webview root styles) carry no exports.
declare module '*.css' {}
