/**
 * Declarative Task Helpers
 * 
 * Provides helper functions for building declarative task definitions.
 * These return marker objects that the action runner interprets.
 */

/**
 * Mark a group of actions to run in parallel
 * 
 * @param {Array<{name: string, action: object}>} actions - Actions to run concurrently
 * @param {string} title - Optional title for the parallel group
 * @returns {object} Parallel marker object
 * 
 * @example
 * parallel([
 *   { name: 'setup:vcpkg', action: makeSetupVcpkgAction() },
 *   { name: 'setup:java', action: makeSetupJavaAction() }
 * ])
 */
function parallel(actions, title = 'Parallel tasks') {
    return {
        _type: 'parallel',
        title,
        actions
    };
}

/**
 * Mark a group of actions to run sequentially (useful inside parallel blocks)
 * 
 * @param {Array<{name: string, action: object}>} steps - Steps to run in sequence
 * @param {string} title - Optional title for the sequence group
 * @returns {object} Sequence marker object
 * 
 * @example
 * parallel([
 *   parallel(['nodes:sync', 'ai:sync'], 'sync'),
 *   sequence([
 *     'tika:sync-source',
 *     'tika:build-jar',
 *     'tika:sync'
 *   ], 'tika:pipeline')
 * ])
 */
function sequence(steps, title = 'Sequential tasks') {
    return {
        _type: 'sequence',
        title,
        steps
    };
}

/**
 * Create a bracketed execution block with setup and teardown
 * 
 * Setup runs first, steps run in the middle, teardown always runs (even on error).
 * The setup action's return value is stored in ctx.brackets[name] for child steps.
 * 
 * @param {object} config - Bracket configuration
 * @param {string} config.name - Name for the bracket (used for context storage)
 * @param {object} config.setup - Action to run first (its return value goes to ctx.brackets[name])
 * @param {object} config.teardown - Action to run last (always runs, even on error)
 * @param {Array} config.steps - Steps to run between setup and teardown
 * @returns {object} Bracket marker object
 * 
 * @example
 * bracket({
 *   name: 'model-server',
 *   setup: makeStartModelServerAction(),
 *   teardown: makeStopModelServerAction(),
 *   steps: [
 *     { name: 'test:embeddings', action: makeTestEmbeddingsAction() },
 *     { name: 'test:ocr', action: makeTestOcrAction() }
 *   ]
 * })
 */
function bracket({ name, setup, teardown, steps }) {
    if (!name) throw new Error('bracket requires a name');
    if (!setup) throw new Error('bracket requires a setup action');
    if (!teardown) throw new Error('bracket requires a teardown action');
    if (!steps || !Array.isArray(steps)) throw new Error('bracket requires steps array');
    
    return {
        _type: 'bracket',
        name,
        setup,
        teardown,
        steps
    };
}

/**
 * Create a conditional execution block
 * 
 * The condition function is evaluated at runtime. If true, 'then' steps run.
 * If false and 'else' is provided, 'else' steps run.
 * 
 * @param {object} config - Conditional configuration
 * @param {string} config.name - Name for the condition (used in diagrams)
 * @param {function} config.condition - Function (ctx) => boolean, evaluated at runtime
 * @param {Array} config.then - Steps to run if condition is true
 * @param {Array} [config.else] - Optional steps to run if condition is false
 * @returns {object} When marker object
 * 
 * @example
 * when({
 *   name: 'from-source',
 *   condition: (ctx) => !ctx.downloaded,
 *   then: [
 *     { name: 'server:configure', action: makeConfigureAction() },
 *     { name: 'server:compile-engine', action: makeCompileEngineAction() }
 *   ],
 *   else: [
 *     { name: 'server:use-prebuilt', action: makeUsePrebuiltAction() }
 *   ]
 * })
 */
function when({ name, condition, then: thenSteps, else: elseSteps }) {
    if (!name) throw new Error('when requires a name');
    if (!condition || typeof condition !== 'function') throw new Error('when requires a condition function');
    if (!thenSteps || !Array.isArray(thenSteps)) throw new Error('when requires a then array');
    
    return {
        _type: 'when',
        _variant: 'when',
        name,
        condition,
        then: thenSteps,
        else: elseSteps || []
    };
}

