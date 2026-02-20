/**
 * Test Server Utilities
 * 
 * Provides functions to start/stop Python servers for testing.
 * Used by test tasks that need a running server.
 * 
 * Usage:
 *   const { startServer, stopServer } = require('../../../scripts/lib');
 *   
 *   // Start EAAS server
 *   const { server, port } = await startServer({ script: 'ai/eaas.py' });
 *   
 *   // Start model server
 *   const { server, port } = await startServer({ script: '-m model_server' });
 *   
 *   // ... run tests with port ...
 *   stopServer({ server });
 */
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { exists } = require('./fs');
const { PROJECT_ROOT } = require('./paths');

const SERVER_DIR = path.join(PROJECT_ROOT, 'dist', 'server');
const READY_MESSAGE = 'Application startup complete.';

/**
 * Find an available port
 * @returns {Promise<number>} Available port number
 */
async function findFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

/**
 * Start a Python server using the engine executable
 * 
 * Waits indefinitely for the server to emit "Application startup complete."
 * This is necessary because server startup time is unpredictable - it may need
 * to install Python dependencies, download models, etc. The server will still
 * fail fast if the process exits unexpectedly or encounters an error.
 * 
 * @param {Object} options - Options
 * @param {string} options.script - Python script to run (relative to dist/server), e.g. 'ai/eaas.py'
 * @param {number} [options.port] - Use existing server on this port (skip starting)
 * @param {Function} [options.onOutput] - Callback for server output (for logging)
 * @param {string[]} [options.trace] - Trace categories to enable (passed as --trace=a,b,c)
 * @param {number} [options.basePort] - Base port for task allocation
 * @param {string[]} [options.args] - Additional arguments to pass to the script
 * @returns {Promise<{server: ChildProcess|null, port: number}>}
 */
async function startServer(options) {
    const { 
        script,
        port: existingPort, 
        onOutput, 
        trace, 
        basePort,
        args = [],
        env = {}
    } = options;
    
    if (!script) {
        throw new Error('startServer: script is required');
    }
    
    // If a port is specified, use existing server (don't start one)
    if (existingPort) {
        return { server: null, port: existingPort };
    }
    
    // Find a free port
    const port = await findFreePort();
    
    const serverExe = path.join(SERVER_DIR, process.platform === 'win32' ? 'engine.exe' : 'engine');
    
    if (!await exists(serverExe)) {
        throw new Error(`Server not found at ${serverExe}. Run: builder build:server`);
    }
    
    // Build server arguments (split script in case it has flags like '-m module')
    // --autoterm enables stdin monitoring - server exits when parent process dies
    const scriptArgs = script.split(/\s+/);
    const serverArgs = ['--autoterm', ...scriptArgs, `--port=${port}`, ...args];
    if (basePort) {
        serverArgs.push(`--base_port=${basePort}`);
    }
    if (trace?.length) {
        serverArgs.push(`--trace=${trace.join(',')}`);
    }
    
    return new Promise((resolve, reject) => {
        const serverProcess = spawn(
            serverExe,
            serverArgs,
            { 
                cwd: SERVER_DIR,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, ...env }
            }
        );
        
        let resolved = false;
        let outputBuffer = '';
        
        const checkReady = (data) => {
            const text = data.toString();
            outputBuffer += text;
            
            // Always forward output if callback provided
            if (onOutput) {
                onOutput(text);
            }
            
            if (!resolved && outputBuffer.includes(READY_MESSAGE)) {
                resolved = true;
                resolve({ server: serverProcess, port });
            }
        };
        
        serverProcess.stdout.on('data', checkReady);
        serverProcess.stderr.on('data', checkReady);
        
        serverProcess.on('error', (err) => {
            if (!resolved) {
                resolved = true;
                reject(err);
            }
        });
        
        serverProcess.on('exit', (code) => {
            if (!resolved) {
                resolved = true;
                reject(new Error(`Server exited unexpectedly with code ${code}. Script: ${script}`));
            }
        });
    });
}

/**
 * Stop the test server
 * 
 * Uses graceful shutdown by closing stdin. When --autoterm is specified,
 * the engine monitors stdin and exits automatically when it closes.
 * This is cleaner than taskkill and avoids accidentally killing sibling processes.
 * 
 * Waits for the process to actually exit before resolving, ensuring clean
 * lifecycle and preventing callbacks from firing after teardown completes.
 * 
 * @param {{server: ChildProcess|null}} serverObj - Server object from startServer
 * @param {number} [timeout=5000] - Timeout in ms to wait for graceful shutdown before force kill
 * @returns {Promise<void>} Resolves when the server has exited
 */
async function stopServer(serverObj, timeout = 5000) {
    // Skip if no server object or if server is null (using existing server)
    if (!serverObj || !serverObj.server) return;
    
    const serverProcess = serverObj.server;
    
    // If already exited, nothing to do
    if (serverProcess.killed || serverProcess.exitCode !== null) return;
    
    return new Promise((resolve) => {
        let resolved = false;
        
        // Resolve when process exits
        const onExit = () => {
            if (!resolved) {
                resolved = true;
                resolve();
            }
        };
        
        serverProcess.on('exit', onExit);
        serverProcess.on('close', onExit);
        
        try {
            // Close stdin to trigger graceful shutdown
            // Engine monitors stdin and exits when it closes (default behavior)
            if (serverProcess.stdin) {
                serverProcess.stdin.end();
            }
        } catch {
            // Ignore stdin errors
        }
        
        // Force kill after timeout if still running
        setTimeout(() => {
            if (!resolved) {
                try {
                    if (!serverProcess.killed) {
                        serverProcess.kill('SIGKILL');
                    }
                } catch {
                    // Ignore - process may have already exited
                }
                // Resolve anyway after force kill attempt
                if (!resolved) {
                    resolved = true;
                    resolve();
                }
            }
        }, timeout);
    });
}

module.exports = {
    startServer,
    stopServer,
    findFreePort
};
