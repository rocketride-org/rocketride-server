/**
 * Shared Platform Utilities
 * 
 * Helper functions for platform detection.
 */
const os = require('os');

/**
 * Get platform information for downloads and builds
 * 
 * @returns {{os: string, arch: string, ext: string}}
 */
function getPlatform() {
    const platform = os.platform();
    const arch = os.arch();
    
    if (platform === 'win32') {
        return { os: 'windows', arch: 'x64', ext: 'zip' };
    }
    if (platform === 'darwin') {
        return { os: 'mac', arch: arch === 'arm64' ? 'aarch64' : 'x64', ext: 'tar.gz' };
    }
    if (platform === 'linux') {
        return { os: 'linux', arch: 'x64', ext: 'tar.gz' };
    }
    
    throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * Check if running on Windows
 * @returns {boolean}
 */
function isWindows() {
    return os.platform() === 'win32';
}

/**
 * Check if running on macOS
 * @returns {boolean}
 */
function isMac() {
    return os.platform() === 'darwin';
}

/**
 * Check if running on Linux
 * @returns {boolean}
 */
function isLinux() {
    return os.platform() === 'linux';
}

/**
 * Name of an executable as the linker writes it
 * @param {string} name - Target name, without an extension
 * @returns {string} e.g. engine.exe on Windows, engine elsewhere
 */
function getExecName(name) {
    return isWindows() ? `${name}.exe` : name;
}

/**
 * Name of a shared library as the linker writes it
 * @param {string} name - Target name, without prefix or extension
 * @returns {string} e.g. engine.dll, libengine.dylib, libengine.so
 */
function getSharedName(name) {
    if (isWindows()) return `${name}.dll`;
    return `lib${name}${isMac() ? '.dylib' : '.so'}`;
}

/**
 * Name of the debug symbols beside a binary, or null where a build has none
 * @param {string} name - What the linker names the symbols after: the binary
 *                        file name for the engine, the target name for a node
 * @returns {string|null} e.g. engine.dll.pdb on Windows, null elsewhere
 */
function getSymName(name) {
    return isWindows() ? `${name}.pdb` : null;
}

module.exports = {
    getPlatform,
    isWindows,
    isMac,
    isLinux,
    getExecName,
    getSharedName,
    getSymName
};