/**
 * Create a conditional execution block that runs when condition is FALSE
 * 
 * This is the inverse of when() - runs 'then' steps when condition returns false.
 * Useful for "unless" style conditions like "run tests unless --skip-tests".
 * 
 * @param {object} config - Conditional configuration
 * @param {string} config.name - Name for the condition (used in diagrams)
 * @param {function} config.condition - Function (ctx) => boolean, runs 'then' when FALSE
 * @param {Array} config.then - Steps to run if condition is false
 * @param {Array} [config.else] - Optional steps to run if condition is true
 * @returns {object} When marker object (with inverted condition)
 * 
 * @example
 * whenNot({
 *   name: 'skip-tests',
 *   condition: (ctx) => ctx.skipTests,
 *   then: [
 *     { name: 'server:run-tests', action: makeRunTestsAction() }
 *   ]
 * })
 */
function whenNot({ name, condition, then: thenSteps, else: elseSteps }) {
    if (!name) throw new Error('whenNot requires a name');
    if (!condition || typeof condition !== 'function') throw new Error('whenNot requires a condition function');
    if (!thenSteps || !Array.isArray(thenSteps)) throw new Error('whenNot requires a then array');
    
    // Invert the condition and swap then/else
    return {
        _type: 'when',
        _variant: 'whenNot',
        name,
        condition: async (ctx) => !(await condition(ctx)),
        then: thenSteps,
        else: elseSteps || []
    };
}

/**
 * Extract dependency information from a command's steps
 * 
 * Returns an array of { action, dependsOn } objects representing
 * the implicit dependency graph from the step structure.
 * 
 * @param {object} command - Command definition with steps
 * @returns {Array<{action: string, dependsOn: string[]}>}
 */
/**
 * Get the name of a step (handles both string refs and objects)
 */
function getStepName(step) {
    if (typeof step === 'string') return step;
    if (step._type === 'sequence') return step.title || 'sequence';
    if (step._type === 'parallel') return step.title || 'parallel';
    if (step._type === 'bracket') return step.name || 'bracket';
    if (step._type === 'when') return step.name || 'condition';
    return step.name || 'unknown';
}


function extractDependencies(command) {
    const deps = [];
    let previousActions = [];
    
    function walk(steps, parentDeps = []) {
        for (const step of steps) {
            // String reference - treat as sequential action
            if (typeof step === 'string') {
                deps.push({
                    action: step,
                    dependsOn: [...parentDeps, ...previousActions]
                });
                previousActions = [step];
                continue;
            }
            
            if (step._type === 'parallel') {
                // All parallel actions depend on whatever came before
                const parallelNames = [];
                for (const action of step.actions) {
                    const actionName = getStepName(action);
                    deps.push({
                        action: actionName,
                        dependsOn: [...parentDeps, ...previousActions]
                    });
                    parallelNames.push(actionName);
                }
                // After parallel block, next steps depend on ALL parallel actions
                previousActions = parallelNames;
                
            } else if (step._type === 'sequence') {
                // Sequence is a sequential sub-pipeline - walk through steps
                for (const seqStep of step.steps) {
                    const seqName = getStepName(seqStep);
                    deps.push({
                        action: seqName,
                        dependsOn: [...parentDeps, ...previousActions]
                    });
                    previousActions = [seqName];
                }
                // After sequence, next steps depend on the last step in sequence
                
            } else if (step._type === 'bracket') {
                // Setup depends on what came before
                const setupName = `${step.name}:setup`;
                deps.push({
                    action: setupName,
                    dependsOn: [...parentDeps, ...previousActions]
                });
                
                previousActions = [setupName];
                
                // Walk inner steps
                walk(step.steps, [setupName]);
                
                // Teardown depends on all inner steps
                deps.push({
                    action: `${step.name}:teardown`,
                    dependsOn: [...previousActions]
                });
                
                // After bracket, next steps depend on teardown
                previousActions = [`${step.name}:teardown`];
                
            } else if (step._type === 'when') {
                // Both then and else branches depend on what came before
                const endActions = [];
                
                // Walk then branch
                const savedPrevious = [...previousActions];
                for (const thenStep of step.then) {
                    const thenName = getStepName(thenStep);
                    deps.push({
                        action: thenName,
                        dependsOn: [...parentDeps, ...previousActions],
                        conditional: `${step.name}:true`
                    });
                    previousActions = [thenName];
                }
                endActions.push(...previousActions);
                
                // Walk else branch if present
                if (step.else && step.else.length > 0) {
                    previousActions = [...savedPrevious];
                    for (const elseStep of step.else) {
                        const elseName = getStepName(elseStep);
                        deps.push({
                            action: elseName,
                            dependsOn: [...parentDeps, ...previousActions],
                            conditional: `${step.name}:false`
                        });
                        previousActions = [elseName];
                    }
                    endActions.push(...previousActions);
                }
                
                // After when block, next steps depend on all branch endpoints
                previousActions = endActions;
                
            } else {
                // Sequential action depends on everything before it
                deps.push({
                    action: step.name,
                    dependsOn: [...parentDeps, ...previousActions]
                });
                previousActions = [step.name];
            }
        }
    }
    
    if (command.steps) {
        walk(command.steps);
    }
    
    return deps;
}

