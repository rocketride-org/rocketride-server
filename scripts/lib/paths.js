/**
 * Shared Path Constants
 * 
 * Common directory paths used throughout the build system.
 */
const path = require('path');

/** Project root directory (monorepo root) */
const PROJECT_ROOT = path.resolve(__dirname, '../..');

/** Build directory for temporary build artifacts */
const BUILD_DIR = path.join(PROJECT_ROOT, 'build');

/** Distribution directory for final outputs */
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

module.exports = {
    PROJECT_ROOT,
    BUILD_DIR,
    DIST_DIR
};

