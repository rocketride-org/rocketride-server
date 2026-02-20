/**
 * Action Runner - Two-Phase Architecture
 * 
 * Phase 1: Build the complete task tree upfront (before any execution)
 * Phase 2: Execute via Listr2 with simple runtime deduplication
 * 
 * Key design principles:
 * - Complete tree is built before execution (no dynamic task.newListr except for when blocks)
 * - Deduplication via simple skip checks, not promise waiting
 * - Compound actions expanded at build time so Listr2 sees full structure
 * - Brackets flattened into visible setup → steps → teardown sequence
 */
const { Listr } = require('listr2');
const registry = require('./registry');

// Output lines to show per task
const OUTPUT_LINES = 5;

// Track which actions have completed this session (for deduplication)
const completedActions = new Set();

// Lock management for mutual exclusion on external resources
const locks = new Map();  // lockName -> { promise, resolve }

/**
 * Acquire one or more locks (waits if held)
 */
async function acquireLocks(lockNames, task) {
    if (!lockNames || lockNames.length === 0) return;
    
    for (const name of lockNames) {
        while (locks.has(name)) {
            task.output = `Waiting for lock: ${name}`;
            await locks.get(name).promise;
        }
        
        let resolve;
        const promise = new Promise(r => { resolve = r; });
        locks.set(name, { promise, resolve });
    }
}

/**
 * Release one or more locks
 */
function releaseLocks(lockNames) {
    if (!lockNames || lockNames.length === 0) return;
    
    for (const name of lockNames) {
        const lock = locks.get(name);
        if (lock) {
            locks.delete(name);
            lock.resolve();
        }
    }
}

/**
 * Reset action tracking (call at start of new build session)
 */
function resetActionTracking() {
    completedActions.clear();
    locks.clear();
}

// ============================================================================
// Phase 1: Build Task Tree
// ============================================================================

/**
 * Resolve an action definition from registry or inline
 * 
 * @param {string|object} step - Step (string ref like 'vcpkg:clone' or { name, action })
 * @returns {{ name: string, actionObj: object }} Resolved action
 */
function resolveAction(step) {
    if (typeof step === 'string') {
        const found = registry.getAction(step);
        if (!found) {
            throw new Error(`Action not found in registry: ${step}`);
        }
        const actionObj = typeof found.action === 'function' ? found.action() : found.action;
        return { name: step, actionObj };
    }
    
    const { name, action } = step;
    const actionObj = typeof action === 'function' ? action() : action;
    return { name, actionObj };
}

/**
 * Build a Listr2 task for a leaf action (has run function, no steps)
 * 
 * @param {string} name - Action name
 * @param {object} actionObj - Action definition
 * @param {string} logModule - Module name for log collection (e.g., 'client-python:test')
 */
function buildLeafTask(name, actionObj, logModule) {
    return {
        title: name,
        skip: () => {
            // Return true (not string) to show just "↓ action-name" without extra text
            if (!actionObj.multi && completedActions.has(name)) {
                return true;
            }
            return false;
        },
        task: async (ctx, task) => {
            // For non-multi actions, automatically lock on action name
            // This ensures the same action can't run concurrently
            if (!actionObj.multi) {
                await acquireLocks([name], task);
            }
            
            // Check again after acquiring lock (another instance may have completed)
            if (!actionObj.multi && completedActions.has(name)) {
                releaseLocks([name]);
                return;
            }
            
            if (actionObj.description) {
                task.output = actionObj.description;
            }
            
            // Store logModule on task for execCommand to find automatically
            task._logModule = logModule;
            
            // Acquire additional manual locks if needed
            if (actionObj.locks?.length) {
                await acquireLocks(actionObj.locks, task);
            }
            
            try {
                // Pass logModule as third argument for actions that want to log
                const result = await actionObj.run(ctx, task, { logModule });
                
                // Mark completed
                if (!actionObj.multi) {
                    completedActions.add(name);
                }
                
                return result;
            } finally {
                if (actionObj.locks?.length) {
                    releaseLocks(actionObj.locks);
                }
                if (!actionObj.multi) {
                    releaseLocks([name]);
                }
            }
        },
        rendererOptions: {
            outputBar: actionObj.outputLines ?? OUTPUT_LINES,
            persistentOutput: false
        }
    };
}

/**
 * Build a Listr2 task for a compound action (has steps array)
 * The children are pre-built so Listr2 sees the full tree.
 * 
 * @param {string} name - Action name
 * @param {object} actionObj - Action definition
 * @param {Set} seen - Set of seen action names
 * @param {string} logModule - Module name for log collection
 */
