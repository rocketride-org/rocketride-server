/**
 * Compiler toolchain setup stub. Dispatches to platform-specific implementation.
 * Used by server:setup-tools when the engine must be compiled from source.
 *
 * @param {Object} options
 * @param {boolean} [options.autoinstall] - If true, allow installing missing tools.
 * @param {boolean} [options.verbose] - If true, verbose output.
 * @param {function(string)} [options.onOutput] - Called for each output line.
 * @returns {Promise<Object>} Platform-specific result (e.g. { vsPath, env, setupAt } on Windows).
 */
async function runCompilerSetup(options = {}) {
    if (process.platform === 'win32') {
        const { runCompilerWindowsSetup } = require('./compiler-windows');
        return runCompilerWindowsSetup(options);
    }
    const { runCompilerUnixSetup } = require('./compiler-unix');
    return runCompilerUnixSetup(options);
}

module.exports = { runCompilerSetup };
