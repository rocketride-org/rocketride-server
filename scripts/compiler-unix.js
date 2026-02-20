/**
 * macOS / Linux compiler toolchain setup. Runs compiler-unix.sh to check/install
 * build prerequisites for compiling the server from source.
 * Called from scripts/compiler.js when platform is not Windows.
 */
const path = require('path');
const { execCommand } = require('./lib/exec');

const PROJECT_ROOT = path.join(__dirname, '..');

/**
 * Run macOS/Linux compiler setup script.
 *
 * @param {Object} options
 * @param {boolean} [options.autoinstall] - If true, pass --autoinstall to the script.
 * @param {boolean} [options.verbose] - If true, verbose output.
 * @param {function(string)} [options.onOutput] - Called for each output line.
 * @param {Object} [options.task] - Optional Listr task for streaming output (task.output).
 * @returns {Promise<void>} Resolves when script succeeds; throws on failure.
 */
async function runCompilerUnixSetup(options = {}) {
    const { autoinstall = false, onOutput = null, task = null } = options;
    const script = path.join(__dirname, 'compiler-unix.sh');
    const args = autoinstall ? ['--autoinstall'] : [];
    await execCommand(script, args, {
        cwd: PROJECT_ROOT,
        ...(task && { task }),
        ...(onOutput && { onOutput })
    });
}

module.exports = { runCompilerUnixSetup };
