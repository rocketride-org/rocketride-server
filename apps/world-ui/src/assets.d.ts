// Type declarations for static image imports handled by rsbuild as asset URLs.

declare module '*.webp' {
	const src: string;
	export default src;
}

declare module '*.png' {
	const src: string;
	export default src;
}

declare module '*.svg' {
	const src: string;
	export default src;
}
