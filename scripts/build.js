/**
 * RocketRide Build System
 * 
 * Unified build orchestrator that discovers and runs build tasks
 * from tasks.js files throughout the project.
 * 
 * Usage:
 *   builder <action> [...] [options]
 * 
 * Examples:
 *   builder server:build
 *   builder server:build nodes:build --parallel
 *   builder server:clean --force
 *   builder --help
 */

// ! 
// ! IMPORTANT:
// ! 
// ! build.js must NOT use any other scripts/ modules unless
// ! parseArgs() is called first and global variables are set.
// ! 
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Track log file for signal handlers (set in main after log is required)
let currentLogFile = null;
let logModule = null;

async function handleTermination(signal) {
    if (logModule && currentLogFile && logModule.hasLogEntries()) {
        console.log(`\n\nReceived ${signal}, writing log...`);
        await logModule.writeLog(currentLogFile);
        console.log(`Log written to ${currentLogFile}`);
    }
    process.exit(130); // Standard exit code for SIGINT
}

function parseArgs(args) {
    const requests = [];
    const options = {
        autoinstall: false,
        force: false,
        verbose: false,
        parallel: true,   // Default to parallel execution
        sequential: false,
        help: false,
        listActions: false,
        listDeps: false,
        listModules: false,
        logFile: null,    // Log file for test output
        overlayRoot: null, // Root directory for overlay
        buildVersion: null,
        buildHash: null,
        buildStamp: null,
    };
    const globalCommands = [];  // Commands without module (e.g., just "build")

    for (const arg of args) {
        if (arg === '--autoinstall') {
            options.autoinstall = true;
        } else if (arg === '--force' || arg === '-f') {
            options.force = true;
        } else if (arg === '--verbose' || arg === '-v') {
            options.verbose = true;
        } else if (arg === '--sequential' || arg === '-s') {
            options.parallel = false;  // Override default parallel
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--list-actions') {
            options.listActions = true;
        } else if (arg === '--list-deps') {
            options.listDeps = true;
        } else if (arg === '--list-modules') {
            options.listModules = true;
        } else if (arg.startsWith('--pytest=')) {
            options.pytest = options.pytest || [];
            options.pytest.push(arg.substring('--pytest='.length));
        } else if (arg.startsWith('--jest=')) {
            options.jest = options.jest || [];
            options.jest.push(arg.substring('--jest='.length));
        } else if (arg.startsWith('--catch=')) {
            options.catch = options.catch || [];
            options.catch.push(arg.substring('--catch='.length));
        } else if (arg.startsWith('--trace=')) {
            options.trace = options.trace || [];
            options.trace.push(arg.substring('--trace='.length));
        } else if (arg.startsWith('--testport=')) {
            options.testport = parseInt(arg.substring('--testport='.length), 10);
        } else if (arg.startsWith('--log=')) {
            options.logFile = arg.substring('--log='.length);
            currentLogFile = options.logFile; // For signal handlers
        } else if (arg.startsWith('--overlay-root=')) {
            options.overlayRoot = path.resolve(arg.substring('--overlay-root='.length));
            const paths = require('./lib/paths');
            paths.BUILD_ROOT = path.join(options.overlayRoot, 'build');
            paths.DIST_ROOT = path.join(options.overlayRoot, 'dist');
            process.env.ROCKETRIDE_BUILD_ROOT = paths.BUILD_ROOT;
            process.env.ROCKETRIDE_DIST_ROOT = paths.DIST_ROOT;
        } else if (arg === '--nodownload') {
            options.nodownload = true;
        } else if (arg.startsWith('--arch=')) {
            const archValue = arg.substring('--arch='.length).toLowerCase();
            if (archValue === 'arm' || archValue === 'arm64') {
                options.arch = 'arm64';
            } else if (archValue === 'intel' || archValue === 'x64' || archValue === 'x86_64') {
                options.arch = 'x64';
            } else {
                console.error(`Invalid --arch value: ${archValue}. Use 'arm' or 'intel'.`);
                process.exit(1);
            }
        } else if (arg.startsWith('--version=')) {
            options.buildVersion = arg.substring('--version='.length);
        } else if (arg.startsWith('--hash=')) {
            options.buildHash = arg.substring('--hash='.length);
        } else if (arg.startsWith('--stamp=')) {
            options.buildStamp = arg.substring('--stamp='.length);
        } else if (arg.includes(':')) {
            // Unified model: action names like "server:build", "nodes:sync"
            // Extract module from action name (first part before colon)
            const colonIdx = arg.indexOf(':');
            const module = arg.substring(0, colonIdx);
            requests.push({ module, command: arg });
        } else if (!arg.startsWith('-')) {
            // Bare command (e.g., "build") - will apply to all modules with that command
            globalCommands.push(arg);
        } else {
            console.error(`Error: Unknown argument '${arg}'`);
            process.exit(1);
        }
    }

    return { requests, options, globalCommands };
}

