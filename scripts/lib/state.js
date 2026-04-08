/**
 * Shared State Management with Mutex Locking and In-Memory Cache
 * 
 * Provides thread-safe state management for the build system.
 * - State is loaded from disk once on first access
 * - Reads are served from memory cache
 * - Writes update memory cache AND persist to disk
 * - All state access is protected by an in-memory mutex
 */
const path = require('path');
const { readJsonSafe, writeJson, mkdir } = require('./fs');
const { BUILD_ROOT } = require('./paths');

const STATE_FILE = path.join(BUILD_ROOT, 'state.json');

// ============================================================================
// In-Memory Cache
// ============================================================================

let stateCache = null;  // null = not loaded yet

/**
 * Ensure state is loaded into memory cache
 * @returns {Promise<Object>}
 */
async function ensureLoaded() {
    if (stateCache === null) {
        try {
            stateCache = await readJsonSafe(STATE_FILE, {});
        } catch {
            stateCache = {};
        }
    }
    return stateCache;
}

/**
 * Save state to disk (also updates cache)
 * @param {Object} state
 */
async function persistState(state) {
    stateCache = state;
    await mkdir(BUILD_ROOT);
    await writeJson(STATE_FILE, state);
}

/**
 * Invalidate the cache (forces reload on next access)
 * Use this if you know external process may have modified state
 */
function invalidateCache() {
    stateCache = null;
}

// ============================================================================
// Mutex Implementation
// ============================================================================

const locks = new Map();  // lockName -> { promise, waiters }

/**
 * Execute a function while holding a named lock.
 * Multiple calls with the same lock name will be serialized.
 * Cleans up when no more waiters to prevent memory leaks.
 * 
 * @param {string} name - Lock name (e.g., 'state', 'java-setup', 'vcpkg-setup')
 * @param {Function} fn - Async function to execute while holding the lock
 * @returns {Promise<any>} - Result of fn()
 */
async function withLock(name, fn) {
    // Get or create lock entry
    if (!locks.has(name)) {
        locks.set(name, { promise: Promise.resolve(), waiters: 0 });
    }

    const lock = locks.get(name);
    lock.waiters++;

    const current = lock.promise;
    let release;
    lock.promise = new Promise(resolve => release = resolve);

    await current;  // Wait for previous holder
    try {
        return await fn();
    } finally {
        lock.waiters--;
        // Clean up if no more waiters
        if (lock.waiters === 0) {
            locks.delete(name);
        }
        release();  // Let next waiter proceed
    }
}

// ============================================================================
// Public API (all operations are mutex-protected)
// ============================================================================

/**
 * Load the entire state object (mutex-protected)
 * Returns a copy to prevent accidental mutation
 * @returns {Promise<Object>}
 */
async function loadState() {
    return withLock('state', async () => {
        const state = await ensureLoaded();
        return JSON.parse(JSON.stringify(state));  // Deep copy
    });
}

/**
 * Save the entire state object (mutex-protected)
 * @param {Object} state
 */
async function saveState(state) {
    return withLock('state', async () => {
        await persistState(state);
    });
}

/**
 * Get a specific key from state (mutex-protected)
 * Reads from memory cache (no disk I/O after first load)
 * @param {string} key - Dot-notation path (e.g., 'server.configured', 'vcpkg.bootstrapped')
 * @returns {Promise<any>}
 */
async function getState(key) {
    return withLock('state', async () => {
        const state = await ensureLoaded();
        const parts = Array.isArray(key) ? key : key.split('.');
        let value = state;
        for (const part of parts) {
            if (value === undefined || value === null) return undefined;
            value = value[part];
        }
        // Return a copy of objects/arrays to prevent mutation
        if (value !== null && typeof value === 'object') {
            return JSON.parse(JSON.stringify(value));
        }
        return value;
    });
}

/**
 * Delete a key and prune empty parent objects
 * @param {Object} state - Root state object
 * @param {string[]} parts - Key path parts
 */
function deleteKeyAndPrune(state, parts) {
    let obj = state;
    for (let i = 0; i < parts.length - 1; i++) {
        obj = obj[parts[i]];
        if (obj == null) return;
    }
    delete obj[parts[parts.length - 1]];
    // Prune empty parents from the leaf up
    for (let depth = parts.length - 2; depth >= 0; depth--) {
        let parent = state;
        for (let i = 0; i < depth; i++) parent = parent[parts[i]];
        const branch = parent[parts[depth]];
        if (branch != null && typeof branch === 'object' && !Array.isArray(branch) && Object.keys(branch).length === 0) {
            delete parent[parts[depth]];
        } else {
            break;
        }
    }
}

/**
 * Set a specific key in state (mutex-protected)
 * Updates memory cache AND persists to disk.
 * If value is null, the key is removed (and empty parent objects pruned).
 * @param {string} key - Dot-notation path (e.g., 'server.configured', 'vcpkg.bootstrapped')
 * @param {any} value
 */
async function setState(key, value) {
    return withLock('state', async () => {
        const state = await ensureLoaded();
        const parts = Array.isArray(key) ? key : key.split('.');
        if (value === null) {
            deleteKeyAndPrune(state, parts);
        } else {
            let obj = state;
            for (let i = 0; i < parts.length - 1; i++) {
                const part = parts[i];
                if (obj[part] === undefined || obj[part] === null) {
                    obj[part] = {};
                }
                obj = obj[part];
            }
            obj[parts[parts.length - 1]] = value;
        }
        await persistState(state);
    });
}

/**
 * Update multiple keys in state atomically (mutex-protected)
 * Updates memory cache AND persists to disk (single write).
 * Keys with value null are removed (and empty parent objects pruned).
 * @param {Object} updates - Object with dot-notation keys and values
 */
async function updateState(updates) {
    return withLock('state', async () => {
        const state = await ensureLoaded();

        for (const [key, value] of Object.entries(updates)) {
            const parts = key.split('.');
            if (value === null) {
                deleteKeyAndPrune(state, parts);
            } else {
                let obj = state;
                for (let i = 0; i < parts.length - 1; i++) {
                    const part = parts[i];
                    if (obj[part] === undefined || obj[part] === null) {
                        obj[part] = {};
                    }
                    obj = obj[part];
                }
                obj[parts[parts.length - 1]] = value;
            }
        }

        await persistState(state);
    });
}

/**
 * Clear all state (mutex-protected)
 */
async function clearState() {
    return withLock('state', async () => {
        await persistState({});
    });
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
    // Mutex
    withLock,

    // Async state operations (mutex-protected, cached)
    loadState,
    saveState,
    getState,
    setState,
    updateState,
    clearState,

    // Cache control
    invalidateCache,

    // Paths (for reference)
    STATE_FILE,
    BUILD_ROOT
};
