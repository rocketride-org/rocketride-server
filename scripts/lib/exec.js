/**
 * Shared Execution Utilities
 *
 * Helper functions for executing shell commands.
 * On Windows, resolves commands without extension (e.g. "mvn", "vsvars") using a fixed
 * extension order and runs .cmd/.bat via cmd /c, .ps1 via PowerShell -File, .exe/.com directly.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { logOutput } = require('./log');
const { taskDebug } = require('./debug');

/** Windows: extension order and how to run. Used for resolution and execution. */
const WIN_EXTENSIONS = [
    { ext: '.com', run: 'direct' },
    { ext: '.exe', run: 'direct' },
    { ext: '.bat', run: 'cmd' },
    { ext: '.cmd', run: 'cmd' },
    { ext: '.ps1', run: 'powershell' }
];
const WIN_EXT_RUN = Object.fromEntries(WIN_EXTENSIONS.map(e => [e.ext.toLowerCase(), e.run]));

/**
 * Resolve command on Windows to an absolute path and run style (direct, cmd, powershell).
 * @param {string} command - Command name or path (extension optional)
 * @param {string} cwd - Working directory for resolving relative paths
 * @param {Object} env - Environment (uses env.PATH for bare names)
 * @returns {{ resolvedPath: string, runStyle: 'direct'|'cmd'|'powershell' } | null}
 */
function resolveWindowsCommand(command, cwd, env) {
    const pathEnv = (env && env.PATH) || process.env.PATH || '';
    const pathDirs = pathEnv.split(path.delimiter);
    const hasPath = /[\\/]/.test(command) || command.startsWith('.');

    if (hasPath) {
        const absPath = path.resolve(cwd, command);
        const ext = path.extname(absPath).toLowerCase();
        if (WIN_EXT_RUN[ext]) {
            if (fs.existsSync(absPath)) {
                return { resolvedPath: absPath, runStyle: WIN_EXT_RUN[ext] };
            }
            return null; // explicit extension but file not found — do not try other extensions
        }
        const dir = path.dirname(absPath);
        const base = path.basename(absPath, ext) || path.basename(absPath);
        for (const { ext: e, run } of WIN_EXTENSIONS) {
            const candidate = path.join(dir, base + e);
            if (fs.existsSync(candidate)) {
                return { resolvedPath: candidate, runStyle: run };
            }
        }
        return null;
    }

    // Bare name: try "command" with known extension, or "command" as-is if it already has one
    const ext = path.extname(command).toLowerCase();
    if (WIN_EXT_RUN[ext]) {
        for (const dir of pathDirs) {
            const candidate = path.join(dir, command);
            if (fs.existsSync(candidate)) {
                return { resolvedPath: candidate, runStyle: WIN_EXT_RUN[ext] };
            }
        }
        return null; // explicit extension but not found in PATH — do not try other extensions
    }
    for (const dir of pathDirs) {
        for (const { ext: e, run } of WIN_EXTENSIONS) {
            const candidate = path.join(dir, command + e);
            if (fs.existsSync(candidate)) {
                return { resolvedPath: candidate, runStyle: run };
            }
        }
    }
    return null;
}

/**
-- * Execute a command with streaming output to a Listr task.
 * On Windows, resolves bare names (e.g. "mvn", "npx") and paths without extension using
 * .com, .exe, .bat, .cmd, .ps1; runs .cmd/.bat via cmd /c, .ps1 via PowerShell -File, others directly.
 *
 * @param {string} command - Command to run (path or name; extension optional on Windows)
 * @param {string[]} args - Command arguments
 * @param {Object} options - Options
 * @param {string} options.cwd - Working directory
 * @param {Object} options.task - Listr2 task for output
 * @param {Object} options.env - Environment variables
 * @param {function} options.onOutput - Callback for each output chunk
 * @param {boolean} options.collect - If true, returns output string directly instead of object
 * @param {string} options.logModule - Module name for log collection (e.g., 'client-python:test')
 * @param {boolean} options.verbose - If true, print command and args to console (e.g. for builder --verbose).
 * @param {string} options.stdio - If 'inherit', child stdout/stderr go to process. If 'ignore', child stdio are disconnected. Otherwise uses pipe for task/log collection.
 * @returns {Promise<string|{stdout: string, stderr: string, code: number}>}
 */
