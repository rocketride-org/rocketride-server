/**
 * Windows system setup. Called once at builder startup (build.js).
 * Implement setupSystem and return; compiler toolchain (VS + pip) is handled
 * only when compiling from source (server:setup-tools → compiler-windows.js).
 */
async function setupSystem(_options) {
    // Reserved for future Windows-wide setup; for now just return.
}

module.exports = { setupSystem };