/**
 * Expand global commands to all modules that support them
 * 
 * Looks for actions like "moduleName:command" with descriptions (public actions)
 */
function expandGlobalCommands(globalCommands, registry, options) {
    const requests = [];

    for (const command of globalCommands) {
        for (const moduleName of registry.names()) {
            const actionName = `${moduleName}:${command}`;
            const actionDef = registry.getAction(actionName);
            if (actionDef) {
                const actionObj = typeof actionDef.action === 'function'
                    ? actionDef.action(options)
                    : actionDef.action;
                // Only expand to public actions (those with descriptions)
                if (actionObj?.description) {
                    requests.push({ module: moduleName, command: actionName });
                }
            }
        }
    }

    return requests;
}

function showHelp(registry, options) {
    console.log(`
Rocketride Build System

Usage: builder <action> [...] [options]

Actions:`);

    const commands = registry.listCommands(options);

    // Group by module
    const grouped = {};
    for (const cmd of commands) {
        if (!grouped[cmd.module]) {
            grouped[cmd.module] = [];
        }
        grouped[cmd.module].push(cmd);
    }

    for (const [moduleName, cmds] of Object.entries(grouped).sort()) {
        const mod = registry.get(moduleName);
        console.log(`
  ${moduleName} - ${mod.description || ''}`);
        for (const cmd of cmds) {
            console.log(`    ${cmd.full.padEnd(30)} ${cmd.description}`);
        }
    }

    console.log(`
Options:
  --autoinstall       Install missing tools (pnpm; on Windows/Linux, VS/C++ when compiling engine)
  --force, -f         Force rebuild (ignore cache/state)
  --verbose, -v       Show detailed output
  --sequential, -s    Run modules sequentially (default: parallel)
  --nodownload        Force compile from source (skip prebuilt download)
  --arch=arm|intel    Target architecture (macOS cross-compile)
  --pytest="args"     Pass arguments to pytest (can be repeated)
  --jest="args"       Pass arguments to Jest (can be repeated)
  --catch="args"      Pass arguments to Catch2 tests (aptest/engtest)
  --trace="a,b,c"     Enable trace output (passed to engine/tests)
  --testport=N        Use existing server on port N for tests (skip build/start)
  --log=FILE          Write output to FILE (grouped by module)
  --overlay-root=DIR  Set overlay root directory
  --version=VERSION   Set full build version x.x.x.x
  --hash=HASH         Set build hash
  --stamp=STAMP       Set build stamp
  --list-modules      List all registered modules
  --list-actions      List all registered actions (including internal)
  --list-deps         Show pipeline flow diagram for specified actions
  --help, -h          Show this help message

Examples:
  builder server:build             # Build server
  builder nodes:test               # Run node tests
  builder server:build nodes:build # Build server and nodes
  builder build -s                 # Build ALL sequentially (global command)
  builder clean                    # Clean ALL modules (global command)
`);
}

