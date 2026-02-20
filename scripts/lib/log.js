/**
 * Build Log Collector
 * 
 * Collects output from parallel tasks and writes organized log at end.
 * Each module's output stays grouped together even when running in parallel.
 */
const { writeFile } = require('./fs');

// Global buffer: { 'module:command': ['line1', 'line2', ...], ... }
const consoleLog = {};

// Track order modules were started (for ordered output)
const moduleOrder = [];

/**
 * Log a line of output for a module
 * 
 * @param {string} module - Module identifier (e.g., 'client-python:test')
 * @param {string} line - Line of output
 */
function logOutput(module, line) {
    if (!module) return;
    
    if (!consoleLog[module]) {
        consoleLog[module] = [];
        moduleOrder.push(module);
    }
    consoleLog[module].push(line);
}

/**
 * Write all collected output to a log file
 * 
 * @param {string} filename - Path to log file
 * @returns {Promise<void>} Resolves when file is written
 */
async function writeLog(filename) {
    const lines = [];
    
    lines.push(`Build Log - ${new Date().toISOString()}`);
    lines.push('═'.repeat(70));
    lines.push('');
    
    for (const module of moduleOrder) {
        const moduleLines = consoleLog[module] || [];
        
        lines.push('─'.repeat(70));
        lines.push(module);
        lines.push('─'.repeat(70));
        lines.push('');
        
        for (const line of moduleLines) {
            lines.push(line);
        }
        
        lines.push('');
    }
    
    await writeFile(filename, lines.join('\n'));
}

/**
 * Clear the log buffer (for fresh runs)
 */
function clearLog() {
    for (const key of Object.keys(consoleLog)) {
        delete consoleLog[key];
    }
    moduleOrder.length = 0;
}

/**
 * Get log entries for a specific module
 * 
 * @param {string} module - Module identifier
 * @returns {string[]} Array of log lines
 */
function getModuleLog(module) {
    return consoleLog[module] || [];
}

/**
 * Check if any output has been logged
 * 
 * @returns {boolean}
 */
function hasLogEntries() {
    return moduleOrder.length > 0;
}

module.exports = {
    logOutput,
    writeLog,
    clearLog,
    getModuleLog,
    hasLogEntries
};

