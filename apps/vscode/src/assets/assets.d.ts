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