/**
 * Get all action names from a command's steps (flattened)
 * 
 * @param {object} command - Command definition with steps
 * @returns {string[]} List of action names
 */
function listActions(command) {
    const actions = [];
    
    function walk(steps) {
        for (const step of steps) {
            // String reference - it's an action name
            if (typeof step === 'string') {
                actions.push(step);
                continue;
            }
            
            // Handle all control types generically by recursing into their children
            if (step._type === 'parallel') {
                walk(step.actions);
            } else if (step._type === 'sequence') {
                walk(step.steps);
            } else if (step._type === 'bracket') {
                actions.push(`${step.name}:setup`);
                walk(step.steps);
                actions.push(`${step.name}:teardown`);
            } else if (step._type === 'when') {
                if (step.then) walk(step.then);
                if (step.else) walk(step.else);
            } else if (step.name) {
                // Regular action object { name, action }
                actions.push(step.name);
            }
        }
    }
    
    if (command.steps) {
        walk(command.steps);
    }
    
    return actions;
}

/**
 * Print dependency tree to console (simple format)
 * 
 * @param {Array<{action: string, dependsOn: string[]}>} deps - Dependencies from extractDependencies
 */
function printDependencyTree(deps) {
    console.log('\nDependency Tree:');
    console.log('================\n');
    
    for (const { action, dependsOn } of deps) {
        if (dependsOn.length === 0) {
            console.log(`  ${action}`);
        } else {
            console.log(`  ${action}`);
            console.log(`    └─ depends on: ${dependsOn.join(', ')}`);
        }
    }
    console.log('');
}

// ============================================================================
// Inside-Out Flow Diagram Rendering
// ============================================================================
//
// Block structure returned by all render functions:
// {
//   lines: string[],    // The ASCII art lines
//   width: number,      // Total character width  
//   height: number,     // lines.length
//   entryY: number,     // Y-offset where left connector enters
//   exitY: number,      // Y-offset where right connector exits
// }
//
// The algorithm builds from inside-out: recurse to leaves first, then compose
// parent blocks from their children's rendered output. This ensures we know
// the exact width of each element before laying out its container.
// ============================================================================

/**
 * Render a single action: "► action-name "
 * This is the leaf/base case of our recursion.
 * 
 * If the action is a compound action (has steps), expand it.
 */
function renderAction(name) {
    // Check if this is a compound action with steps
    try {
        const registry = require('./registry');
        const actionDef = registry.getAction(name);
        if (actionDef?.action?.steps && Array.isArray(actionDef.action.steps)) {
            // Compound action - render its steps
            const steps = actionDef.action.steps;
            if (actionDef.action.concurrent) {
                // Concurrent steps - render as parallel
                return renderParallel(steps);
            } else {
                // Sequential steps - render as sequence
                return renderSequence(steps);
            }
        }
    } catch {
        // Action not found in registry, render as simple action
    }
    
    // Simple action - render as leaf
    const content = `► ${name} `;
    return {
        lines: [content],
        width: content.length,
        height: 1,
        entryY: 0,
        exitY: 0
    };
}