function buildCompoundTask(name, actionObj, seen, logModule) {
    // Check if already seen (for deduplication)
    if (!actionObj.multi && seen.has(name)) {
        return {
            title: name,
            skip: () => true,  // Just show "↓ action-name"
            task: () => {},
            rendererOptions: { outputBar: 1, persistentOutput: false }
        };
    }
    
    // Mark as seen
    if (!actionObj.multi) {
        seen.add(name);
    }
    
    // Build children
    const children = buildTaskTree(actionObj.steps, seen, logModule);
    
    // Add lock release and completion marker as final child
    // Note: We combine these into one task with empty title to minimize visual noise
    const hasLocks = actionObj.locks?.length || !actionObj.multi;
    if (hasLocks || !actionObj.multi) {
        children.push({
            title: '',
            task: () => {
                // Release manual locks
                if (actionObj.locks?.length) {
                    releaseLocks(actionObj.locks);
                }
                // Release automatic action-name lock
                if (!actionObj.multi) {
                    releaseLocks([name]);
                    completedActions.add(name);
                }
            },
            rendererOptions: { outputBar: 0, persistentOutput: false }
        });
    }
    
    return {
        title: name,
        skip: () => {
            if (!actionObj.multi && completedActions.has(name)) {
                return true;  // Just show "↓ action-name"
            }
            return false;
        },
        task: async (ctx, task) => {
            // For non-multi actions, automatically lock on action name
            // This ensures the same action can't run concurrently
            if (!actionObj.multi) {
                await acquireLocks([name], task);
            }
            
            // Check again after acquiring lock (another instance may have completed)
            if (!actionObj.multi && completedActions.has(name)) {
                releaseLocks([name]);
                return;
            }
            
            // Acquire additional manual locks at start (if specified)
            if (actionObj.locks?.length) {
                await acquireLocks(actionObj.locks, task);
            }
            
            // Return pre-built children
            return task.newListr(children, {
                concurrent: actionObj.concurrent ?? false,
                exitOnError: true,
                rendererOptions: { 
                    collapseSubtasks: true  // Collapse children when this task completes
                }
            });
        },
        rendererOptions: {
            outputBar: OUTPUT_LINES,
            persistentOutput: false
        }
    };
}

/**
 * Build a Listr2 task for a parallel group
 * 
 * @param {object} parallel - Parallel definition
 * @param {Set} seen - Set of seen action names
 * @param {string} logModule - Module name for log collection
 */
function buildParallelTask(parallel, seen, logModule) {
    const children = buildTaskTree(parallel.actions, seen, logModule);
    
    return {
        title: parallel.title || 'Parallel tasks',
        task: (ctx, task) => {
            return task.newListr(children, {
                concurrent: true,
                exitOnError: true,
                rendererOptions: { 
                    collapseSubtasks: true  // Collapse children when this task completes
                }
            });
        },
        rendererOptions: {
            outputBar: OUTPUT_LINES,
            persistentOutput: false
        }
    };
}

/**
 * Build a Listr2 task for a sequence group
 * 
 * @param {object} sequence - Sequence definition
 * @param {Set} seen - Set of seen action names
 * @param {string} logModule - Module name for log collection
 */
function buildSequenceTask(sequence, seen, logModule) {
    const children = buildTaskTree(sequence.steps, seen, logModule);
    
    return {
        title: sequence.title || 'Sequential tasks',
        task: (ctx, task) => {
            return task.newListr(children, {
                concurrent: false,
                exitOnError: true,
                rendererOptions: { 
                    collapseSubtasks: true  // Collapse children when this task completes
                }
            });
        },
        rendererOptions: {
            outputBar: OUTPUT_LINES,
            persistentOutput: false
        }
    };
}

/**
 * Build Listr2 tasks for a bracket (setup/teardown pattern)
 * Returns a FLAT array of tasks: [setup, ...innerTasks, teardown, errorCheck]
 * This allows inner task output to be visible at the top level.
 * 
 * @param {object} bracket - Bracket definition
 * @param {Set} seen - Set of seen action names
 * @param {string} logModule - Module name for log collection
 * @returns {Array} Array of Listr2 task definitions (not a single task)
 */