async function execCommand(command, args, options = {}) {
    const {
        cwd = process.cwd(),
        task = null,
        env = process.env,
        onOutput = null,
        collect = false,
        logModule = null,
        verbose = false,
        stdio = undefined
    } = options;
    const inherit = stdio === 'inherit';
    const ignoreStdio = stdio === 'ignore';

    const effectiveLogModule = logModule || task?._logModule || null;
    let allOutput = '';

    let spawnCmd = command;
    let spawnArgs = args;
    if (process.platform === 'win32') {
        const resolved = resolveWindowsCommand(command, cwd, env);
        if (resolved) {
            if (resolved.runStyle === 'cmd') {
                spawnCmd = 'cmd';
                spawnArgs = ['/c', resolved.resolvedPath, ...args];
            } else if (resolved.runStyle === 'powershell') {
                spawnCmd = 'powershell';
                spawnArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved.resolvedPath, ...args];
            } else {
                spawnCmd = resolved.resolvedPath;
                spawnArgs = args;
            }
        }
    }

    const exactCommandLine = [spawnCmd, ...spawnArgs]
        .map(a => (typeof a === 'string' && a.includes(' ')) ? `"${a}"` : String(a))
        .join(' ');

    if (verbose) {
        const line = `$ ${exactCommandLine}`;
        if (task) task.output = line;
        if (onOutput) onOutput(line + '\n');
        console.log(line);
        taskDebug('[exec]', exactCommandLine);
    }

    // Log the command being executed
    if (effectiveLogModule) {
        logOutput(effectiveLogModule, `$ ${command} ${args.join(' ')}`);
        logOutput(effectiveLogModule, `  cwd: ${cwd}`);
    }

    function addLine(line) {
        const trimmed = line.trim();
        if (trimmed) {
            if (task) {
                task.output = trimmed;
            }
            if (effectiveLogModule) {
                logOutput(effectiveLogModule, line);
            }
        }
    }

    function logExecFailure(context, err, exitCode = null) {
        console.error('[exec]', context, err instanceof Error ? err.message : String(err));
        if (exitCode != null) console.error('[exec] exitCode:', exitCode);
        console.error('[exec] command:', spawnCmd);
        console.error('[exec] args:', spawnArgs);
        console.error('[exec] cwd:', cwd);
        if (env != null && typeof env === 'object') {
            console.error('[exec] env:', env);
        }
    }

    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = spawn(spawnCmd, spawnArgs, {
                cwd,
                shell: false,
                env,
                stdio: ignoreStdio ? 'ignore' : (inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']),
                ...(process.platform === 'win32' && { windowsHide: true })
            });
        } catch (err) {
            logExecFailure('spawn threw', err);
            reject(err);
            return;
        }

        if (!inherit && !ignoreStdio) {
            proc.stdout.on('data', (data) => {
                const text = data.toString();
                allOutput += text;
                if (onOutput) onOutput(text);
                text.split(/\r?\n/).forEach(addLine);
            });

            proc.stderr.on('data', (data) => {
                const text = data.toString();
                allOutput += text;
                if (onOutput) onOutput(text);
                text.split(/\r?\n/).forEach(addLine);
            });
        }

        proc.on('close', (code) => {
            if (effectiveLogModule) {
                logOutput(effectiveLogModule, `[Exit code: ${code}]`);
            }
            if (code !== 0) {
                const msg = (inherit || ignoreStdio) ? `Command failed (exit ${code})` : `Command failed (exit ${code}):\n${allOutput.slice(-2000)}`;
                reject(new Error(msg));
            } else {
                resolve(inherit || ignoreStdio ? { code: 0 } : (collect ? allOutput : { stdout: allOutput, stderr: '', code: 0 }));
            }
        });

        proc.on('error', (err) => {
            logExecFailure('process error', err);
            reject(err);
        });
    });
}

module.exports = {
    execCommand
};