/**
 * Join multiple blocks horizontally with connectors.
 * Aligns blocks vertically so that exitY of block N aligns with entryY of block N+1.
 * 
 * @param {Block[]} blocks - Array of rendered blocks to join
 * @param {string} connector - Character(s) to use between blocks (default '─')
 * @returns {Block} Combined block
 */
function joinHorizontal(blocks, connector = '─') {
    if (blocks.length === 0) {
        return { lines: [''], width: 0, height: 1, entryY: 0, exitY: 0 };
    }
    if (blocks.length === 1) {
        return blocks[0];
    }
    
    // Calculate vertical offsets to align exit of each block with entry of next
    // We use a coordinate system where y=0 is the "main line" that flows through
    const offsets = [0]; // First block starts at offset 0
    let minY = 0;
    let maxY = blocks[0].height - 1;
    
    for (let i = 1; i < blocks.length; i++) {
        const prev = blocks[i - 1];
        const curr = blocks[i];
        
        // Align prev's exitY with curr's entryY
        // offset = where curr's top should be relative to prev's top
        const offset = offsets[i - 1] + prev.exitY - curr.entryY;
        offsets.push(offset);
        
        // Track bounds
        minY = Math.min(minY, offset);
        maxY = Math.max(maxY, offset + curr.height - 1);
    }
    
    // Normalize offsets so minY = 0
    const normalizedOffsets = offsets.map(o => o - minY);
    const totalHeight = maxY - minY + 1;
    const mainRow = normalizedOffsets[0] + blocks[0].exitY; // The flow line row
    
    // Build output lines
    const totalWidth = blocks.reduce((sum, b) => sum + b.width + connector.length, 0) - connector.length;
    const lines = Array(totalHeight).fill('').map(() => '');
    
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const offset = normalizedOffsets[i];
        
        // Add connector before this block (except first)
        if (i > 0) {
            for (let row = 0; row < totalHeight; row++) {
                if (row === mainRow) {
                    lines[row] += connector;
                } else {
                    lines[row] += ' '.repeat(connector.length);
                }
            }
        }
        
        // Add this block's content
        for (let row = 0; row < totalHeight; row++) {
            const blockRow = row - offset;
            if (blockRow >= 0 && blockRow < block.height) {
                lines[row] += block.lines[blockRow];
            } else {
                lines[row] += ' '.repeat(block.width);
            }
        }
    }
    
    return {
        lines,
        width: totalWidth,
        height: totalHeight,
        entryY: normalizedOffsets[0] + blocks[0].entryY,
        exitY: normalizedOffsets[blocks.length - 1] + blocks[blocks.length - 1].exitY
    };
}

/**
 * Stack multiple blocks vertically for a parallel group.
 * Brackets appear only on entry rows (where flow connects).
 * Non-entry rows get spaces for clean alignment.
 * 
 * @param {Block[]} blocks - Array of rendered blocks to stack
 * @param {object} options - Options for flow connectors
 * @param {boolean} options.leftFlow - If true, use flow connectors on left (flow coming in)
 * @param {boolean} options.rightFlow - If true, use flow connectors on right (flow going out)
 * @returns {Block} Combined block with brackets
 */
