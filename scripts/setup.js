/**
 * Platform setup wrapper. Ensures pnpm, then runs OS-specific setup.
 * build.js calls setupSystem(options) once at startup.
 */
const { execCommand } = require('./lib/exec');

const platform = process.platform;
const setupModule = platform === 'win32'
    ? require('./setup-windows')
    : require('./setup-unix');

async function pnpmAvailable() {
    try {
        await execCommand('pnpm', ['--version'], { collect: true });
        return true;
    } catch {
        return false;
    }
}

async function ensurePnpm(options) {
    if (await pnpmAvailable()) return;
    
    if (options.autoinstall) {

        console.log('Installing global pnpm...\n');

        try {
            await execCommand('npm', ['install', '-g', 'pnpm'], { stdio: 'inherit' });
        } catch {
            console.error('\nFailed to install pnpm globally. Install manually: npm install -g pnpm');
            console.error('  On Windows, try running the terminal as Administrator.');
            process.exit(1);
        }
        
        if (!(await pnpmAvailable())) {
            console.log('\npnpm was installed globally. Run your command again (open a new terminal if needed).');
            process.exit(0);
        }

        await ensurePnpm(options);
    }

    console.error('pnpm is required (install globally) but not found.');
    console.error('  Install globally: npm install -g pnpm');
    console.error('  Or run: builder build --autoinstall');
    process.exit(1);
}

async function setupSystem(options) {
    await ensurePnpm(options);
    return setupModule.setupSystem(options);
}

module.exports = { setupSystem };
