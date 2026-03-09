# RocketRide Build System

A declarative, modular build system for the RocketRide Engine project.

## Primary Command: `builder build`

The recommended way to build the project is:

```bash
./builder build
```

This configures the environment, resolves dependencies, and builds all modules. Use `./builder build --sequential` if parallel builds cause resource issues.

---

## User Reference: Commands, Modules, and Output

### Per-module builds

```bash
# Windows
.\builder <module>:<command>

# macOS/Linux
./builder <module>:<command>
```

### Build commands

| Command | Description |
| ------- | ----------- |
| `<module>:build` | Full build with all dependencies |
| `<module>:compile` | Quick compile (skip setup if already done) |
| `<module>:clean` | Remove build artifacts |
| `<module>:test` | Run tests |

Not all modules support all commands. Run `./builder --help` for the full list.

### Modules reference

| Module | Description | Commands |
| ------ | ----------- | -------- |
| `ai` | AI/ML modules | build, clean, test |
| `chat-ui` | Chat web interface | build, clean, dev |
| `client-mcp` | MCP Protocol client | build, clean, test |
| `client-python` | Python SDK | build, clean, test |
| `client-typescript` | TypeScript/JavaScript SDK | build, clean, test |
| `console-chat` | Example chat application | build, clean |
| `dropper-ui` | File drop web interface | build, clean, dev |
| `java` | JDK, JRE, and Maven (auto-installed for Tika) | build, clean |
| `nodes` | Pipeline nodes | build, clean, test, test-contracts |
| `server` | C++ engine (downloads pre-built first, or compile from source) | build, compile, clean, test, build-all, clean-all, configure-cmake, package |
| `tika` | Java document parser | build, clean |
| `vcpkg` | C++ package manager (auto-installed for server build) | build, clean |
| `vscode` | VSCode extension | build, compile, clean |

### Examples

```bash
./builder build
./builder server:build
./builder client-typescript:build client-python:build client-mcp:build
./builder chat-ui:build dropper-ui:build
./builder vscode:build
./builder clean
./builder server:clean tika:clean
./builder --help
```

### Build output layout

| Directory | Contents |
| --------- | -------- |
| `build/` | Temporary build artifacts |
| `dist/` | Final distributable outputs |
| `dist/server/` | Engine executable and runtime |
| `dist/clients/` | Client library packages |
| `dist/vscode/` | VSCode extension (.vsix) |
| `dist/examples/` | Example applications |

---

## Table of Contents