function buildBracketTask(bracket, seen, logModule) {
    // Build inner tasks
    const innerTasks = buildTaskTree(bracket.steps, seen, logModule);
    
    // Wrap inner tasks to catch errors but allow teardown to run
    const wrappedInnerTasks = innerTasks.map((innerTask, index) => ({
        ...innerTask,
        // Add visual marker for first inner task
        title: index === 0 ? `│ ${innerTask.title}` : `│ ${innerTask.title}`,
        skip: (ctx) => {
            // Skip if setup didn't complete or error occurred
            if (!ctx._bracketSetupComplete?.[bracket.name]) return 'Setup incomplete';
            if (ctx._bracketErrors?.[bracket.name]) return 'Previous error';
            return typeof innerTask.skip === 'function' ? innerTask.skip(ctx) : innerTask.skip;
        },
        task: async (ctx, task) => {
            try {
                if (typeof innerTask.task === 'function') {
                    return await innerTask.task(ctx, task);
                }
            } catch (e) {
                // Store error but don't prevent teardown
                ctx._bracketErrors = ctx._bracketErrors || {};
                ctx._bracketErrors[bracket.name] = e;
                throw e;  // Still throw so this task shows as failed
            }
        }
    }));
    
    const setupTask = {
        title: `┌ ${bracket.name}:setup`,
        task: async (ctx, task) => {
            ctx.brackets = ctx.brackets || {};
            ctx._bracketErrors = ctx._bracketErrors || {};
            ctx._bracketSetupComplete = ctx._bracketSetupComplete || {};
            
            if (bracket.setup.description) {
                task.output = bracket.setup.description;
            }
            
            try {
                const setupResult = await bracket.setup.run(ctx, task);
                ctx.brackets[bracket.name] = setupResult;
                ctx._bracketSetupComplete[bracket.name] = true;
            } catch (e) {
                ctx._bracketErrors[bracket.name] = e;
                throw e;
            }
        },
        rendererOptions: {
            outputBar: OUTPUT_LINES,
            persistentOutput: false
        }
    };
    
    const teardownTask = {
        title: `└ ${bracket.name}:teardown`,
        // Never skip teardown due to errors - always try to clean up
        skip: (ctx) => {
            if (!ctx._bracketSetupComplete?.[bracket.name]) return 'Setup incomplete';
            return false;  // Always run teardown if setup completed
        },
        task: async (ctx, task) => {
            if (bracket.teardown) {
                try {
                    await bracket.teardown.run(ctx, task);
                } catch (teardownError) {
                    // Store teardown error but don't throw
                    ctx._bracketErrors = ctx._bracketErrors || {};
                    if (!ctx._bracketErrors[bracket.name]) {
                        ctx._bracketErrors[bracket.name] = teardownError;
                    }
                    // Don't throw - teardown should always complete
                }
            }
            
            // After teardown, propagate any stored errors
            if (ctx._bracketErrors?.[bracket.name]) {
                throw ctx._bracketErrors[bracket.name];
            }
        },
        rendererOptions: {
            outputBar: OUTPUT_LINES,
            persistentOutput: false
        }
    };
    
    // Return flat array of tasks
    return [
        setupTask,
        ...wrappedInnerTasks,
        teardownTask
    ];
}

/**
 * Build a Listr2 task for a when/whenNot conditional
 * 
 * This is the ONE place where we need dynamic task creation,
 * because the condition is evaluated at runtime.
 * 
 * @param {object} when - When definition
 * @param {Set} seen - Set of seen action names
 * @param {string} logModule - Module name for log collection
 */
function buildWhenTask(when, seen, logModule) {
    const variant = when._variant || 'when';
    
    // Pre-build both branches so structure is known
    const thenTasks = buildTaskTree(when.then, seen, logModule);
    const elseTasks = when.else?.length ? buildTaskTree(when.else, seen, logModule) : [];
    
    return {
        title: `? ${variant} ${when.name}`,
        task: async (ctx, task) => {
            // Evaluate condition at runtime
            const conditionResult = await when.condition(ctx);
            
            let tasksToRun;
            if (conditionResult) {
                task.title = `✓ ${variant} ${when.name}`;
                tasksToRun = thenTasks;
            } else if (elseTasks.length > 0) {
                task.title = `✗ ${variant} ${when.name}`;
                tasksToRun = elseTasks;
            } else {
                task.title = `○ ${variant} ${when.name}`;
                return; // No else branch and condition is false
            }
            
            if (tasksToRun.length > 0) {
                return task.newListr(tasksToRun, {
                    concurrent: false,
                    exitOnError: true,
                    rendererOptions: { 
                        collapseSubtasks: true  // Collapse children when this task completes
                    }
                });
            }
        },
        rendererOptions: {
            outputBar: OUTPUT_LINES,
            persistentOutput: false
        }
    };
}

/**
 * Build a Listr2 task for a single step
 * 
 * @param {string|object} step - Step definition
 * @param {Set} seen - Set of action names already seen (for deduplication)
 * @param {string} logModule - Module name for log collection
 * @returns {object} Listr2 task definition
 */
