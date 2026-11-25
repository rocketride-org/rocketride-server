/**
 * What the container tasks say when Docker, WSL or a cluster is missing (container-checks.js).
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
	isLocalContext,
	parseCluster,
	isLocalServer,
	k8sLabelValue,
	diagnoseKubernetes,
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
	// docker ran and its daemon error names ENOENT: the daemon is the problem, not the CLI
	const ran = diagnoseLocalDocker({ platform: 'win32', code: 1, stderr: 'error during connect: ENOENT' });
	assert.strictEqual(ran.problem, 'Docker Desktop is not running');
});

test('a docker that does not answer in time names the command that timed out', () => {
	const stderr = 'docker info --format {{.OSType}} did not answer within 60 s';
	const d = diagnoseLocalDocker({ platform: 'win32', code: 1, stderr, timedOut: true });
	assert.strictEqual(d.problem, stderr);
	assert.match(diagnoseLocalDocker({ platform: 'linux', code: 1, stderr, timedOut: true }).fix[0], /restart docker/);
});

test('a missing image names the tasks that make it', () => {
	assert.match(missingImage('win32', 'rocketride/node:3.4.0').fix.join('\n'), /build-on-wsl[\s\S]*sync-from-wsl/);
	// macOS has no such task: the published image, tagged as the one the runtime starts
	assert.deepStrictEqual(missingImage('darwin', 'rocketride/node:3.4.0').fix, [
		'docker pull ghcr.io/rocketride-org/rocketride-node:3.4.0',
		'docker tag ghcr.io/rocketride-org/rocketride-node:3.4.0 rocketride/node:3.4.0',
	]);
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
	const remote = diagnoseTestTarget({ built, here: id('A'), engine: id('A'), taskserver: '5565' });
	assert.match(remote.problem, /tests would run on the server at 5565/);
	assert.match(remote.fix[0], /container:build, then nodes:test --runtime=docker --taskserver=5565/);
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

// What `kubectl config current-context` answers, and a namespace that is there
const context = (name) => ({ code: 0, stdout: `${name}\n`, stderr: '' });
const THERE = { code: 0, stdout: 'namespace/rocketride-tasks\n', stderr: '' };

function cluster(overrides = {}) {
	return diagnoseKubernetes({
		current: context('docker-desktop'),
		namespace: 'rocketride-tasks',
		found: THERE,
		...overrides,
	});
}

test('a cluster on this machine is told by its context', () => {
	const local = ['docker-desktop', 'kind-kind', 'kind-dev', 'k3d-rr', 'minikube', 'rancher-desktop', 'orbstack'];
	const other = ['prod', 'gke_project_europe-west1_tasks', 'arn:aws:eks:eu-west-1:1:cluster/tasks', 'kind', ''];
	for (const name of local) assert.strictEqual(isLocalContext(name), true, name);
	for (const name of other) assert.strictEqual(isLocalContext(name), false, name);
});

// What `kubectl config view --minify -o jsonpath={.clusters[0]}` prints (kubectl v1.36) for a
// kind cluster reached through a SOCKS proxy, with a TLS server name
const TUNNELED =
	'{"cluster":{"certificate-authority-data":"DATA+OMITTED",' +
	'"proxy-url":"socks5://user:secret@bastion.example.com:1080","server":"https://127.0.0.1:6443",' +
	'"tls-server-name":"api.example.com"},"name":"kind-dev-cluster"}';

test('the cluster entry kubectl prints gives its name and where its requests go', () => {
	assert.deepStrictEqual(parseCluster(TUNNELED), {
		clusterName: 'kind-dev-cluster',
		server: 'https://127.0.0.1:6443',
		proxyUrl: 'socks5://user:secret@bastion.example.com:1080',
		tlsServerName: 'api.example.com',
	});
	const none = { clusterName: '', server: '', proxyUrl: '', tlsServerName: '' };
	const desktop =
		'{"cluster":{"certificate-authority-data":"DATA+OMITTED",' +
		'"server":"https://kubernetes.docker.internal:6443"},"name":"docker-desktop"}';
	assert.deepStrictEqual(parseCluster(desktop), {
		...none,
		clusterName: 'docker-desktop',
		server: 'https://kubernetes.docker.internal:6443',
	});
	// A cluster that sets none of the fields
	const bare = '{"cluster":{"insecure-skip-tls-verify":true,"server":""},"name":"bare"}';
	assert.deepStrictEqual(parseCluster(bare), { ...none, clusterName: 'bare' });
	// A context with no cluster prints nothing; a failed or cut-off answer is no entry either
	const unread = ['', 'error: cannot locate cluster gone', '{"cluster":{"server":"https://127.0.0.1:6443"', 'null'];
	for (const text of unread) assert.deepStrictEqual(parseCluster(text), none, text);
});

test('a local context must point at a server on this machine', () => {
	const here = [
		['https://127.0.0.1:6443', 'kind-dev'],
		['https://127.0.0.2:6443', 'kind-dev'],
		['https://kubernetes.docker.internal:6443', 'docker-desktop'],
		['https://localhost:8443', 'rancher-desktop'],
		['https://0.0.0.0:6550', 'k3d-rr'],
		['https://host.docker.internal:6550', 'k3d-rr'],
		['https://[::1]:6443', 'orbstack'],
		['https://192.168.49.2:8443', 'minikube'],
		['https://LOCALHOST:8443', 'rancher-desktop'],
		['https://127.0.0.1', 'kind-dev'],
	];
	const elsewhere = [
		['https://k8s.example.com:6443', 'kind-dev'],
		['https://10.0.5.20:6443', 'kind-dev'],
		['https://192.168.49.2:8443', 'docker-desktop'],
		['https://203.0.113.7:8443', 'minikube'],
		['https://127.example.com:6443', 'kind-dev'],
		['https://192.168.example.com:8443', 'minikube'],
		['', 'kind-dev'],
		['not a url', 'kind-dev'],
		// Node reads these as 127.0.0.1 or 192.168.49.2, so they are judged as written
		['https://127.1:6443', 'kind-dev'],
		['https://2130706433:6443', 'kind-dev'],
		['https://0x7f.1:6443', 'kind-dev'],
		['https://0177.0.0.1:6443', 'kind-dev'],
		['https://127.0.0.01:6443', 'kind-dev'],
		['https://2130706433/127.0.0.1', 'kind-dev'],
		['https://3232248066:8443', 'minikube'],
	];
	for (const [server, name] of here) assert.strictEqual(isLocalServer(server, name), true, `${name} ${server}`);
	for (const [server, name] of elsewhere) assert.strictEqual(isLocalServer(server, name), false, `${name} ${server}`);

	const remote = cluster({ current: context('kind-dev'), server: 'https://10.0.5.20:6443', found: null });
	assert.match(remote.problem, /kind-dev points at https:\/\/10\.0\.5\.20:6443, not a cluster on this machine/);
	const unread = cluster({ current: context('kind-dev'), server: '', found: null });
	assert.match(unread.problem, /kind-dev names no server kubectl could read/);
	assert.strictEqual(cluster({ server: 'https://kubernetes.docker.internal:6443' }), null);

	// A user:password@ in the URL is not shown, however it is written
	const logins = [
		['https://admin:s3cret@k8s.example.com:6443', 'https://k8s.example.com:6443'],
		['https://admin@x:s3cret@k8s.example.com:6443', 'https://k8s.example.com:6443'],
		['https://admin:s3cret@k8s.example.com:99999', 'https://k8s.example.com:99999'],
		['https:admin:s3cret@k8s.example.com', 'https:k8s.example.com'],
	];
	for (const [server, shown] of logins) {
		const said = formatDiagnosis('nodes:test --runtime=k8s', cluster({ current: context('kind-dev'), server }));
		assert.ok(said.includes(`kind-dev points at ${shown}, not a cluster`), said);
		assert.ok(!/admin|s3cret/.test(said), said);
	}
});

test('a local server reached through a proxy or a tunnel is refused', () => {
	const tunneled = { current: context('kind-dev'), ...parseCluster(TUNNELED), found: null };
	const refused = [
		[{}, 'proxy-url'],
		// ssh -D: the proxy is local, the cluster behind it is not
		[{ proxyUrl: 'socks5://localhost:1080' }, 'proxy-url'],
		[{ proxyUrl: '' }, 'tls-server-name'],
	];
	for (const [fields, field] of refused) {
		const d = cluster({ ...tunneled, ...fields });
		assert.match(d.problem, new RegExp(`context kind-dev sets ${field} in its cluster`), field);
		assert.strictEqual(d.fix[0].split(': ')[1], `kubectl config unset clusters.kind-dev-cluster.${field}`);
	}
	// The proxy URL can hold a password
	const said = formatDiagnosis('nodes:test --runtime=k8s', cluster(tunneled));
	assert.ok(!/secret|bastion/.test(said), said);
	assert.strictEqual(cluster({ ...tunneled, proxyUrl: '', tlsServerName: '' }), null);
});

test("a proxy of kubectl's environment is refused, except where kubectl goes directly", () => {
	const proxy = 'http://user:secret@proxy.example.com:3128';
	const secure = { HTTPS_PROXY: proxy };
	const desktop = 'https://kubernetes.docker.internal:6443';
	const plain = 'http://kubernetes.docker.internal:6443';
	// [server, context, environment, platform] that kubectl reaches directly
	const direct = [
		[desktop, 'docker-desktop', {}, 'linux'],
		[desktop, 'docker-desktop', { HTTPS_PROXY: '' }, 'linux'],
		// An https server is not reached through HTTP_PROXY, nor an http one through HTTPS_PROXY
		[desktop, 'docker-desktop', { HTTP_PROXY: proxy }, 'linux'],
		[plain, 'docker-desktop', secure, 'linux'],
		// localhost in lower case, and a loopback address
		['https://localhost:8443', 'rancher-desktop', secure, 'linux'],
		['https://127.0.0.1:6443', 'kind-dev', secure, 'linux'],
		['https://127.0.0.2:6443', 'kind-dev', secure, 'linux'],
		['https://[::1]:6443', 'orbstack', secure, 'linux'],
		// A host NO_PROXY names: *, the host, or a domain it ends in
		[desktop, 'docker-desktop', { ...secure, NO_PROXY: '*' }, 'linux'],
		[desktop, 'docker-desktop', { ...secure, NO_PROXY: ' example.com , * ' }, 'linux'],
		[desktop, 'docker-desktop', { ...secure, NO_PROXY: 'kubernetes.docker.internal' }, 'linux'],
		[desktop, 'docker-desktop', { ...secure, NO_PROXY: 'KUBERNETES.docker.internal' }, 'linux'],
		[desktop, 'docker-desktop', { ...secure, NO_PROXY: 'docker.internal' }, 'linux'],
		[desktop, 'docker-desktop', { ...secure, NO_PROXY: '.docker.internal' }, 'linux'],
		[desktop, 'docker-desktop', { ...secure, NO_PROXY: '*.docker.internal' }, 'linux'],
		[desktop, 'docker-desktop', { ...secure, no_proxy: 'docker.internal' }, 'linux'],
		['https://192.168.49.2:8443', 'minikube', { ...secure, NO_PROXY: '192.168.49.2' }, 'linux'],
		// Linux reads the two spellings of a name only, Windows any
		[desktop, 'docker-desktop', { Https_Proxy: proxy }, 'linux'],
		[desktop, 'docker-desktop', { ...secure, No_Proxy: 'docker.internal' }, 'win32'],
	];
	// [server, context, environment, platform, the variable named]
	const refused = [
		[desktop, 'docker-desktop', secure, 'linux', 'HTTPS_PROXY'],
		[desktop, 'docker-desktop', { https_proxy: proxy }, 'linux', 'https_proxy'],
		[desktop, 'docker-desktop', { HTTPS_PROXY: '', https_proxy: proxy }, 'linux', 'https_proxy'],
		[desktop, 'docker-desktop', { Https_Proxy: proxy }, 'win32', 'Https_Proxy'],
		[plain, 'docker-desktop', { HTTP_PROXY: proxy }, 'linux', 'HTTP_PROXY'],
		['https://LOCALHOST:8443', 'rancher-desktop', secure, 'linux', 'HTTPS_PROXY'],
		['https://0.0.0.0:6550', 'k3d-rr', secure, 'linux', 'HTTPS_PROXY'],
		['https://host.docker.internal:6550', 'k3d-rr', secure, 'linux', 'HTTPS_PROXY'],
		['https://192.168.49.2:8443', 'minikube', secure, 'linux', 'HTTPS_PROXY'],
		// An entry not read here names no host: a part of a name, a CIDR, a port
		[desktop, 'docker-desktop', { ...secure, NO_PROXY: 'cker.internal' }, 'linux', 'HTTPS_PROXY'],
		[desktop, 'docker-desktop', { ...secure, NO_PROXY: '127.0.0.0/8' }, 'linux', 'HTTPS_PROXY'],
		[desktop, 'docker-desktop', { ...secure, NO_PROXY: 'kubernetes.docker.internal:6443' }, 'linux', 'HTTPS_PROXY'],
		// A domain names host names only, never the tail of an address
		['https://192.168.49.2:8443', 'minikube', { ...secure, NO_PROXY: '168.49.2' }, 'linux', 'HTTPS_PROXY'],
		['https://0.0.0.0:6550', 'k3d-rr', { ...secure, NO_PROXY: '.0.0' }, 'linux', 'HTTPS_PROXY'],
		// no_proxy counts only when NO_PROXY is not set
		[desktop, 'docker-desktop', { ...secure, NO_PROXY: 'example.com', no_proxy: '*' }, 'linux', 'HTTPS_PROXY'],
	];
	for (const [server, name, env, platform] of direct) {
		const d = cluster({ current: context(name), server, env, platform, found: null });
		assert.strictEqual(d, null, `${server} ${JSON.stringify(env)} ${platform}`);
	}
	for (const [server, name, env, platform, variable] of refused) {
		const d = cluster({ current: context(name), server, env, platform, found: null });
		assert.ok(d, `${server} ${JSON.stringify(env)} ${platform}`);
		const said = formatDiagnosis('nodes:test --runtime=k8s', d);
		assert.match(said, new RegExp(`context ${name} reaches \\S+ through the proxy in ${variable}:`), said);
		// The variable is named, never its value
		assert.ok(!/secret|proxy\.example/.test(said), said);
	}
	const login = 'https://admin:s3cret@kubernetes.docker.internal:6443';
	const d = cluster({ server: login, env: secure, platform: 'linux', found: null });
	const fix = 'Add kubernetes.docker.internal to NO_PROXY, or unset HTTPS_PROXY: here or in dist/server/.env';
	assert.strictEqual(d.fix[0], fix);
	assert.ok(!/admin|s3cret/.test(formatDiagnosis('nodes:test --runtime=k8s', d)));
});

test('a local cluster with its namespace misses nothing', () => {
	assert.strictEqual(cluster(), null);
	// Before the cluster is asked anything, the context alone is judged
	assert.strictEqual(cluster({ found: null }), null);
});

test('no kubectl names where to get one', () => {
	const d = cluster({ current: { code: -1, stdout: '', stderr: 'Error: spawn kubectl ENOENT' } });
	assert.match(d.problem, /kubectl is not installed/);
	assert.match(d.fix.join('\n'), /kubernetes\.io\/docs\/tasks\/tools[\s\S]*Enable Kubernetes/);
});

test('no current context asks for one', () => {
	const d = cluster({ current: { code: 1, stdout: '', stderr: 'error: current-context is not set\n' } });
	assert.match(d.problem, /no current context/);
	assert.match(d.fix.join('\n'), /use-context docker-desktop[\s\S]*RR_K8S_CONTEXT/);
});

test('a cluster that is not on this machine is refused before it is asked anything', () => {
	for (const name of ['prod', 'gke_project_europe-west1_tasks', 'arn:aws:eks:eu-west-1:1:cluster/tasks']) {
		const d = cluster({ current: context(name), found: null });
		assert.match(d.problem, /is not a cluster on this machine/);
		assert.ok(d.problem.includes(name));
		assert.match(d.fix.join('\n'), /docker-desktop, kind-\*, k3d-\*, minikube, rancher-desktop or orbstack/);
	}
});

test('RR_K8S_CONTEXT is the context judged, whatever the current one is', () => {
	assert.strictEqual(cluster({ context: 'kind-dev', current: context('prod') }), null);
	assert.match(cluster({ context: 'prod' }).problem, /context prod is not a cluster on this machine/);
	// It also stands in for a current context that is not set
	assert.strictEqual(cluster({ context: 'minikube', current: { code: 1, stderr: 'not set' } }), null);
});

test('a missing namespace names the command that creates it', () => {
	const found = { code: 1, stdout: '', stderr: 'Error from server (NotFound): namespaces "rr" not found\n' };
	const d = cluster({ context: 'kind-dev', namespace: 'rr', found });
	assert.match(d.problem, /namespace rr does not exist in kind-dev/);
	assert.strictEqual(d.fix[0], 'kubectl --context kind-dev create namespace rr');
	assert.match(d.fix[1], /RR_K8S_NAMESPACE/);
});

test('a cluster that does not answer is not a missing namespace', () => {
	const found = { code: 1, stdout: '', stderr: 'Unable to connect to the server: dial tcp 127.0.0.1:6443\nmore' };
	const d = cluster({ found });
	assert.match(d.problem, /cluster of the context docker-desktop does not answer/);
	assert.match(d.fix[0], /Kubernetes running/);
	assert.strictEqual(d.fix.at(-1), 'kubectl said: Unable to connect to the server: dial tcp 127.0.0.1:6443');
	assert.strictEqual(cluster({ current: context('minikube'), found }).fix[0], 'Start the cluster');
});

test('an instance id as the runtime labels its Jobs with it', () => {
	const id = 'nodes-test-0b9f7f0e-6d0c-4d1a-9d6e-5a0f3a2b1c4d';
	assert.strictEqual(k8sLabelValue(id), id);
	assert.strictEqual(k8sLabelValue('east_5565'), 'east_5565');
	// Changed: the same values as label_value in test_launcher_k8s.py
	assert.strictEqual(k8sLabelValue('host-a:5565'), 'host-a_5565-7fbe1a96');
	assert.strictEqual(k8sLabelValue('east:5565'), 'east_5565-789c0f9c');
	// A kept value never looks like a changed one
	assert.strictEqual(k8sLabelValue('host-a_5565-7fbe1a96'), 'host-a_5565-7fbe1a96-d649d93d');
	assert.strictEqual(k8sLabelValue('.hidden.'), 'hidden-348b7a80');
	assert.strictEqual(k8sLabelValue('x'.repeat(70)), 'x'.repeat(54) + '-c71bd109');
	assert.strictEqual(k8sLabelValue('x'.repeat(63) + 'y'.repeat(7)), 'x'.repeat(54) + '-6de36d0d');
	assert.strictEqual(k8sLabelValue('x'.repeat(62) + '..'), 'x'.repeat(54) + '-75685c1d');
	assert.strictEqual(k8sLabelValue('x'.repeat(53) + '.' + 'x'.repeat(20)), 'x'.repeat(53) + '.-3d862e46');
	assert.strictEqual(k8sLabelValue('a\u{1f600}b'), 'a_b-6fba5b2e');
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
