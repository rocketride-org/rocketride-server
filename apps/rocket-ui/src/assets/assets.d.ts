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

/** Append `?url` to import an SVG as a plain asset URL string instead of a
 *  component — matching apps/shared/src/types/global.d.ts. */
declare module '*.svg?url' {
	const url: string;
	export default url;
}

/** Append `?inline` to import an SVG as a data URI string — always inlined,
 *  never an emitted file. Matching apps/shared/src/types/global.d.ts. */
declare module '*.svg?inline' {
	const dataUri: string;
	export default dataUri;
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
