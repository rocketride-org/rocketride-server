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
	diagnoseTestTarget,
	withDotenv,
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

// A command that ran and printed this
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

// diagnoseWsl for Ubuntu-22.04 with the facts of a working one, some overridden
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

test('a docker that is there but cannot start is not called missing', () => {
	const denied = diagnoseLocalDocker({ platform: 'linux', code: -1, stderr: 'Error: spawn docker EACCES' });
	assert.strictEqual(denied.problem, 'docker could not start: Error: spawn docker EACCES');
	assert.doesNotMatch(denied.fix.join('\n'), /install/i);
});

test('a missing image names the tasks that make it', () => {
	assert.match(missingImage('win32', 'rocketride/node:3.4.0').fix.join('\n'), /build-on-wsl[\s\S]*sync-from-wsl/);
	assert.deepStrictEqual(missingImage('linux', 'x').fix, ['./builder container:build']);
	// Those tasks make only the default image: one a variable names is pulled, or the variable goes
	const named = missingImage('linux', 'example/custom:dev', 'RR_DOCKER_IMAGE');
	assert.strictEqual(named.problem, 'example/custom:dev, named by RR_DOCKER_IMAGE, is not on this daemon');
	assert.deepStrictEqual(named.fix, [
		'docker pull example/custom:dev, or load it into this daemon',
		'or unset RR_DOCKER_IMAGE to use rocketride/node:<version>',
	]);
	assert.doesNotMatch(missingImage('win32', 'x', 'RR_K8S_IMAGE').fix.join('\n'), /builder/);
});

test('container:test runs the nodes in the image it built, on the daemon it built it on', () => {
	const id = (value) => ({ code: 0, stdout: `${value}\n` });
	const built = 'rocketride/node:3.4.0';
	assert.strictEqual(diagnoseTestTarget({ built, here: id('A'), engine: id('A') }), null);
	assert.strictEqual(diagnoseTestTarget({ built, image: built, here: id('A'), engine: id('A') }), null);
	const named = diagnoseTestTarget({ built, image: 'mine:dev', here: id('A'), engine: id('A') });
	assert.match(named.problem, /tasks in mine:dev \(RR_DOCKER_IMAGE\), not in rocketride\/node:3\.4\.0/);
	assert.match(named.fix[0], /unset RR_DOCKER_IMAGE/);
	const elsewhere = diagnoseTestTarget({ built, here: id('A'), engine: id('B') });
	assert.match(elsewhere.problem, /another docker daemon than the one rocketride\/node:3\.4\.0 was built on/);
	assert.match(elsewhere.fix[0], /DOCKER_HOST or DOCKER_CONTEXT in dist\/server\/\.env/);
	// A daemon that does not answer the engine is left to the preflight, which says why
	assert.strictEqual(diagnoseTestTarget({ built, here: id('A'), engine: { code: 1, stdout: '' } }), null);
});

test("the engine's .env adds the names its environment lacks and replaces none", () => {
	const env = { DOCKER_HOST: 'unix:///var/run/docker.sock', HOME: '/home/me' };
	const values = { DOCKER_HOST: 'unix:///run/user/1000/docker.sock', KUBECONFIG: '/home/me/kind.yaml' };
	assert.deepStrictEqual(withDotenv(env, values), {
		DOCKER_HOST: 'unix:///var/run/docker.sock',
		HOME: '/home/me',
		KUBECONFIG: '/home/me/kind.yaml',
	});
	// A copy: the builder's own environment stays as it was
	assert.deepStrictEqual(env, { DOCKER_HOST: 'unix:///var/run/docker.sock', HOME: '/home/me' });
});

test('${NAME} expands from the environment, then the lines above, then the default', () => {
	const values = {
		XDG_RUNTIME_DIR: '/run/user/0',
		SOCKET: '${XDG_RUNTIME_DIR}/docker.sock',
		DOCKER_HOST: 'unix://${SOCKET}',
		KUBECONFIG: '${KUBE_DIR:-/home/me/.kube}/kind.yaml',
		UNSET: '${NOWHERE}',
		EARLY: '${LATE:-none}',
		LATE: 'late',
	};
	const loaded = withDotenv({ XDG_RUNTIME_DIR: '/run/user/1000' }, values);
	assert.strictEqual(loaded.SOCKET, '/run/user/1000/docker.sock');
	assert.strictEqual(loaded.DOCKER_HOST, 'unix:///run/user/1000/docker.sock');
	assert.strictEqual(loaded.KUBECONFIG, '/home/me/.kube/kind.yaml');
	assert.strictEqual(loaded.UNSET, '');
	assert.strictEqual(loaded.EARLY, 'none');
	assert.strictEqual(withDotenv({ KUBE_DIR: '/k' }, values).KUBECONFIG, '/k/kind.yaml');
});

test('on Windows the engine holds each name in upper case, whatever case its .env uses', () => {
	// Path, as process.env spells it there
	const env = { Path: 'C:\\Windows' };
	const values = {
		rr_docker_image: 'example/custom:dev',
		FOO: 'a',
		foo: 'b',
		path: 'C:\\elsewhere',
		REFS: '${PATH}|${Path}|${foo}',
	};
	// Twins in case: the first one stays. ${NAME} finds the environment's names in upper case only
	assert.deepStrictEqual(withDotenv(env, values, 'win32'), {
		Path: 'C:\\Windows',
		RR_DOCKER_IMAGE: 'example/custom:dev',
		FOO: 'a',
		REFS: 'C:\\Windows||b',
	});
	assert.deepStrictEqual(withDotenv({}, { rr_docker_image: 'x' }, 'linux'), { rr_docker_image: 'x' });
});

test('Path and PATH are one name on Windows', { skip: process.platform !== 'win32' }, () => {
	const name = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
	const loaded = withDotenv(process.env, { [name === 'PATH' ? 'Path' : 'PATH']: 'C:\\elsewhere' }, process.platform);
	const paths = Object.keys(loaded).filter((key) => key.toUpperCase() === 'PATH');
	assert.deepStrictEqual(paths, [name]);
	assert.strictEqual(loaded[name], process.env[name]);
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
