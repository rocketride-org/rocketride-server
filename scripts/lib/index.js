/**
 * Shared Build Utilities
 * 
 * Central export for all shared library functions.
 * 
 * Usage:
 *   const { execCommand, syncDir, removeDir, PROJECT_ROOT } = require('../../../scripts/lib');
 */

module.exports = {
    // File system utilities (fs.js)
    ...require('./fs'),
    
    // Clean utilities (clean.js)
    ...require('./clean'),
    
    // Sync utilities (sync.js)
    ...require('./sync'),
    
    // State management (state.js)
    ...require('./state'),
    
    // Execution utilities (exec.js)
    ...require('./exec'),
    
    // Path constants (paths.js)
    ...require('./paths'),
    
    // Download utilities (download.js)
    ...require('./download'),
    
    // Platform utilities (platform.js)
    ...require('./platform'),
    
    // Server utilities (server.js)
    ...require('./server'),
    
    // Task list factory (tasklist.js)
    ...require('./tasklist'),
    
    // Declarative helpers (helpers.js)
    ...require('./helpers'),
    
    // Action runner (action-runner.js)
    ...require('./action-runner'),
    
    // Debug (debug.js)
    ...require('./debug'),
    
    // Log collector (log.js)
    ...require('./log')
};

