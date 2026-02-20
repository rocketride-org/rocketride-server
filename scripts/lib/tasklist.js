/**
 * Task List Factory
 * 
 * Creates Listr instances with consistent defaults for output handling.
 */
const { Listr } = require('listr2');
const registry = require('./registry');

// Number of output lines to show per task
const OUTPUT_LINES = 5;

/**
 * Create a task list with consistent defaults
 * 
 * @param {Object|null} parent - Parent task (null for top-level, task object for subtasks)
 * @param {Array} tasks - Array of task definitions
 * @param {Object} options - Additional Listr options (merged with defaults)
 * @returns {Listr} - Configured Listr instance
 */
function taskList(parent, tasks, options = {}) {
    const defaults = {
        concurrent: false,
        exitOnError: true,
        rendererOptions: {
            showErrorMessage: true
        }
    };
    
    // Default task-level renderer options
    const defaultTaskRendererOptions = {
        outputBar: OUTPUT_LINES,
        persistentOutput: false
    };
    
    // Inject rendererOptions into each task that doesn't have them
    const tasksWithDefaults = tasks.map(task => ({
        ...task,
        rendererOptions: {
            ...defaultTaskRendererOptions,
            ...(task.rendererOptions || {})
        }
    }));
    
    // Deep merge Listr-level options
    const mergedOptions = {
        ...defaults,
        ...options,
        rendererOptions: {
            ...defaults.rendererOptions,
            ...(options.rendererOptions || {})
        }
    };
    
    if (parent) {
        // Subtask - use parent's newListr method
        return parent.newListr(tasksWithDefaults, mergedOptions);
    } else {
        // Top-level - create new Listr instance
        return new Listr(tasksWithDefaults, mergedOptions);
    }
}

// Track module execution state for concurrency control
const moduleState = {
    running: new Map(),   // target -> Promise (modules currently running)
    completed: new Set()  // target (modules that have completed this session)
};

// Sequential groups - ensures tasks in same group run one at a time
const sequentialGroups = new Map();  // groupName -> Promise

/**
 * Create a task function that runs sequentially within a group
 * 
 * Tasks in the same group will run one at a time, even if
 * the parent task list is running concurrently.
 * 
 * Similar to runModule, but for coordinating different tasks
 * that shouldn't run simultaneously.
 * 
 * Usage:
 *   { title: 'Run pytest', task: runSequential('client-tests', async (ctx, task) => { ... }) }
 * 
 * @param {string} groupName - Name of the sequential group
 * @param {Function} taskFn - Async task function to execute
 * @returns {Function} - Task function for Listr
 */
function runSequential(groupName, taskFn) {
    return async (ctx, task) => {
        // Wait for group to be free
        while (sequentialGroups.has(groupName)) {
            task.output = `Waiting for ${groupName}...`;
            await sequentialGroups.get(groupName);
        }
        
        // Acquire group
        let resolve;
        sequentialGroups.set(groupName, new Promise(r => { resolve = r; }));
        
        try {
            return await taskFn(ctx, task);
        } finally {
            sequentialGroups.delete(groupName);
            resolve();
        }
    };
}

/**
 * Create a task function that runs another module's tasks
 * 
 * Includes concurrency control:
 * - First caller runs the module
 * - Concurrent callers wait for the first to complete
 * - After completion, subsequent callers skip
 * 
 * Usage:
 *   { title: 'Setup AI', task: runModule('build:ai') }
 *   { title: 'Setup Java', task: runModule('setup:java', options) }
 * 
 * @param {string} target - Target in "command:module" format (e.g., "build:ai")
 * @param {Object} options - Options to pass to the module's getTasks
 * @returns {Function} - Task function for Listr
 */
function runModule(target, options = {}) {
    const [command, moduleName] = target.split(':');
    
    return async (ctx, task) => {
        // If already completed this session, just return (shows as completed with checkmark)
        if (moduleState.completed.has(target)) {
            return;
        }
        
        // If already running, await its completion promise
        if (moduleState.running.has(target)) {
            task.output = `Waiting for ${target}...`;
            await moduleState.running.get(target);
            return;  // Shows as completed with original title
        }
        
        const module = registry.get(moduleName);
        if (!module) {
            throw new Error(`Unknown module: ${moduleName}`);
        }
        
        const tasks = module.getTasks(command, options, ctx);
        if (!tasks || tasks.length === 0) {
            task.skip('No tasks defined');
            moduleState.completed.add(target);
            return;
        }
        
        // Create completion promise - resolved when task state becomes COMPLETED
        let resolveCompletion;
        const completionPromise = new Promise(resolve => {
            resolveCompletion = resolve;
        });
        moduleState.running.set(target, completionPromise);
        
        // Listen for STATE event on the underlying Task object (not TaskWrapper)
        // Fires when task state changes - COMPLETED means all subtasks are done
        task.task.on('STATE', (state) => {
            if (state === 'COMPLETED') {
                moduleState.completed.add(target);
                moduleState.running.delete(target);
                resolveCompletion();
            }
        });
        
        return taskList(task, tasks);
    };
}

/**
 * Reset module state (useful for testing or fresh runs)
 */
function resetModuleState() {
    moduleState.running.clear();
    moduleState.completed.clear();
}

module.exports = {
    taskList,
    runModule,
    runSequential,
    resetModuleState,
    OUTPUT_LINES
};

