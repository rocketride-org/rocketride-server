/**
 * Task debug output - respects the global --verbose flag.
 * Set via setTaskDebugVerbose() at run start; tasks call taskDebug() for extra info.
 */
let _verbose = false;

/**
 * Set whether task debug output is enabled (e.g. from --verbose).
 * Called by the runner at start of a run.
 * @param {boolean} enabled
 */
function setTaskDebugVerbose(enabled) {
    _verbose = !!enabled;
}

/**
 * Log a debug message when the global --verbose flag is set.
 * Output is prefixed with "[TASK] ".
 * @param {...*} args - Same as console.log (message and optional values)
 */
function taskDebug(...args) {
    if (_verbose) {
        console.log('[TASK]', ...args);
    }
}

module.exports = {
    setTaskDebugVerbose,
    taskDebug
};
