/**
 * What the container tasks say when Docker or WSL is missing (container-checks.js).
 *
 * The facts are the ones tasks.js gathers; each case is the first missing piece
 * and the fix it names. Run:
 *     node --test nodes/scripts/container-checks.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
	wslText,
	parseWslList,
	parseFacts,
	diagnoseLocalDocker,
	diagnoseWsl,
	missingImage,
	unavailableReason,
	formatDiagnosis,
} = require('./container-checks');

// What wsl.exe prints without WSL_UTF8: UTF-16 (no BOM), read as UTF-8
function utf16(text) {
	return Buffer.from(text, 'utf16le').toString('utf8');
}

const LIST = [
	'  NAME              STATE           VERSION',
	'* Ubuntu-22.04      Running         2',
	'  Ubuntu-24.04      Stopped         2',
	'  docker-desktop    Running         2',
	'  Legacy            Stopped         1',
	'',
].join('\r\n');

const ok = (stdout) => ({ code: 0, stdout, stderr: '' });

// Facts of a distribution where everything works
const GOOD = {
	VERSION_ID: '22.04',
	CLI: '/usr/bin/docker',
	DESKTOP_CLI: 'no',
	ENGINE: 'yes',
	SYSTEMD: 'yes',
	INFO_RC: '0',
	INFO: 'abc Ubuntu 22.04.5 LTS',
	CHECKOUT: 'yes',
};

function diagnose(overrides = {}, args = {}) {
	return diagnoseWsl({ distro: 'Ubuntu-22.04', list: ok(LIST), facts: { ...GOOD, ...overrides }, ...args });
}

test('wsl.exe output is read in either encoding', () => {
	assert.strictEqual(wslText(utf16('Ubuntu')), 'Ubuntu');
	assert.strictEqual(wslText(String.fromCharCode(0xfeff) + 'Ubuntu'), 'Ubuntu');
	assert.deepStrictEqual(
		parseWslList(utf16(LIST)).map((d) => d.name),
		['Ubuntu-22.04', 'Ubuntu-24.04', 'docker-desktop', 'Legacy']
	);
});

test('the list keeps the default mark and the WSL version', () => {
	const [first, , , legacy] = parseWslList(LIST);
	assert.deepStrictEqual(first, { name: 'Ubuntu-22.04', state: 'Running', version: '2', isDefault: true });
	assert.strictEqual(legacy.version, '1');
});

test('probe facts are KEY=value lines', () => {
	assert.deepStrictEqual(parseFacts('VERSION_ID=22.04\nINFO=a b \nnoise\n'), { VERSION_ID: '22.04', INFO: 'a b' });
});

test('nothing is missing', () => {
	assert.strictEqual(diagnose({}, { needJammy: true, checkout: '/home/me/rr' }), null);
});

test('no WSL at all', () => {
	const d = diagnoseWsl({ distro: 'Ubuntu-22.04', list: { code: -1, stdout: '', stderr: 'spawn wsl.exe ENOENT' } });
	assert.match(d.problem, /WSL is not installed/);
	assert.match(d.fix[0], /wsl --install --no-distribution/);
});

test('no distributions yet means the distribution is missing, not WSL', () => {
	const list = { code: 1, stdout: '', stderr: utf16('Windows Subsystem for Linux has no installed distributions.') };
	const d = diagnoseWsl({ distro: 'Ubuntu-22.04', list, facts: null });
	assert.match(d.problem, /Ubuntu-22.04 is not installed \(installed: none\)/);
	assert.match(d.fix[0], /wsl --install -d Ubuntu-22.04/);
});

test('a missing distribution lists the installed ones', () => {
	const d = diagnoseWsl({ distro: 'NoSuch', list: ok(LIST), facts: null });
	assert.match(
		d.problem,
		/NoSuch is not installed \(installed: Ubuntu-22.04, Ubuntu-24.04, docker-desktop, Legacy\)/
	);
	assert.match(d.fix[1], /--distro= or RR_WSL_DISTRO/);
});

test('the distribution name is matched without case', () => {
	assert.strictEqual(diagnoseWsl({ distro: 'ubuntu-22.04', list: ok(LIST), facts: GOOD }), null);
});

test('WSL 1 cannot run docker', () => {
	const d = diagnoseWsl({ distro: 'Legacy', list: ok(LIST), facts: GOOD });
	assert.match(d.problem, /WSL 1/);
	assert.deepStrictEqual(d.fix, ['wsl --set-version Legacy 2']);
});

test('a distribution whose probe failed', () => {
	const d = diagnoseWsl({ distro: 'Ubuntu-22.04', list: ok(LIST), facts: null, probeError: utf16('boom\nmore') });
	assert.match(d.problem, /does not start/);
	assert.strictEqual(d.fix[1], 'wsl.exe said: boom');
});

test('the image is built only in Ubuntu 22.04', () => {
	const d = diagnose({ VERSION_ID: '24.04' }, { needJammy: true });
	assert.match(d.problem, /Ubuntu 24.04; the image base is 22.04/);
	assert.strictEqual(diagnose({ VERSION_ID: '24.04' }), null);
});

test('the checkout must be a git clone', () => {
	const d = diagnose({ CHECKOUT: 'no' }, { checkout: '/home/me/rr' });
	assert.match(d.problem, /\/home\/me\/rr in Ubuntu-22.04 is not a git checkout/);
});

test('no docker offers the integration or Docker Engine', () => {
	const d = diagnose({ CLI: '', INFO_RC: '127' });
	assert.match(d.problem, /has no docker/);
	const text = d.fix.join('\n');
	assert.match(text, /WSL integration → Ubuntu-22.04 → Apply & restart/);
	assert.match(text, /docs\.docker\.com\/engine\/install\/ubuntu/);
	assert.match(text, /wsl --terminate Ubuntu-22.04/);
});

test("Docker Desktop's stub left after the integration is turned off counts as no docker", () => {
	const d = diagnose({
		CLI: '/usr/bin/docker',
		ENGINE: 'no',
		INFO_RC: '1',
		INFO: "The command 'docker' could not be found in this WSL 2 distro. We recommend to activate the WSL",
	});
	assert.match(d.problem, /has no docker/);
});

test('a socket this user may not open', () => {
	const d = diagnose({ INFO_RC: '1', INFO: 'permission denied while trying to connect to the Docker daemon socket' });
	assert.match(d.fix[0], /usermod -aG docker/);
});

test("Docker Desktop's CLI without Docker Desktop running", () => {
	const d = diagnose({ INFO_RC: '1', DESKTOP_CLI: 'yes', ENGINE: 'no', INFO: 'Cannot connect' });
	assert.match(d.problem, /Docker Desktop's, and Docker Desktop does not answer/);
	assert.strictEqual(d.fix.at(-1), 'docker said: Cannot connect');
});

test('a stopped Docker Engine, with and without systemd', () => {
	assert.match(diagnose({ INFO_RC: '1' }).fix[0], /sudo systemctl start docker/);
	assert.match(diagnose({ INFO_RC: '1', SYSTEMD: 'no' }).fix[0], /sudo service docker start/);
});

test('a CLI with no daemon behind it', () => {
	const d = diagnose({ INFO_RC: '1', ENGINE: 'no' });
	assert.match(d.problem, /no docker daemon answers/);
});

test('the local daemon: not installed, not running, Windows containers, fine', () => {
	const missing = { code: -1, stderr: 'spawn docker ENOENT' };
	assert.match(diagnoseLocalDocker({ platform: 'win32', ...missing }).fix[0], /windows-install/);
	assert.match(diagnoseLocalDocker({ platform: 'darwin', ...missing }).fix[0], /mac-install/);
	assert.match(diagnoseLocalDocker({ platform: 'linux', ...missing }).fix[0], /engine\/install/);
	assert.match(diagnoseLocalDocker({ platform: 'win32', code: 1 }).problem, /Docker Desktop is not running/);
	assert.match(diagnoseLocalDocker({ platform: 'linux', code: 1 }).fix[0], /systemctl start docker/);
	assert.match(
		diagnoseLocalDocker({ platform: 'linux', code: 1, stderr: 'permission denied' }).fix[0],
		/usermod -aG docker/
	);
	assert.match(diagnoseLocalDocker({ platform: 'win32', code: 0, stdout: 'windows\n' }).fix[0], /Linux containers/);
	assert.strictEqual(diagnoseLocalDocker({ platform: 'win32', code: 0, stdout: 'linux\n' }), null);
});

test('a missing image names the tasks that make it', () => {
	assert.match(missingImage('win32', 'rocketride/node:3.4.0').fix.join('\n'), /build-on-wsl[\s\S]*sync-from-wsl/);
	assert.deepStrictEqual(missingImage('linux', 'x').fix, ['./builder container:build']);
});

test('a task missing on this OS says why, and offers no other task in its place', () => {
	const build = unavailableReason('container:build', 'win32');
	assert.match(build, /dist\/server here is a Windows engine\. See \.\\builder --help/);
	assert.match(unavailableReason('container:test', 'darwin'), /a macOS engine\. See \.\/builder --help/);
	assert.match(unavailableReason('container:build-on-wsl', 'linux'), /WSL exists only on Windows/);
	assert.match(unavailableReason('container:sync-from-wsl', 'darwin'), /WSL exists only on Windows/);
	for (const task of ['container:build', 'container:test', 'container:build-on-wsl', 'container:sync-from-wsl']) {
		for (const platform of ['win32', 'linux', 'darwin']) {
			assert.doesNotMatch(unavailableReason(task, platform), /container:(build|test|sync)\S* --|nodes:test/);
		}
	}
});

test('the error text: the problem, then the fix indented', () => {
	assert.strictEqual(
		formatDiagnosis('container:sync', { problem: 'Docker Desktop is not running', fix: ['Start it'] }),
		'container:sync: Docker Desktop is not running.\n  Start it'
	);
});