function stackVertical(blocks, options = {}) {
    const { leftFlow = false, rightFlow = true } = options;
    
    if (blocks.length === 0) {
        return { lines: ['─'], width: 1, height: 1, entryY: 0, exitY: 0 };
    }
    if (blocks.length === 1) {
        // Single item - just pass through with horizontal connectors
        const block = blocks[0];
        const lines = block.lines.map((line, i) => {
            if (i === block.entryY) {
                return '─' + line + '─';
            } else {
                return ' ' + line + ' ';
            }
        });
        return {
            lines,
            width: block.width + 2,
            height: block.height,
            entryY: block.entryY,
            exitY: block.exitY
        };
    }
    
    // Find max width across all blocks
    const maxWidth = Math.max(...blocks.map(b => b.width));
    
    // Calculate total height
    const totalHeight = blocks.reduce((sum, b) => sum + b.height, 0);
    
    // Build the stacked output - brackets only on entry rows
    const lines = [];
    
    // Find the overall entry row (middle of the stack)
    let totalRows = 0;
    const blockStartRows = [];
    for (const block of blocks) {
        blockStartRows.push(totalRows);
        totalRows += block.height;
    }
    const overallEntryRow = Math.floor((totalRows - 1) / 2);
    
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const isFirst = i === 0;
        const isLast = i === blocks.length - 1;
        const blockStartRow = blockStartRows[i];
        
        for (let row = 0; row < block.height; row++) {
            const isBlockEntry = row === block.entryY;
            const absoluteRow = blockStartRow + row;
            const isOverallEntry = absoluteRow === overallEntryRow;
            
            // Pad content to max width
            const content = block.lines[row].padEnd(maxWidth);
            
            if (isBlockEntry) {
                // Entry row - show brackets
                let leftBracket, rightBracket;
                
                // Determine left bracket based on position and flow
                if (leftFlow && isOverallEntry) {
                    // Flow coming in - use T-connectors
                    if (isFirst) leftBracket = '┬';
                    else if (isLast) leftBracket = '┴';
                    else leftBracket = '┼';
                } else if (isFirst) {
                    leftBracket = '┌';
                } else if (isLast) {
                    leftBracket = '└';
                } else {
                    leftBracket = '├';
                }
                
                // Determine right bracket based on position and flow
                if (rightFlow && isOverallEntry) {
                    // Flow going out - use T-connectors
                    if (isFirst) rightBracket = '┬';
                    else if (isLast) rightBracket = '┴';
                    else rightBracket = '┼';
                } else if (isFirst) {
                    rightBracket = '┐';
                } else if (isLast) {
                    rightBracket = '┘';
                } else {
                    rightBracket = '┤';
                }
                
                lines.push(leftBracket + '─' + content + '─' + rightBracket);
            } else {
                // Non-entry row - just spaces for alignment
                lines.push(' ' + ' ' + content + ' ' + ' ');
            }
        }
    }
    
    // Entry/exit Y is at the middle of the stack
    const middleY = Math.floor((totalHeight - 1) / 2);
    
    return {
        lines,
        width: maxWidth + 4, // brackets + spacing
        height: totalHeight,
        entryY: middleY,
        exitY: middleY
    };
}

/**
 * Wrap a block with a labeled box (for when/whenNot conditions).
 * Uses ┤ and ├ on the entry row to show flow connection.
 * 
 * @param {Block} contentBlock - The inner content block
 * @param {string} label - The condition label (e.g., "whenNot downloaded")
 * @param {Block|null} elseBlock - Optional else branch block
 * @returns {Block} Boxed block
 */