async function main() {
    const args = process.argv.slice(2);

    // Parse arguments early to check for --help
    const { requests: explicitRequests, options, globalCommands } = parseArgs(args);

    // Make sure the system is setup
    const { setupSystem } = require('./setup');
    await setupSystem(options);

    // =========================================================================
    // Install node deps so module tasks.js can be loaded
    // =========================================================================
    let Listr;
    try {
        Listr = require('listr2').Listr;
    } catch {
        console.log('Installing dependencies (fresh clone)...\n');
        try {
            const { execCommand } = require('./lib/exec');
            await execCommand('pnpm', ['install'], { cwd: ROOT, stdio: 'inherit' });
        } catch {
            process.exit(1);
        }
        Listr = require('listr2').Listr;
    }

    // Run deps check silently (only outputs if install needed)
    const { checkDependencies } = require('./deps-tasks');
    await checkDependencies();

    // Load rest of build system (depends on listr2 and node_modules)
    const registry = require('./lib/registry');
    const TaskRunner = require('./lib/runner');
    const { printFlowDiagram } = require('./lib/helpers');
    const { clearLog, writeLog, hasLogEntries } = require('./lib/log');

    logModule = { writeLog, hasLogEntries };
    process.on('SIGINT', () => handleTermination('SIGINT'));
    process.on('SIGTERM', () => handleTermination('SIGTERM'));

    // C++/VS setup (Windows) and C++ toolchain (Linux/Mac) run only when compiling the engine
    // (server:setup-tools in the server build path). Not needed if using a prebuilt engine.

    // Discover modules silently (they're listed in help screen)
    await registry.discover(ROOT);
    if (options.overlayRoot) {
        await registry.discover(options.overlayRoot);
    }

    if (registry.names().length === 0) {
        console.error('Error: No build modules found. Make sure tasks.js files exist.');
        process.exit(1);
    }

    // Expand global commands (e.g., "build" -> "build:server", "build:chat-ui", etc.)
    const expandedRequests = expandGlobalCommands(globalCommands, registry, options);
    const requests = [...explicitRequests, ...expandedRequests];

    // Handle --list-actions - show ALL registered actions across all modules
    if (options.listActions) {
        console.log('\nAll Registered Actions:\n');

        const allActions = registry.listActions(options);
        for (const action of allActions) {
            const desc = action.description ? ` - ${action.description}` : '';
            console.log(`  ${action.name}${desc}`);
        }
        console.log(`\nTotal: ${allActions.length} actions\n`);
        process.exit(0);
    }

    // Handle --list-modules - show all registered modules
    if (options.listModules) {
        console.log('\nRegistered Modules:\n');

        const modules = registry.names().sort();
        for (const name of modules) {
            const mod = registry.get(name);
            console.log(`  ${name.padEnd(20)} ${mod.description || ''}`);
        }
        console.log(`\nTotal: ${modules.length} modules\n`);
        process.exit(0);
    }

    // Show help if requested or no commands given
    if (options.help || requests.length === 0) {
        showHelp(registry, options);
        process.exit(options.help ? 0 : 1);
    }

    // Handle --list-deps
    if (options.listDeps) {
        console.log('\nPipeline Flow:\n');
        for (const { module, command } of requests) {
            if (!registry.has(module)) {
                console.log(`${command}`);
                console.log('─'.repeat(40));
                console.log(`  ✖ Unknown module: ${module}\n`);
                continue;
            }

            const actionDef = registry.getAction(command);

            console.log(`${command}`);
            console.log('─'.repeat(40));

            if (actionDef) {
                const actionObj = typeof actionDef.action === 'function'
                    ? actionDef.action(options)
                    : actionDef.action;
                if (actionObj?.steps) {
                    printFlowDiagram({ steps: actionObj.steps });
                } else {
                    console.log('  (leaf action - no sub-steps)\n');
                }
            } else {
                console.log(`  ✖ Unknown action: ${command}\n`);
            }
        }
        process.exit(0);
    }

    // Validate all requested actions exist
    for (const { module, command } of requests) {
        if (!registry.has(module)) {
            console.error(`Error: Unknown module '${module}'`);
            console.error(`Available modules: ${registry.names().join(', ')}`);
            process.exit(1);
        }

        const actionDef = registry.getAction(command);
        if (!actionDef) {
            console.error(`Error: Unknown action '${command}'`);
            const mod = registry.get(module);
            const availableActions = (mod.actions || [])
                .map(a => a.name)
                .filter(n => {
                    const def = registry.getAction(n);
                    const obj = typeof def?.action === 'function'
                        ? def.action(options)
                        : def?.action;
                    return obj?.description;
                });
            if (availableActions.length > 0) {
                console.error(`Available actions: ${availableActions.join(', ')}`);
            }
            process.exit(1);
        }
    }

    // Clear log buffer if logging enabled
    if (options.logFile) {
        clearLog();
    }

    // Run!
    try {
        const runner = new TaskRunner(options);
        await runner.run(requests);

        // Write log file if enabled and has entries
        if (options.logFile && hasLogEntries()) {
            await writeLog(options.logFile);
            console.log(`\n✔ Log written to ${options.logFile}`);
        }

        console.log('\n✔ Builder complete!');
        process.exit(0);
    } catch (err) {
        // Write log file even on failure
        if (options.logFile && hasLogEntries()) {
            await writeLog(options.logFile);
            console.log(`\nLog written to ${options.logFile}`);
        }

        console.error(`\n✖ Builder failed: ${err.message}`);
        if (options.verbose) {
            console.error(err.stack);
        }
        process.exit(1);
    }
}

main();