- [Overview](#overview)
- [Why This Build System?](#why-this-build-system)
- [Quick Start](#quick-start)
- [Creating a tasks.js File](#creating-a-tasksjs-file)
- [Module Structure](#module-structure)
- [Actions](#actions)
  - [Leaf Actions](#leaf-actions)
  - [Compound Actions](#compound-actions)
  - [Public vs Internal Actions](#public-vs-internal-actions)
- [Action Properties](#action-properties)
- [Control Flow Helpers](#control-flow-helpers)
  - [parallel()](#parallel)
  - [sequence()](#sequence)
  - [bracket()](#bracket)
  - [when() / whenNot()](#when--whennot)
- [Understanding Deduplication](#understanding-deduplication)
- [Context and State](#context-and-state)
- [Available Utilities](#available-utilities)
- [Complete Example](#complete-example)
- [CLI Usage](#cli-usage)
- [Design Patterns](#design-patterns)
- [Best Practices](#best-practices)

---

## Overview

The build system uses **declarative task definitions** in JavaScript. Each package/module defines its build tasks in a `scripts/tasks.js` file, which is automatically discovered and registered.

Key features:

- **Auto-discovery**: `tasks.js` files are found in `packages/`, `apps/`, `nodes/`, and `examples/`
- **Parallel execution**: Tasks can run concurrently with automatic deduplication
- **Incremental builds**: Built-in source fingerprinting skips unchanged builds
- **Declarative flow**: Use `parallel()`, `sequence()`, `bracket()`, and `when()` to define complex workflows
- **Unified action model**: All tasks are "actions" -- public ones have descriptions, internal ones don't

---

## Why This Build System?

### The problem with traditional build scripts

Traditional build approaches have several pain points:

1. **Shell scripts are hard to maintain**: Complex builds end up with nested bash scripts that are difficult to debug, non-portable (Windows vs Unix), and have no dependency tracking.

2. **Makefiles don't handle cross-language builds well**: Our project has C++, Python, TypeScript, and Java. Make's file-based dependency model doesn't naturally handle "compile this C++ binary, then use it to run Python tests."

3. **Sequential builds are slow**: A full build takes 10+ minutes. Running everything sequentially when many tasks are independent wastes time.

4. **Knowing what to rebuild is hard**: Did the Python source change? The C++ code? Only the tests? Manually tracking this leads to either "rebuild everything" (slow) or "rebuild wrong things" (broken).

5. **Test infrastructure is fragile**: Tests need servers running. If tests fail, servers must still be stopped. Try-finally blocks everywhere, and forgotten cleanups leave zombie processes.

### What this system provides

| Problem | Solution |
| ------- | -------- |
| Cross-platform shell scripts | JavaScript with platform abstractions |
| No dependency tracking | Declarative steps with automatic deduplication |
| Sequential-only execution | `parallel()` for concurrent tasks |
| Manual rebuild decisions | Source fingerprinting for incremental builds |
| Fragile test cleanup | `bracket()` with guaranteed teardown |
| Complex conditional logic | `when()`/`whenNot()` for runtime decisions |
| Shared resource conflicts | Named locks prevent concurrent access |

### A real example

Consider running the TypeScript client tests. This requires:

1. Build the C++ server binary (or download pre-built)
2. Sync Python nodes to dist/
3. Sync AI modules to dist/
4. Build the Python client
5. Compile the TypeScript client
6. Start the test server
7. Run the tests
8. Stop the test server (even if tests fail)

Without this system, you'd need 100+ lines of bash with error handling. With it:

```javascript
{ name: 'client-typescript:test', action: () => ({
    description: 'Run unit tests',
    steps: [
        'server:build',
        parallel([
            'nodes:build',
            'ai:build',
            'client-python:build'
        ], 'Build modules'),
        'client-typescript:compile',
        bracket({
            name: 'ts-test-server',
            setup: makeStartTestServerAction(),
            teardown: makeStopTestServerAction(),
            steps: ['client-typescript:run-jest']
        })
    ]
})}
```

The system handles:

- Running builds in parallel where possible
- Skipping unchanged modules
- Deduplicating if `server:build` was already run
- Starting/stopping the server with guaranteed cleanup
- Failing fast if any step fails

---

## Quick Start

To add a new package to the build system:

1. Create `your-package/scripts/tasks.js`
2. Define your module with `name`, `description`, and `actions`
3. Run `builder your-package:build`

```javascript
// packages/my-package/scripts/tasks.js
const path = require('path');
const { syncDir, formatSyncStats, PROJECT_ROOT, DIST_ROOT } = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src');
const DIST_DIR = path.join(DIST_ROOT, 'my-package');

module.exports = {
    name: 'my-package',
    description: 'My Amazing Package',

    actions: [
        // Internal action (no description = not shown in help)
        { name: 'my-package:sync', action: () => ({
            run: async (ctx, task) => {
                task.output = 'Syncing files...';
                const stats = await syncDir(SRC_DIR, DIST_DIR);
                task.output = formatSyncStats(stats);
            }
        })},

        // Public action (has description = shown in help)
        { name: 'my-package:build', action: () => ({
            description: 'Build my package',
            steps: ['my-package:sync']
        })}
    ]
};
```

---

## Creating a tasks.js File

### File location

Place your `tasks.js` file at:

Directory Structure

```text
your-package/
├── scripts/
│   └── tasks.js    <- Build tasks go here
├── src/
│   └── ...
└── package.json
```

The build system searches these directories:

- `packages/*/scripts/tasks.js`
- `apps/*/scripts/tasks.js`
- `nodes/scripts/tasks.js`
- `examples/*/scripts/tasks.js`

### Required imports

```javascript
const path = require('path');
const {
    // File operations
    syncDir, formatSyncStats, removeDir, exists, mkdir, copyFile,

    // Execution
    execCommand,

    // State management
    getState, setState, withLock,

    // Fingerprinting (incremental builds)
    hasSourceChanged, saveSourceHash,

    // Control flow helpers
    parallel, sequence, bracket, when, whenNot,

    // Path constants
    PROJECT_ROOT, BUILD_DIR
} = require('../../../scripts/lib');
```

---

## Module Structure

```javascript
module.exports = {
    // REQUIRED: Unique module identifier (used in action names)
    name: 'my-package',

    // REQUIRED: Human-readable description (shown in --list-modules)
    description: 'My Package Description',

    // REQUIRED: Array of action definitions
    actions: [
        { name: 'my-package:action-name', action: actionFactory },
        // ... more actions
    ]
};
```

### Naming convention

- Module name: lowercase with hyphens (e.g., `client-python`, `model_server`)
- Action names: `module-name:action-name` (e.g., `client-python:build`, `server:compile`)

---

## Actions

Actions are the building blocks of the build system. There are two types:

### Leaf actions

Leaf actions perform actual work via a `run` function.

**Why use factory functions?**

Actions are defined as factories (`action: makeSyncAction` not `action: syncAction`) because:

1. **Lazy evaluation**: Action objects are only created when needed
2. **Fresh closures**: Each invocation gets a fresh context
3. **Parameterization**: Factories can accept options

```javascript
// Factory pattern (recommended)
function makeSyncAction(options = {}) {
    const { verbose = false } = options;
    return {
        run: async (ctx, task) => {
            if (verbose) task.output = 'Starting sync...';
            // ...
        }
    };
}

// Usage with options
{ name: 'pkg:sync', action: () => makeSyncAction({ verbose: true }) }

// Usage without options (function reference)
{ name: 'pkg:sync', action: makeSyncAction }
```

**Factory structure:**

```javascript
function makeSyncAction() {
    return {
        // Optional properties
        locks: ['resource-name'],  // Acquire named locks before running
        multi: false,              // If true, can run multiple times per session
        outputLines: 10,           // Max lines to show in task output

        // REQUIRED: The actual work
        run: async (ctx, task) => {
            task.output = 'Working...';
            // Do the work
            task.output = 'Done!';
        }
    };
}

// Register it
actions: [
    { name: 'my-package:sync', action: makeSyncAction }
]
```

### Compound actions

Compound actions orchestrate other actions via a `steps` array:

```javascript
{ name: 'my-package:build', action: () => ({
    description: 'Build the package',
    concurrent: false,  // Run steps sequentially (default)
    steps: [
        'my-package:clean',
        'my-package:compile',
        parallel([
            'my-package:copy-assets',
            'my-package:generate-types'
        ], 'Post-compile'),
        'my-package:bundle'
    ]
})}
```

### Public vs internal actions

**Why have both?**

- **Public actions** are the stable API for your package. `pkg:build`, `pkg:test`, `pkg:clean`. Users call these.
- **Internal actions** are implementation details. `pkg:sync-files`, `pkg:compile-step-2`. These can change without breaking users.

The **only difference** is the `description` property:

| Property | Public Action | Internal Action |
| -------- | ------------- | --------------- |
| `description` | Has description | No description |
| Shown in `builder --help` | Yes | No |
| Can be run via CLI | Yes | Yes |

```javascript
actions: [
    // Internal: No description -- not shown in help
    // Users CAN run this, but shouldn't need to
    { name: 'pkg:sync', action: () => ({
        run: async (ctx, task) => { /* ... */ }
    })},

    // Public: Has description -- shown in help
    // Users SHOULD run this - it's the stable interface
    { name: 'pkg:build', action: () => ({
        description: 'Build the package',  // <- This makes it public
        steps: ['pkg:sync']
    })}
]
```

**Guideline:** If you're not sure, make it internal. You can always add a description later to promote it to public.

---

## Action Properties

### For leaf actions (with `run`)

| Property | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `run` | `async (ctx, task) => {}` | required | The work function |
| `locks` | `string[]` | `[]` | Named locks to acquire before running |
| `multi` | `boolean` | `false` | If true, action can run multiple times per session |
| `outputLines` | `number` | `10` | Max lines to show in task output |

### For compound actions (with `steps`)

| Property | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `description` | `string` | - | Makes action public (shown in help) |
| `steps` | `array` | required | Array of step definitions |
| `concurrent` | `boolean` | `false` | Run steps in parallel |
| `locks` | `string[]` | `[]` | Named locks to acquire before running |

### The `run` function

```javascript
run: async (ctx, task, options) => {
    // ctx: Shared context object (persists across all actions)
    // task: Listr2 task object for output
    // options: { logModule: 'module:action' } for logging

    // Update task output (shown in terminal)
    task.output = 'Doing something...';

    // Access shared context
    const serverPort = ctx.port;

    // Store data for later actions
    ctx.myData = { foo: 'bar' };

    // Return value is ignored (unless in a bracket setup)
}
```

---

## Control Flow Helpers

Import from `scripts/lib`:

```javascript
const { parallel, sequence, bracket, when, whenNot } = require('../../../scripts/lib');
```

### parallel()

**Why use parallel?**

Build systems often have tasks that don't depend on each other. Running them sequentially wastes time:

```text
Sequential (slow):
  nodes:sync ----------------> ai:sync ----------------> client-python:sync-source
  [2 seconds]                [2 seconds]           [1 second]
  Total: 5 seconds

Parallel (fast):
  +-- nodes:sync -----------+
  +-- ai:sync --------------+-> Done
  +-- client-python:sync-source --+
  Total: 2 seconds (limited by slowest)
```

**When to use parallel:**

- Tasks that read from different sources and write to different destinations
- Independent compilation steps (compile TypeScript while syncing Python)
- Downloading multiple files simultaneously
- Running independent test suites

**When NOT to use parallel:**

- Tasks that depend on each other (compile -> bundle)
- Tasks that use the same external resource (two cmake builds)
- Tasks where order matters (clean -> build)

**Syntax:**

```javascript
steps: [
    'action:first',
    parallel([
        'action:a',
        'action:b',
        'action:c'
    ], 'Run A, B, C in parallel'),
    'action:last'  // Waits for all parallel tasks to complete
]
```

The second argument is a title shown in the output. Nested parallels are automatically flattened into one group.

### sequence()

**Why use sequence?**

Sometimes you need sequential execution *inside* a parallel block. Consider:

```javascript
// We want to run these two pipelines in parallel:
// Pipeline 1: vcpkg:clone -> vcpkg:bootstrap  (must be sequential)
// Pipeline 2: java:download-jdk, java:download-maven  (can be parallel)

parallel([
    sequence(['vcpkg:clone', 'vcpkg:bootstrap'], 'vcpkg setup'),
    parallel(['java:download-jdk', 'java:download-maven'], 'java downloads')
], 'Setup dependencies')
```

This runs both pipelines concurrently, but within the vcpkg pipeline, clone must finish before bootstrap starts.

**When to use sequence:**

- A mini-pipeline that must run steps in order
- When the outer context is parallel but you need some ordering
- To group related sequential steps with a descriptive title

**Syntax:**

```javascript
steps: [
    parallel([
        'fast:action',
        sequence([
            'slow:setup',
            'slow:run',
            'slow:cleanup'
        ], 'Sequential pipeline')
    ], 'Mixed execution')
]
```

### bracket()

**Why use bracket?**

Testing often requires infrastructure that must be:

1. **Started** before tests run
2. **Stopped** after tests complete
3. **Always cleaned up**, even when tests fail

Without brackets, you'd write:

```javascript
// [BAD] Fragile -- if tests fail, server keeps running
run: async (ctx, task) => {
    await startServer();
    await runTests();      // If this throws, stopServer never runs!
    await stopServer();
}

// [BETTER] But verbose
run: async (ctx, task) => {
    await startServer();
    try {
        await runTests();
    } finally {
        await stopServer();  // Always runs, but code is getting messy
    }
}
```

With brackets, cleanup is **guaranteed**:

```javascript
// [GOOD] Clean, declarative, guaranteed cleanup
bracket({
    name: 'test-server',
    setup: makeStartServerAction(),
    teardown: makeStopServerAction(),  // ALWAYS runs
    steps: ['run:tests']
})
```

**Real-world uses:**

- **Test servers**: Start a server, run tests, stop server
- **Docker containers**: Start container, run commands, remove container
- **Temporary directories**: Create temp dir, use it, delete it
- **Database transactions**: Begin transaction, do work, commit/rollback
- **Lock files**: Create lock, do work, remove lock

**How data flows in a bracket:**

```javascript
bracket({
    name: 'my-server',
    setup: {
        run: async (ctx, task) => {
            const server = await startServer();
            // Return value is stored in ctx.brackets['my-server']
            return { port: server.port, server: server };
        }
    },
    teardown: {
        run: async (ctx, task) => {
            // Access setup's return value
            const info = ctx.brackets['my-server'];
            if (info?.server) {
                await info.server.stop();
            }
        }
    },
    steps: [
        'run:tests'  // Tests can read ctx.brackets['my-server'].port
    ]
})
```

**Key guarantees:**

- `teardown` **always runs** (even if setup succeeds but steps fail)
- Setup return value is accessible to both steps AND teardown via `ctx.brackets[name]`
- If setup fails, teardown is skipped (nothing to clean up)

### when() / whenNot()

**Why use conditional execution?**

Sometimes build steps depend on runtime decisions:

1. **Did a download succeed?** Skip compilation if we got a pre-built binary
2. **Is this a CI environment?** Skip interactive prompts
3. **Was --skip-tests passed?** Don't run the test suite
4. **Did previous step set a flag?** Take different paths

Without conditionals, you'd check conditions inside actions:

```javascript
// [BAD] Scattered conditionals, unclear flow
'server:maybe-compile': {
    run: async (ctx, task) => {
        if (ctx.downloaded) {
            task.skip('Using pre-built');
            return;
        }
        // ... 50 lines of compile logic ...
    }
}
```

With `when`/`whenNot`, the flow is declarative:

```javascript
// [GOOD] Clear conditional flow
steps: [
    'server:try-download',
    whenNot({
        name: 'downloaded',
        condition: (ctx) => ctx.downloaded,
        then: [
            // Only runs if download failed
            'server:configure',
            'server:compile'
        ]
    })
]
```

**when vs whenNot:**

- `when()` -- Run `then` steps when condition is **true**
- `whenNot()` -- Run `then` steps when condition is **false** (more readable for "unless" logic)

**Common patterns:**

```javascript
// Pattern 1: Fallback compilation
steps: [
    'server:download',  // Sets ctx.downloaded = true/false
    whenNot({
        name: 'downloaded',
        condition: (ctx) => ctx.downloaded,
        then: ['server:compile-from-source']
    })
]

// Pattern 2: CI-specific behavior
steps: [
    when({
        name: 'is-ci',
        condition: (ctx) => process.env.CI,
        then: ['tests:run-headless'],
        else: ['tests:run-with-ui']
    })
]

// Pattern 3: Feature flags
steps: [
    when({
        name: 'with-cuda',
        condition: (ctx) => ctx.options?.cuda,
        then: ['build:cuda-modules']
    })
]
```

**Important:** Conditions are evaluated at **runtime**, not when the task tree is built. This means:

```javascript
// This works -- ctx.downloaded is set by a previous step
steps: [
    'server:try-download',   // Sets ctx.downloaded
    whenNot({
        condition: (ctx) => ctx.downloaded,  // Evaluated AFTER try-download runs
        ...
    })
]
```

---

## Understanding Deduplication

**Why does deduplication matter?**

In a complex build, the same action often appears multiple times in the dependency graph:

```text
client-typescript:test
+-- server:build
|   +-- nodes:build
+-- client-python:build
|   +-- nodes:build      <- Same as above!
+-- nodes:build          <- Same as above!
```

Without deduplication, `nodes:build` would run 3 times. With deduplication, it runs once.

**How it works:**

1. The first time an action runs in a session, it completes normally
2. Subsequent requests to run the same action are skipped
3. The action is tracked by its full name (e.g., `nodes:build`)

**When deduplication helps:**

```javascript
// Multiple modules depend on nodes:build
parallel([
    'ai:build',           // Internally calls nodes:build
    'client-python:build', // Internally calls nodes:build
    'client-typescript:build' // Internally calls nodes:build
])
// nodes:build runs ONCE, all three modules benefit
```

**When to disable deduplication:**

Some actions should run multiple times per session:

```javascript
// Development server should restart each time it's called
{ name: 'dev:start', action: () => ({
    multi: true,  // <- Disables deduplication
    run: async (ctx, task) => {
        await startDevServer();
    }
})}
```

**Use `multi: true` for:**

- Development servers that should restart on demand
- Logging/status actions that print current state
- Actions that should respond to changed inputs mid-session
- "Watch" commands that run continuously

**The interaction with parallel execution:**

Deduplication + parallel creates interesting behavior:

```javascript
parallel([
    'a:build',  // depends on shared:build
    'b:build',  // depends on shared:build
])
```

If both `a:build` and `b:build` have `shared:build` in their steps, one of them will run `shared:build` and the other will skip it (seeing it's already complete). The system ensures no race conditions.

---

## Context and State

There are two types of state in the build system, for different purposes:

| Type | Lifetime | Use Case |
| ---- | -------- | -------- |
| Runtime Context (`ctx`) | Single build session | Passing data between actions |
| Persistent State | Across sessions | Remembering what was built |

### Runtime context (`ctx`)

**Why use context?**

Actions need to share data. Without shared context, you'd resort to:

- Global variables (brittle, hard to test)
- File-based communication (slow, race conditions)
- Environment variables (limited, no structured data)

Context is the clean solution:

```javascript
run: async (ctx, task) => {
    // Read from context (set by previous action)
    const port = ctx.port || 8080;

    // Write to context (visible to subsequent actions)
    ctx.buildOutput = '/path/to/output';

    // Access CLI options (always available)
    const force = ctx.options?.force;
    const pytestArgs = ctx.options?.pytest;

    // Bracket data (set by bracket setup)
    const serverInfo = ctx.brackets?.['my-server'];
}
```

**Context rules:**

- Created fresh for each `builder` invocation
- Shared across ALL actions in that invocation
- Supports any JavaScript value (objects, arrays, functions)
- Parallel actions can READ the same keys safely
- Parallel actions should NOT WRITE the same keys (race condition)

### Persistent state

**Why use persistent state?**

Some information should survive across build sessions:

- Source hashes (for incremental builds)
- Configuration flags (was vcpkg bootstrapped?)
- Timestamps (when was this last built?)

State persists in `build/state.json`:

```javascript
const { getState, setState, updateState } = require('../../../scripts/lib');

run: async (ctx, task) => {
    // Read state (dot notation supports nesting)
    const version = await getState('my-package.version');
    const configured = await getState('my-package.configured');

    // Write state
    await setState('my-package.version', '1.0.0');
    await setState('my-package.configured', true);

    // Update multiple keys atomically (avoids partial writes)
    await updateState({
        'my-package.built': true,
        'my-package.builtAt': new Date().toISOString()
    });
}
```

**State vs Context -- when to use which:**

| Scenario | Use |
| -------- | --- |
| Pass server port from setup to tests | Context (`ctx.port`) |
| Remember if source was already compiled | State (`setState('pkg.compiled', true)`) |
| Share computed version number | Context (`ctx.version`) |
| Store source hash for incremental builds | State (via `saveSourceHash()`) |
| Pass CLI options to actions | Context (`ctx.options`) |
| Track last successful build time | State |

---

## Available Utilities

### File operations

```javascript
const {
    // Check existence
    exists,           // async (path) => boolean
    isFile,           // async (path) => boolean
    isDirectory,      // async (path) => boolean

    // Read
    readFile,         // async (path) => string
    readJson,         // async (path) => object
    readDir,          // async (path, opts) => string[]

    // Write
    writeFile,        // async (path, content) => void
    writeJson,        // async (path, obj) => void
    mkdir,            // async (path) => void (recursive)
    copyFile,         // async (src, dest) => void
    copyDir,          // async (src, dest) => void

    // Delete
    removeDir,        // async (path) => void
    removeFile,       // async (path) => void
    removeDirs,       // async (paths[]) => void

    // Sync directories
    syncDir,          // async (src, dest, opts) => stats
    overlayDir,       // async (src, dest, opts) => stats
    formatSyncStats,  // (stats) => string
} = require('../../../scripts/lib');
```

### Incremental builds

```javascript
const { hasSourceChanged, saveSourceHash } = require('../../../scripts/lib');

const SRC_HASH_KEY = 'my-package.srcHash';

run: async (ctx, task) => {
    // Check if source changed since last build
    const { changed, hash } = await hasSourceChanged(SRC_DIR, SRC_HASH_KEY);

    if (!changed && await exists(OUTPUT_DIR)) {
        task.output = 'No changes detected';
        return;
    }

    // Do the build...
    await doBuild();

    // Save hash after successful build
    await saveSourceHash(SRC_HASH_KEY, hash);
}
```

### Command execution

```javascript
const { execCommand } = require('../../../scripts/lib');

run: async (ctx, task) => {
    // Basic usage
    await execCommand('npm', ['install'], { task, cwd: PACKAGE_DIR });

    // With environment variables
    await execCommand('python', ['-m', 'pytest'], {
        task,
        cwd: PACKAGE_DIR,
        env: {
            ...process.env,
            PYTHONPATH: '/custom/path'
        }
    });

    // Collect output
    const result = await execCommand('git', ['rev-parse', 'HEAD'], {
        task,
        collect: true  // Returns output string
    });
}
```

### Locks

```javascript
const { withLock } = require('../../../scripts/lib');

run: async (ctx, task) => {
    // Exclusive access to a resource
    await withLock('cmake', async () => {
        await execCommand('cmake', ['--build', '.'], { task });
    });
}
```

Or use the `locks` property in action definition:

```javascript
{ name: 'server:compile', action: () => ({
    locks: ['cmake'],  // Auto-acquired before run, released after
    run: async (ctx, task) => {
        await execCommand('cmake', ['--build', '.'], { task });
    }
})}
```

### Downloads

```javascript
const { downloadFile, extractArchive } = require('../../../scripts/lib');

run: async (ctx, task) => {
    const archivePath = await downloadFile(
        'https://example.com/file.tar.gz',
        'file.tar.gz',
        task  // For progress output
    );

    await extractArchive(archivePath, DEST_DIR, {
        stripLevels: 1  // Remove top-level directory
    });
}
```

### Platform detection

```javascript
const { isWindows, isMac, isLinux, getPlatform } = require('../../../scripts/lib');

run: async (ctx, task) => {
    if (isWindows()) {
        await execCommand('build.cmd', [], { task });
    } else {
        await execCommand('bash', ['build.sh'], { task });
    }

    const { os, arch, ext } = getPlatform();
    // os: 'windows' | 'darwin' | 'linux'
    // arch: 'x64' | 'arm64'
    // ext: 'zip' | 'tar.gz'
}
```

### Path constants

```javascript
const { PROJECT_ROOT, BUILD_ROOT } = require('../../../scripts/lib');

// PROJECT_ROOT: Root of the monorepo
// BUILD_ROOT: {PROJECT_ROOT}/build by default, can be overlayed
```

---

## Complete Example

Here's a complete `tasks.js` for a Python package:

```javascript
/**
 * Build tasks for @rocketride/my-python-package
 */
const path = require('path');
const {
    syncDir, formatSyncStats, removeDirs, removeMatching,
    execCommand, exists, mkdir,
    hasSourceChanged, saveSourceHash,
    PROJECT_ROOT, BUILD_ROOT, DIST_ROOT, parallel, bracket
} = require('../../../scripts/lib');

// Paths
const PACKAGE_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src');
const DIST_DIR = path.join(DIST_ROOT, 'my-package');
const BUILD_DIR = path.join(BUILD_ROOT, 'my-package');

// State key for incremental builds
const SRC_HASH_KEY = 'my-package.srcHash';

// ============================================================================
// Internal Action Factories (no description = not shown in help)
// ============================================================================

function makeSyncAction() {
    return {
        run: async (ctx, task) => {
            task.output = 'Scanning for changes...';
            const stats = await syncDir(SRC_DIR, DIST_DIR);
            task.output = formatSyncStats(stats);
        }
    };
}

function makeCompileAction() {
    return {
        run: async (ctx, task) => {
            const { changed, hash } = await hasSourceChanged(SRC_DIR, SRC_HASH_KEY);

            if (!changed && await exists(BUILD_DIR)) {
                task.output = 'No changes detected';
                return;
            }

            await mkdir(BUILD_DIR);
            await execCommand('python', ['-m', 'build', '--outdir', BUILD_DIR], {
                task,
                cwd: PACKAGE_DIR
            });

            await saveSourceHash(SRC_HASH_KEY, hash);
        }
    };
}

function makeStartServerAction() {
    return {
        run: async (ctx, task) => {
            task.output = 'Starting test server...';
            // Start server logic...
            ctx.port = 8080;
            return { port: ctx.port };
        }
    };
}

function makeStopServerAction() {
    return {
        run: async (ctx, task) => {
            task.output = 'Stopping server...';
            // Stop server logic...
        }
    };
}

function makeRunTestsAction() {
    return {
        run: async (ctx, task) => {
            const port = ctx.brackets?.['test-server']?.port || ctx.port;

            await execCommand('python', ['-m', 'pytest', '-v'], {
                task,
                cwd: PACKAGE_DIR,
                env: {
                    ...process.env,
                    TEST_PORT: String(port)
                }
            });
        }
    };
}

function makeCleanAction() {
    return {
        run: async (ctx, task) => {
            await removeDirs([BUILD_DIR, DIST_DIR]);
            await removeMatching(PACKAGE_DIR, '.egg-info');
            task.output = 'Cleaned';
        }
    };
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
    name: 'my-package',
    description: 'My Python Package',

    actions: [
        // Internal actions (no description)
        { name: 'my-package:sync', action: makeSyncAction },
        { name: 'my-package:compile', action: makeCompileAction },
        { name: 'my-package:start-server', action: makeStartServerAction },
        { name: 'my-package:stop-server', action: makeStopServerAction },
        { name: 'my-package:run-tests', action: makeRunTestsAction },

        // Public actions (have descriptions)
        { name: 'my-package:build', action: () => ({
            description: 'Build the package',
            steps: [
                'my-package:sync',
                'my-package:compile'
            ]
        })},

        { name: 'my-package:test', action: () => ({
            description: 'Run tests (starts server automatically)',
            steps: [
                'my-package:build',
                bracket({
                    name: 'test-server',
                    setup: makeStartServerAction(),
                    teardown: makeStopServerAction(),
                    steps: ['my-package:run-tests']
                })
            ]
        })},

        { name: 'my-package:clean', action: () => ({
            description: 'Remove build artifacts',
            run: async (ctx, task) => {
                await removeDirs([BUILD_DIR, DIST_DIR]);
                await removeMatching(PACKAGE_DIR, '.egg-info');
                task.output = 'Cleaned';
            }
        })}
    ]
};
```

---

## CLI Usage

```bash
# Run a single action
builder my-package:build

# Run multiple actions
builder server:build nodes:build ai:build

# Run all builds (global command)
builder build

# Run with options
builder my-package:test --force           # Force rebuild (ignore cache/state)
builder my-package:test --verbose         # Detailed output
builder my-package:test --pytest="-s -v"  # Pass pytest args
builder build --sequential               # Run modules sequentially
builder build --autoinstall              # Install missing tools automatically
builder build --arch=arm                 # Target architecture (macOS cross-compile)

# Show help
builder --help

# List all actions (including internal)
builder --list-actions

# Show dependency diagram for an action
builder my-package:test --list-deps
```

---

## Design Patterns

This section covers common patterns and **when** to use them based on the problem you're solving.

### Pattern: download or compile

**Problem:** A binary can be downloaded pre-built OR compiled from source. Don't waste time compiling if a download is available.

**Solution:** Use `when`/`whenNot` to conditionally compile:

```javascript
{ name: 'server:build', action: () => ({
    description: 'Build or download server',
    steps: [
        'server:check-prebuilt',  // Sets ctx.hasPrebuilt = true/false
        when({
            name: 'has-prebuilt',
            condition: (ctx) => ctx.hasPrebuilt,
            then: ['server:download-prebuilt'],
            else: ['server:compile-from-source']
        })
    ]
})}
```

**Why this works:** The decision happens at runtime. If CI caches exist, download; if not, compile. The consumer just calls `server:build` without knowing how.

### Pattern: build dependencies once

**Problem:** Multiple packages depend on `nodes:build`. Running the full build triggers it redundantly.

**Solution:** Let deduplication handle it. Just call the dependency:

```javascript
// ai:build
{ name: 'ai:build', action: () => ({
    description: 'Build AI modules',
    steps: [
        'nodes:build',  // Runs once, even if others request it too
        'ai:sync'
    ]
})}

// client-python:build
{ name: 'client-python:build', action: () => ({
    description: 'Build Python client',
    steps: [
        'nodes:build',  // Skipped if already run
        'client-python:sync-source'
    ]
})}
```

**Why this works:** Running `builder ai:build client-python:build` only runs `nodes:build` once, even though both request it.

### Pattern: integration tests with server

**Problem:** Tests need a running server. Server must stop even if tests fail.

**Solution:** Use `bracket()`:

```javascript
{ name: 'pkg:test', action: () => ({
    description: 'Run integration tests',
    steps: [
        'pkg:build',
        bracket({
            name: 'test-server',
            setup: {
                run: async (ctx, task) => {
                    const server = await startServer();
                    return { port: server.port, shutdown: server.shutdown };
                }
            },
            teardown: {
                run: async (ctx, task) => {
                    const info = ctx.brackets['test-server'];
                    await info?.shutdown();
                }
            },
            steps: ['pkg:run-tests']
        })
    ]
})}
```

**Why brackets not try/finally:** Brackets are declarative. The build system manages the flow. You can nest brackets, combine with parallel, and still get guaranteed cleanup.

### Pattern: parallel independent modules

**Problem:** Building `ai`, `nodes`, and `client-python` takes 6 seconds sequentially when they could run in 2 seconds parallel.

**Solution:** Use `parallel()` when tasks don't depend on each other:

```javascript
{ name: 'server:build-all', action: () => ({
    description: 'Build server with modules',
    steps: [
        'server:build',  // Must complete first (others depend on it)
        parallel([
            'nodes:build',
            'ai:build',
            'client-python:build'
        ], 'Build modules')  // These 3 are independent
    ]
})}
```

**Why parallel helps:** If `nodes:build` takes 2s, `ai:build` takes 3s, and `client-python:build` takes 1s:

- Sequential: 2 + 3 + 1 = 6 seconds
- Parallel: max(2, 3, 1) = 3 seconds

### Pattern: sequential dependencies inside parallel

**Problem:** You want parallel execution overall, but some tasks have internal dependencies.

**Solution:** Combine `parallel()` and `sequence()`:

```javascript
{ name: 'setup:all', action: () => ({
    description: 'Set up all dependencies',
    steps: [
        parallel([
            sequence([
                'vcpkg:clone',     // Must finish before bootstrap
                'vcpkg:bootstrap'
            ], 'vcpkg'),
            sequence([
                'java:download-jdk',  // Must finish before setup
                'java:setup-paths'
            ], 'java'),
            'download:models'  // Independent, no sequence needed
        ], 'Parallel setup')
    ]
})}
```

**Why this works:** The outer parallel runs three tracks concurrently. Each `sequence` track runs its steps in order. `download:models` runs alongside the sequences.

### Pattern: exclusive resource access

**Problem:** Two tasks both call `cmake`, but CMake locks its build directory. Running them in parallel causes errors.

**Solution:** Use locks:

```javascript
{ name: 'server:compile', action: () => ({
    locks: ['cmake'],  // Acquire lock before running
    run: async (ctx, task) => {
        await execCommand('cmake', ['--build', 'server'], { task });
    }
})}

{ name: 'tests:compile', action: () => ({
    locks: ['cmake'],  // Same lock -- waits for server:compile to release
    run: async (ctx, task) => {
        await execCommand('cmake', ['--build', 'tests'], { task });
    }
})}
```

**When to use locks:**

- Build tools that lock directories (cmake, gradle)
- Downloading to the same cache directory
- Modifying shared configuration files
- Any resource that doesn't support concurrent access

**How it works:** If `server:compile` is running, `tests:compile` waits at "Acquiring lock" until `server:compile` releases. The lock is automatic -- acquired before `run()`, released after (even on error).

### Pattern: incremental builds

**Problem:** A full build takes anywhere from 10 minutes to 2 or 3 hours. But usually only a few files changed.

**Solution:** Use source fingerprinting:

```javascript
function makeBuildAction() {
    return {
        run: async (ctx, task) => {
            // 1. Check if source changed since last successful build
            const { changed, hash } = await hasSourceChanged(SRC_DIR, 'pkg.srcHash');

            // 2. Skip if nothing changed AND output exists
            if (!changed && await exists(OUTPUT_DIR)) {
                task.output = 'Up to date (no changes)';
                return;
            }

            // 3. Do the actual build
            task.output = 'Building...';
            await build();

            // 4. Save hash AFTER successful build
            await saveSourceHash('pkg.srcHash', hash);
            task.output = 'Build complete';
        }
    };
}
```

**Why save hash after?** If the build fails, the hash isn't saved. Next run will still see "changed" and retry.

**What gets hashed?**

- File timestamps and size
- File paths relative to the directory
- Recursively through all files

### Pattern: global commands with :build convention

**Problem:** You want a single `builder build` command that builds everything, but each package owns its own `:build` action.

**Solution:** Use the naming convention. Any action named `*:build` is included in global `builder build`:

```javascript
// server/scripts/tasks.js
{ name: 'server:build', action: () => ({
    description: 'Build server',
    // ...
})}

// nodes/scripts/tasks.js
{ name: 'nodes:build', action: () => ({
    description: 'Build nodes',
    // ...
})}
```

Now `builder build` runs all `*:build` actions. Same for `builder test` (runs all `*:test` actions).

### Pattern: passing options to actions

**Problem:** Tests should accept pytest arguments like `-s -v` from the command line.

**Solution:** Use `ctx.options`:

```javascript
// In action:
run: async (ctx, task) => {
    const pytestArgs = ctx.options?.pytest?.split(' ') || [];
    await execCommand('python', ['-m', 'pytest', ...pytestArgs], { task });
}
```

```bash
# From CLI:
builder tests:pytest --pytest="-s -v -k test_login"
```

**Available options:**

- `ctx.options.force` -- `--force` flag was passed
- `ctx.options.verbose` -- `--verbose` flag was passed
- `ctx.options.<name>` -- custom `--<name>=value` arguments

### Pattern: sharing data between actions

**Problem:** Action A computes something that Action B needs.

**Solution:** Use the shared context `ctx`:

```javascript
// Action A - writes to context
{ name: 'pkg:discover-version', action: () => ({
    run: async (ctx, task) => {
        ctx.version = await detectVersion();  // Write to ctx
    }
})}

// Action B - reads from context
{ name: 'pkg:tag-release', action: () => ({
    run: async (ctx, task) => {
        const version = ctx.version;  // Read from ctx
        await gitTag(`v${version}`);
    }
})}

// Composed action ensures order
{ name: 'pkg:release', action: () => ({
    description: 'Create release',
    steps: [
        'pkg:discover-version',  // Runs first, sets ctx.version
        'pkg:tag-release'        // Runs second, reads ctx.version
    ]
})}
```

**Context rules:**

- Context lives for one build session (one `builder` invocation)
- Sequential steps can reliably share data
- Parallel steps should NOT write to the same keys (race condition)

---

## Best Practices

### 1. Use incremental builds

**Why?** A full Python sync takes 2 seconds. Checking hashes takes 50ms. If nothing changed, you save 1.95 seconds -- multiplied across 10 modules, that's 20 seconds saved on every build.

```javascript
const { changed, hash } = await hasSourceChanged(SRC_DIR, HASH_KEY);
if (!changed && await exists(OUTPUT_DIR)) {
    task.output = 'No changes detected';
    return;
}
// ... build ...
await saveSourceHash(HASH_KEY, hash);
```

**When NOT to use:**

- `--force` flag should bypass (check `ctx.options?.force`)
- Clean builds should always rebuild
- External dependencies might have changed (network resources, system libraries)

### 2. Keep internal actions simple

**Why?** Single-responsibility actions provide:

- **Reusability**: `pkg:compile` can be used by both `pkg:build` and `pkg:dev` without duplication
- **Parallelism**: You can't run half of a monolithic function in parallel
- **Debuggability**: When `pkg:compile` fails, you know exactly what failed
- **Incremental execution**: Each action can check its own "up to date" status

```javascript
// [BAD] Monolithic action
{ name: 'pkg:build', action: () => ({
    description: 'Build everything',
    run: async (ctx, task) => {
        await clean();    // Can't skip if already clean
        await compile();  // Can't run while bundling
        await bundle();   // Can't parallelize
        await copyAssets();
    }
})}

// [GOOD] Composed actions
{ name: 'pkg:clean', action: makeCleanAction },
{ name: 'pkg:compile', action: makeCompileAction },
{ name: 'pkg:bundle', action: makeBundleAction },
{ name: 'pkg:copy-assets', action: makeCopyAssetsAction },

{ name: 'pkg:build', action: () => ({
    description: 'Build everything',
    steps: [
        'pkg:clean',
        'pkg:compile',
        parallel(['pkg:bundle', 'pkg:copy-assets'], 'Finalize')  // Runs in parallel!
    ]
})}
```

**Rule of thumb:** If you're putting `await` on multiple unrelated operations in one action, split them.

### 3. Use consistent naming

**Why?** Consistent naming enables:

- **Global commands**: `builder build` finds all `*:build` actions automatically
- **Discoverability**: Developers know to look for `pkg:build` without reading docs
- **Tab completion**: Predictable names work better with shell completion

```javascript
// Standard action names:
'pkg:build'      // Main build action (public) - always create this one
'pkg:test'       // Run tests (public) - enables `builder test`
'pkg:clean'      // Remove artifacts (public) - for clean builds
'pkg:sync'       // Sync files (internal) - copy source to dist/
'pkg:compile'    // Compile source (internal) - run compiler
'pkg:bundle'     // Create bundle (internal) - package output
```

### 4. Always clean up with brackets

**Why?** Try/finally blocks don't compose. What if you need to start two servers? Nest try/finally? With brackets, you nest naturally:

```javascript
// [BAD] Try/finally nesting gets ugly fast
try {
    await startServerA();
    try {
        await startServerB();
        await runTests();  // What if this throws? Two finally blocks needed
    } finally {
        await stopServerB();
    }
} finally {
    await stopServerA();
}

// [GOOD] Brackets compose cleanly
steps: [
    bracket({
        name: 'server-a',
        setup: startServerAAction,
        teardown: stopServerAAction,
        steps: [
            bracket({
                name: 'server-b',
                setup: startServerBAction,
                teardown: stopServerBAction,
                steps: ['run:tests']
            })
        ]
    })
]
```

Teardowns run in reverse order: server-b stops, then server-a stops -- even if tests fail.

### 5. Export path constants

**Why?** Other modules may need your paths. Without exports, they'd duplicate the path logic:

```javascript
// [BAD] Another module guessing your paths
const NODES_DIST = path.join(DIST_ROOT, 'nodes');

// [GOOD] Import from the source of truth
const { DIST_DIR: NODES_DIST } = require('../nodes/scripts/tasks');
```

```javascript
module.exports = {
    name: 'my-package',
    // ...
};

// Export paths for external use
module.exports.SRC_DIR = SRC_DIR;
module.exports.DIST_DIR = DIST_DIR;
```

**Common exports:** `SRC_DIR`, `DIST_DIR`, `BUILD_DIR`, `CONFIG_PATH`

### 6. Use locks for shared resources

**Why?** Parallel execution can cause conflicts:

```text
Without locks (broken):
  server:compile --- cmake --build server ----+
  tests:compile ---- cmake --build tests -----+-- CRASH! CMake locked
                                              |
With locks (correct):
  server:compile --- [lock cmake] --- build --- [unlock] --+
  tests:compile ---- [waiting...] --------------------------+-- [lock cmake] --- build
```

```javascript
// When multiple actions might access the same resource:
{ name: 'server:compile', action: () => ({
    locks: ['cmake'],  // Only one cmake at a time
    run: async (ctx, task) => {
        await execCommand('cmake', ['--build', '.'], { task });
    }
})}
```

**Lock names are strings:** Any action with `locks: ['cmake']` shares that lock. Use descriptive names: `'cmake'`, `'pip-install'`, `'npm-cache'`.

---

## Troubleshooting

### Action not found

```text
Error: Unknown action 'my-package:build'
```

**Why it happens:**

- The `tasks.js` file isn't where the system expects it
- The action name doesn't match the module name prefix

**Fixes:**

- Check that `tasks.js` is in `scripts/` subdirectory
- Verify `module.exports.name` matches the action prefix (e.g., name `my-package` -> actions must start with `my-package:`)
- Run `builder --list-actions` to see what actions ARE registered

### Task skipped unexpectedly

**Why it happens:** Deduplication. The action already ran earlier in the session.

**How to tell:** The output shows the task completing instantly, or `builder --verbose` shows "already completed".

**Fixes:**

- If the action should run once per session: this is correct behavior
- If the action should run every time it's requested:

```javascript
{ name: 'pkg:dev-server', action: () => ({
    multi: true,  // Disables deduplication
    run: async (ctx, task) => { /* ... */ }
})}
```

### Parallel tasks failing together

**Why it happens:** Fail-fast behavior. When one task in a `parallel()` block fails, others are cancelled.

**Why this is intentional:** If `compile` fails, there's no point continuing `bundle` and `test`. Cancelling saves time and avoids confusing cascading errors.

**If you need independent failures:** Wrap each task in its own error handling (not recommended -- usually you want fail-fast).

### State not persisting

**Why it happens:** State is stored in `build/state.json`. If deleted, all incremental build data is lost.

**Symptoms:** Builds that should be "up to date" run from scratch.

**Fixes:**

- Check if `build/state.json` exists and is valid JSON
- Use `--force` to bypass cached state and rebuild everything
- If state is corrupted, delete `build/state.json` and rebuild

### Build hangs waiting for lock

**Why it happens:** Another task has a lock and is taking a long time (or crashed without releasing).

**Fixes:**

- Check if another builder process is running
- Kill stuck processes

### Changes not detected

**Why it happens:** Source hashing only checks files in the specified directory. If you changed a file outside that directory, it won't be detected.

**Fixes:**

- Use `--force` to force rebuild
- Ensure the hash directory includes all relevant source files
- Check that the hash key is unique to your package

---

MIT License -- see [LICENSE](../LICENSE).