function wrapWithBox(contentBlock, label, elseBlock = null) {
    const hasElse = elseBlock !== null;
            
            // Calculate box content width
    const contentWidth = Math.max(
        contentBlock.width,
        hasElse ? elseBlock.width : 0,
        label.length + 4,
        hasElse ? 8 : 0 // "else" label
    );
    
    const lines = [];
    
    // Top border with label
    const labelPad = contentWidth - label.length - 2;
    const leftPad = Math.floor(labelPad / 2);
    const rightPad = labelPad - leftPad;
    lines.push('┌' + '─'.repeat(leftPad) + ' ' + label + ' ' + '─'.repeat(rightPad) + '┐');
    
    // Entry row is at the middle of the "then" section (relative to content, +1 for header)
    const entryRowInContent = Math.floor((contentBlock.height - 1) / 2);
            
            // Then content
    for (let i = 0; i < contentBlock.height; i++) {
        const row = contentBlock.lines[i].padEnd(contentWidth);
        const isEntryRow = i === entryRowInContent;
        // Use ┤ and ├ on entry row to show flow connection
        const leftBorder = isEntryRow ? '┤' : '│';
        const rightBorder = isEntryRow ? '├' : '│';
        lines.push(leftBorder + row + rightBorder);
    }
    
    // Else section if present
            if (hasElse) {
                const elsePad = contentWidth - 6;
                const elseLeftPad = Math.floor(elsePad / 2);
                const elseRightPad = elsePad - elseLeftPad;
        lines.push('├' + '─'.repeat(elseLeftPad) + ' else ' + '─'.repeat(elseRightPad) + '┤');
        
        for (let i = 0; i < elseBlock.height; i++) {
            const row = elseBlock.lines[i].padEnd(contentWidth);
            lines.push('│' + row + '│');
        }
    }
    
    // Bottom border
    lines.push('└' + '─'.repeat(contentWidth) + '┘');
    
    const totalHeight = lines.length;
    // Entry/exit at the middle of the "then" section (+1 for header row)
    const entryY = 1 + entryRowInContent;
    
    return {
        lines,
        width: contentWidth + 2, // For the │ borders
        height: totalHeight,
        entryY,
        exitY: entryY
    };
}

/**
 * Main recursive render function.
 * Dispatches to the appropriate renderer based on node type.
 * 
 * @param {string|object} node - A step/action node
 * @returns {Block} Rendered block
 */
function renderNode(node) {
    if (typeof node === 'string') {
        return renderAction(node);
    }
    
    switch (node._type) {
        case 'parallel':
            return renderParallel(node.actions);
        case 'sequence':
            return renderSequence(node.steps);
        case 'when':
            return renderWhen(node);
        case 'bracket':
            return renderBracket(node);
        default:
            // Fallback for unknown types - render as action
            return renderAction(getStepName(node));
    }
}

/**
 * Render a sequence of steps by joining them horizontally.
 * 
 * @param {Array} steps - Steps to render in sequence
 * @returns {Block} Rendered block
 */
function renderSequence(steps) {
    if (!steps || steps.length === 0) {
        return { lines: [''], width: 0, height: 1, entryY: 0, exitY: 0 };
    }
    
    // Render all children first (inside-out!)
    const blocks = steps.map(step => renderNode(step));
    
    // Join them horizontally
    return joinHorizontal(blocks);
}

/**
 * Flatten nested parallels into a single list of items.
 * Nested parallels are expanded so all items share the same bracket group.
 * Sequences remain as single items (rendered horizontally).
 * 
 * @param {Array} actions - Actions to flatten
 * @returns {Array} Flattened list of actions (no nested parallels)
 */
function flattenParallelActions(actions) {
    const result = [];
    for (const action of actions) {
        if (action && action._type === 'parallel') {
            // Flatten nested parallel - include its items directly
            result.push(...flattenParallelActions(action.actions));
        } else {
            result.push(action);
        }
    }
    return result;
}

/**
 * Render a parallel group by stacking children vertically.
 * Nested parallels are flattened so all items share one bracket group.
 * 
 * @param {Array} actions - Actions to render in parallel
 * @returns {Block} Rendered block
 */
function renderParallel(actions) {
    if (!actions || actions.length === 0) {
        return { lines: ['─'], width: 1, height: 1, entryY: 0, exitY: 0 };
    }
    
    // Flatten nested parallels first
    const flattenedActions = flattenParallelActions(actions);
    
    // Render all children first (inside-out!)
    const blocks = flattenedActions.map(action => renderNode(action));
    
    // Stack them vertically with brackets
    return stackVertical(blocks);
}

/**
 * Calculate the max action name length across all steps (for width alignment).
 * 
 * @param {Array} steps - Steps to analyze
 * @returns {number} Max action name length
 */