function buildTask(step, seen, logModule) {
    // String reference - action name like 'vcpkg:clone'
    if (typeof step === 'string') {
        const { name, actionObj } = resolveAction(step);
        
        if (actionObj.steps && Array.isArray(actionObj.steps)) {
            return buildCompoundTask(name, actionObj, seen, logModule);
        } else {
            // Check deduplication for leaf actions
            if (!actionObj.multi && seen.has(name)) {
                return {
                    title: name,
                    skip: () => true,  // Just show "↓ action-name"
                    task: () => {},
                    rendererOptions: { outputBar: 1, persistentOutput: false }
                };
            }
            if (!actionObj.multi) {
                seen.add(name);
            }
            return buildLeafTask(name, actionObj, logModule);
        }
    }
    
    // Control flow types
    if (step._type === 'parallel') {
        return buildParallelTask(step, seen, logModule);
    }
    if (step._type === 'sequence') {
        return buildSequenceTask(step, seen, logModule);
    }
    if (step._type === 'bracket') {
        return buildBracketTask(step, seen, logModule);
    }
    if (step._type === 'when') {
        return buildWhenTask(step, seen, logModule);
    }
    
    // Object with name/action - inline action definition
    if (step.name && step.action) {
        const { name, actionObj } = resolveAction(step);
        
        if (actionObj.steps && Array.isArray(actionObj.steps)) {
            return buildCompoundTask(name, actionObj, seen, logModule);
        } else {
            if (!actionObj.multi && seen.has(name)) {
                return {
                    title: name,
                    skip: () => true,  // Just show "↓ action-name"
                    task: () => {},
                    rendererOptions: { outputBar: 1, persistentOutput: false }
                };
            }
            if (!actionObj.multi) {
                seen.add(name);
            }
            return buildLeafTask(name, actionObj, logModule);
        }
    }
    
    throw new Error(`Unknown step type: ${JSON.stringify(step)}`);
}

/**
 * Build Listr2 task array from steps
 * 
 * This is the main entry point for Phase 1.
 * Recursively builds the complete tree with deduplication.
 * 
 * Note: Some builders (like buildBracketTask) return arrays of tasks,
 * so we use flatMap to flatten them into a single array.
 * 
 * @param {Array} steps - Array of step definitions
 * @param {Set} seen - Set of action names already seen (for deduplication)
 * @param {string} logModule - Module name for log collection (e.g., 'client-python:test')
 * @returns {Array} Array of Listr2 task definitions
 */
function buildTaskTree(steps, seen = new Set(), logModule = null) {
    if (!steps || steps.length === 0) {
        return [];
    }
    
    // Use flatMap because some builders (brackets) return arrays
    return steps.flatMap(step => {
        const result = buildTask(step, seen, logModule);
        return Array.isArray(result) ? result : [result];
    });
}

// ============================================================================
// Phase 2: Execute
// ============================================================================

/**
 * Run a command's steps
 * 
 * @param {object} command - Command definition with steps
 * @param {object} options - Runner options
 * @param {object} ctx - Initial context
 * @returns {Promise} Resolves when all steps complete
 */
async function runTaskCommand(command, options = {}, ctx = {}) {
    if (!command.steps || command.steps.length === 0) {
        return;
    }
    
    // Phase 1: Build complete task tree
    const tasks = buildTaskTree(command.steps);
    
    // Phase 2: Execute via Listr2
    const runner = new Listr(tasks, {
        concurrent: false,
        exitOnError: true,
        rendererOptions: {
            showTimer: true,
            collapseSubtasks: !options.verbose,
            showErrorMessage: true
        },
        renderer: options.verbose || process.env.CI ? 'verbose' : 'default'
    });
    
    return runner.run(ctx);
}

/**
 * Create a Listr instance from steps (for use as subtask)
 * 
 * @param {object} parentTask - Parent Listr task
 * @param {Array} steps - Array of step definitions
 * @param {object} options - Options
 * @returns {Listr} Configured Listr instance
 */
function stepsToListr(parentTask, steps, _options = {}) {
    const tasks = buildTaskTree(steps);
    
    return parentTask.newListr(tasks, {
        concurrent: false,
        exitOnError: true,
        rendererOptions: {
            collapseSubtasks: false
        }
    });
}

module.exports = {
    // Phase 1
    buildTaskTree,
    buildTask,
    resolveAction,
    
    // Phase 2
    runTaskCommand,
    stepsToListr,
    
    // Runtime utilities
    acquireLocks,
    releaseLocks,
    resetActionTracking,
    
    // Constants
    OUTPUT_LINES
};
