/**
 * Shared Path Constants
 *
 * Common directory paths used throughout the build system.
 */
const path = require('path');

/** Project root directory (monorepo root) */
const PROJECT_ROOT = path.resolve(__dirname, '../..');

/** Overlay repo building this one as a submodule; null for a plain build */
const OVERLAY_ROOT = null;

/** Build directory for temporary build artifacts */
const BUILD_ROOT = path.join(PROJECT_ROOT, 'build');

/** Distribution directory for final outputs */
const DIST_ROOT = path.join(PROJECT_ROOT, 'dist');

/**
 * Re-derives the roots above for the overlay --overlay-root names, null for a
 * plain build. The option arrives more than once - our builder passes this
 * root before an overlay's builder forwards that one - so the last call wins
 */
function setOverlayRoot(overlayRoot) {
	const outputRoot = overlayRoot || PROJECT_ROOT;

	module.exports.OVERLAY_ROOT = overlayRoot || null;
	module.exports.BUILD_ROOT = path.join(outputRoot, 'build');
	module.exports.DIST_ROOT = path.join(outputRoot, 'dist');

	// The rsbuild and esbuild configs, and the shell's packaging scripts, run
	// as their own processes and read these to find the tree we write into
	process.env.ROCKETRIDE_BUILD_ROOT = module.exports.BUILD_ROOT;
	process.env.ROCKETRIDE_DIST_ROOT = module.exports.DIST_ROOT;
}

module.exports = {
	PROJECT_ROOT,
	BUILD_ROOT,
	DIST_ROOT,
	OVERLAY_ROOT,
	setOverlayRoot,
};