function calculateMaxActionWidth(steps) {
    let maxLen = 0;
    
    for (const step of steps) {
        if (typeof step === 'string') {
            maxLen = Math.max(maxLen, step.length);
        } else if (step._type === 'parallel') {
            // Check all actions in the parallel (including nested)
            const flattened = flattenParallelActions(step.actions);
            for (const action of flattened) {
                if (typeof action === 'string') {
                    maxLen = Math.max(maxLen, action.length);
                } else if (action._type === 'sequence') {
                    // For sequences, we need the total rendered width, not just names
                    // Skip for now - they'll be handled differently
                } else {
                    maxLen = Math.max(maxLen, getStepName(action).length);
                }
            }
        } else if (step._type === 'sequence') {
            maxLen = Math.max(maxLen, calculateMaxActionWidth(step.steps));
        } else if (step._type === 'bracket') {
            maxLen = Math.max(maxLen, `${step.name}:teardown`.length);
            maxLen = Math.max(maxLen, calculateMaxActionWidth(step.steps));
        } else {
            maxLen = Math.max(maxLen, getStepName(step).length);
        }
    }
    
    return maxLen;
}

/**
 * Render a parallel block with a minimum content width (for alignment).
 * 
 * @param {Array} actions - Actions to render
 * @param {number} minContentWidth - Minimum width for action names
 * @returns {Block} Rendered block
 */
function renderParallelWithWidth(actions, minContentWidth) {
    if (!actions || actions.length === 0) {
        return { lines: ['─'], width: 1, height: 1, entryY: 0, exitY: 0 };
    }
    
    // Flatten nested parallels
    const flattenedActions = flattenParallelActions(actions);
    
    // Render each action with padded name
    const blocks = flattenedActions.map(action => {
        if (typeof action === 'string') {
            // Pad action name to min width
            const paddedName = action.padEnd(minContentWidth);
            return {
                lines: [`► ${paddedName} `],
                width: paddedName.length + 3, // "► " + name + " "
                height: 1,
                entryY: 0,
                exitY: 0
            };
        } else if (action._type === 'sequence') {
            // Sequences render horizontally
            return renderSequence(action.steps);
        } else {
            const name = getStepName(action);
            const paddedName = name.padEnd(minContentWidth);
            return {
                lines: [`► ${paddedName} `],
                width: paddedName.length + 3,
                height: 1,
                entryY: 0,
                exitY: 0
            };
        }
    });
    
    // Don't use flow connectors - these parallels are inside a vertical list (when box)
    return stackVertical(blocks, { leftFlow: false, rightFlow: false });
}

/**
 * Render steps as a vertical list (for inside when/whenNot boxes).
 * Sequential items stack vertically, parallel groups are rendered inline.
 * Uses two passes to ensure consistent width alignment.
 * 
 * @param {Array} steps - Steps to render as vertical list
 * @returns {Block} Rendered block with items stacked vertically
 */
