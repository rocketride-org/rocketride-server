declare module '*.css' {}

declare module '*.svg' {
	import type * as React from 'react';
	// SVG imports are SVGR-generated React components (ref forwarded to the
	// underlying <svg>), matching apps/shared/src/types/global.d.ts.
	const Component: React.ForwardRefExoticComponent<
		React.SVGProps<SVGSVGElement> & React.RefAttributes<SVGSVGElement>
	>;
	export default Component;
}

declare module '*.png' {
	const src: string;
	export default src;
}

declare module '*.jpg' {
	const src: string;
	export default src;
}

declare module '*.gif' {
	const src: string;
	export default src;
}

declare module '*.md' {
	const src: string;
	export default src;
}
