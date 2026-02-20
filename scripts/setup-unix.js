/**
 * macOS / Linux system setup. Called once at builder startup (build.js).
 * Compiler toolchain is handled only when compiling from source (server:setup-tools → compiler-unix.sh).
 */
async function setupSystem(_options) {
    // Reserved for future macOS/Linux-wide setup; for now just return.
}

module.exports = { setupSystem };