function renderVerticalList(steps) {
    if (!steps || steps.length === 0) {
        return { lines: [''], width: 0, height: 1, entryY: 0, exitY: 0 };
    }
    
    // Pass 1: Calculate max action name width for alignment
    const maxActionWidth = calculateMaxActionWidth(steps);
    
    // Pass 2: Render with consistent widths
    const allLines = [];
    let maxWidth = 0;
    
    for (const step of steps) {
        if (typeof step === 'string') {
            // Simple action - pad to max width, no right-side brackets
            const paddedName = step.padEnd(maxActionWidth);
            const line = `  ► ${paddedName}`;
            allLines.push(line);
            maxWidth = Math.max(maxWidth, line.length);
        } else if (step._type === 'parallel') {
            // Parallel block - render with consistent width, indented to match sequential items
            const block = renderParallelWithWidth(step.actions, maxActionWidth);
            for (const line of block.lines) {
                // Add 2-space indent to match sequential items, and trailing space for box padding
                const indentedLine = '  ' + line + ' ';
                allLines.push(indentedLine);
                maxWidth = Math.max(maxWidth, indentedLine.length);
            }
        } else if (step._type === 'sequence') {
            // Nested sequence - render each item vertically
            const innerBlock = renderVerticalList(step.steps);
            for (const line of innerBlock.lines) {
                allLines.push(line);
            }
            maxWidth = Math.max(maxWidth, innerBlock.width);
        } else if (step._type === 'when') {
            // Nested conditional - render it
            const innerBlock = renderWhen(step);
            for (const line of innerBlock.lines) {
                allLines.push(line);
            }
            maxWidth = Math.max(maxWidth, innerBlock.width);
        } else if (step._type === 'bracket') {
            // Bracket - render setup, steps, teardown vertically
            const setupName = `${step.name}:setup`.padEnd(maxActionWidth);
            const teardownName = `${step.name}:teardown`.padEnd(maxActionWidth);
            allLines.push(`  ► ${setupName}`);
            const innerBlock = renderVerticalList(step.steps);
            for (const line of innerBlock.lines) {
                allLines.push(line);
            }
            allLines.push(`  ► ${teardownName}`);
            maxWidth = Math.max(maxWidth, innerBlock.width, `  ► ${teardownName}`.length);
                    } else {
            // Other types - render as action
            const name = getStepName(step);
            const paddedName = name.padEnd(maxActionWidth);
            const line = `  ► ${paddedName}`;
            allLines.push(line);
            maxWidth = Math.max(maxWidth, line.length);
        }
    }
    
    // Pad all lines to max width
    const paddedLines = allLines.map(line => line.padEnd(maxWidth));
    
    const height = paddedLines.length;
    const middleY = Math.floor((height - 1) / 2);
    
    return {
        lines: paddedLines,
        width: maxWidth,
        height,
        entryY: middleY,
        exitY: middleY
    };
}

/**
 * Render a conditional (when/whenNot) block.
 * Content inside the box is rendered as a vertical list.
 * 
 * @param {object} node - When node with then/else branches
 * @returns {Block} Rendered block
 */
function renderWhen(node) {
    const variant = node._variant || 'when';
    const label = `${variant} ${node.name}`;
    
    // Render then branch as vertical list (inside-out!)
    const thenBlock = renderVerticalList(node.then);
    
    // Render else branch if present as vertical list (inside-out!)
    const elseBlock = node.else && node.else.length > 0 
        ? renderVerticalList(node.else) 
        : null;
    
    // Wrap with labeled box
    return wrapWithBox(thenBlock, label, elseBlock);
}

/**
 * Render a bracket (setup/teardown) block.
 * 
 * @param {object} node - Bracket node
 * @returns {Block} Rendered block
 */
function renderBracket(node) {
    // Render as: setup → [inner steps] → teardown
    const setupBlock = renderAction(`${node.name}:setup`);
    const innerBlock = renderSequence(node.steps);
    const teardownBlock = renderAction(`${node.name}:teardown`);
    
    return joinHorizontal([setupBlock, innerBlock, teardownBlock]);
}


/**
 * Print a beautiful horizontal flow diagram using inside-out rendering.
 * 
 * The algorithm recursively builds from leaves to root, so each element
 * knows its exact width before its parent lays it out.
 * 
 *                     ┌─► test:embeddings ─┐
 * model-server:setup ─├─► test:ocr ────────┤─► model-server:teardown
 *                     └─► test:whisper ────┘
 * 
 * @param {object} command - Command definition with steps
 * @param {number} maxWidth - Maximum line width (default: terminal width or 120)
 */
function printFlowDiagram(command, maxWidth) {
    if (!maxWidth) {
        maxWidth = process.stdout.columns || 120;
    }
    
    if (!command.steps || command.steps.length === 0) {
        console.log('  (no steps defined)\n');
        return;
    }
    
    // Build the sequence including a "Done" marker at the end
    const stepsWithDone = [...command.steps, '✔ Done'];
    
    // Render the entire flow using inside-out algorithm
    const block = renderSequence(stepsWithDone);
    
    // Print each line with indent
    console.log('');
    for (const line of block.lines) {
            const trimmed = line.trimEnd();
            if (trimmed) {
                console.log('  ' + trimmed);
        }
    }
    console.log('');
}

module.exports = {
    parallel,
    sequence,
    bracket,
    when,
    whenNot,
    extractDependencies,
    listActions,
    printDependencyTree,
    printFlowDiagram
};

