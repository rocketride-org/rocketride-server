// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * What the container tasks need from Docker and WSL, and what to do when a
 * piece is missing.
 *
 * tasks.js gathers the facts (`docker info`, `wsl.exe -l -v`, a probe run
 * inside the distribution); the functions here only read them, so every case
 * is testable on any OS. A diagnosis is `{ problem, fix }` — what is missing
 * and the lines that add it — or null when nothing is.
 */

const ENGINE_INSTALL_URL = 'https://docs.docker.com/engine/install/ubuntu/';
const DESKTOP_INSTALL_URL = {
	win32: 'https://docs.docker.com/desktop/setup/install/windows-install/',
	darwin: 'https://docs.docker.com/desktop/setup/install/mac-install/',
};

// wsl.exe writes its own messages in UTF-16 unless WSL_UTF8=1: either way, drop the NULs
const NUL = String.fromCharCode(0);
const BOM = String.fromCharCode(0xfeff);
const WSL_ENV = { WSL_UTF8: '1' };

// Run inside the distribution as `sh -s -- <checkout>`: one KEY=value per line
const WSL_PROBE_SCRIPT = [
	// A failed `.` ends a POSIX shell, so read the file only when it is there
	'if [ -r /etc/os-release ]; then . /etc/os-release; fi; echo "VERSION_ID=$VERSION_ID"',
	'cli=$(command -v docker 2>/dev/null); echo "CLI=$cli"',
	'case "$(readlink -f "$cli" 2>/dev/null)" in',
	'*docker-desktop*) echo DESKTOP_CLI=yes;; *) echo DESKTOP_CLI=no;; esac',
	'if command -v dockerd >/dev/null 2>&1; then echo ENGINE=yes; else echo ENGINE=no; fi',
	'if [ -d /run/systemd/system ]; then echo SYSTEMD=yes; else echo SYSTEMD=no; fi',
	'info=$(docker info --format "{{.ID}} {{.OperatingSystem}}" 2>&1); echo "INFO_RC=$?"',
	'echo "INFO=$(printf "%s" "$info" | head -n 2 | tr "\\n" " ")"',
	'if [ -n "$1" ]; then',
	'if git -C "$1" rev-parse --git-dir >/dev/null 2>&1; then echo CHECKOUT=yes; else echo CHECKOUT=no; fi; fi',
	'',
].join('\n');

/**
 * Text from wsl.exe, whatever encoding it chose.
 * @param {string} text - Raw output
 * @returns {string} The text without NULs and BOM
 */
function wslText(text) {
	const clean = String(text || '')
		.split(NUL)
		.join('');
	return clean.startsWith(BOM) ? clean.slice(1) : clean;
}

/**
 * The distributions of `wsl.exe -l -v`.
 * @param {string} text - Its output
 * @returns {{name: string, state: string, version: string, isDefault: boolean}[]}
 */
function parseWslList(text) {
	const distros = [];
	for (const line of wslText(text).split(/\r?\n/)) {
		const m = line.match(/^\s*(\*?)\s*(\S+)\s+(\S+)\s+(\d+)\s*$/);
		if (m) distros.push({ name: m[2], state: m[3], version: m[4], isDefault: m[1] === '*' });
	}
	return distros;
}

/**
 * The KEY=value lines WSL_PROBE_SCRIPT prints.
 * @param {string} text - Its output
 * @returns {Object<string, string>}
 */
function parseFacts(text) {
	const facts = {};
	for (const line of wslText(text).split(/\r?\n/)) {
		const m = line.match(/^([A-Z_]+)=(.*)$/);
		if (m) facts[m[1]] = m[2].trim();
	}
	return facts;
}

/**
 * The daemon the local docker CLI talks to: Docker Desktop on Windows and macOS.
 * @param {object} p
 * @param {string} p.platform - os.platform()
 * @param {number} p.code - Exit code of `docker info --format {{.OSType}}`, -1 when docker did not start
 * @param {string} [p.stdout]
 * @param {string} [p.stderr]
 * @returns {{problem: string, fix: string[]}|null}
 */
function diagnoseLocalDocker({ platform, code, stdout = '', stderr = '' }) {
	const desktop = platform !== 'linux';
	if (code === -1 || /ENOENT/.test(stderr)) {
		return desktop
			? {
					problem: 'docker is not installed',
					fix: [`Install Docker Desktop: ${DESKTOP_INSTALL_URL[platform] || DESKTOP_INSTALL_URL.darwin}`],
				}
			: {
					problem: 'docker is not installed',
					fix: [
						`Install Docker Engine: ${ENGINE_INSTALL_URL}`,
						'then: sudo usermod -aG docker $USER && sudo systemctl enable --now docker, and log in again',
					],
				};
	}
	if (code !== 0) {
		if (!desktop && /permission denied/i.test(stderr)) {
			return {
				problem: 'this user may not use the docker daemon',
				fix: ['sudo usermod -aG docker $USER, then log in again'],
			};
		}
		return desktop
			? { problem: 'Docker Desktop is not running', fix: ['Start Docker Desktop and wait for "Engine running"'] }
			: { problem: 'the docker daemon does not answer', fix: ['sudo systemctl start docker'] };
	}
	if (stdout.trim() === 'windows') {
		return {
			problem: 'Docker Desktop runs Windows containers; the node image is a Linux one',
			fix: ['Switch to Linux containers: Docker Desktop tray icon → Switch to Linux containers'],
		};
	}
	return null;
}

/**
 * The WSL side of the Windows tasks, in the order its pieces depend on each other.
 * @param {object} p
 * @param {string} p.distro - The distribution the task uses
 * @param {{code: number, stdout: string, stderr: string}} p.list - `wsl.exe -l -v`
 * @param {Object<string, string>|null} p.facts - parseFacts() of the probe, or null when it did not run
 * @param {string} [p.probeError] - What the probe printed when it failed
 * @param {boolean} [p.needJammy] - The image is built in it: the distribution must be Ubuntu 22.04
 * @param {string} [p.checkout] - The checkout the task builds in
 * @returns {{problem: string, fix: string[]}|null}
 */
function diagnoseWsl({ distro, list, facts, probeError = '', needJammy = false, checkout = '' }) {
	const listText = wslText(`${list.stdout}\n${list.stderr}`).trim();
	if (list.code !== 0 && !/no installed distributions/i.test(listText)) {
		return {
			problem: 'WSL is not installed or does not start',
			fix: [
				'In an elevated PowerShell: wsl --install --no-distribution, then restart Windows',
				...(listText ? [`wsl.exe said: ${listText.split(/\r?\n/)[0]}`] : []),
			],
		};
	}

	const distros = parseWslList(list.stdout);
	const found = distros.find((d) => d.name.toLowerCase() === distro.toLowerCase());
	if (!found) {
		const installed = distros.map((d) => d.name).join(', ') || 'none';
		return {
			problem: `WSL distribution ${distro} is not installed (installed: ${installed})`,
			fix: [
				'wsl --install -d Ubuntu-22.04, then open it once to create your user',
				'or name an installed Ubuntu 22.04 with --distro= or RR_WSL_DISTRO',
			],
		};
	}
	if (found.version !== '2') {
		return { problem: `${distro} runs on WSL 1, and docker needs WSL 2`, fix: [`wsl --set-version ${distro} 2`] };
	}
	if (!facts) {
		return {
			problem: `${distro} does not start`,
			fix: [
				`Open it once (wsl -d ${distro}): a new distribution asks for a user first`,
				...(probeError ? [`wsl.exe said: ${wslText(probeError).trim().split(/\r?\n/)[0]}`] : []),
			],
		};
	}
	if (needJammy && facts.VERSION_ID !== '22.04') {
		return {
			problem:
				`${distro} is Ubuntu ${facts.VERSION_ID || '?'}; the image base is 22.04 (jammy), ` +
				'and an engine built on a newer glibc does not start in it',
			fix: ['wsl --install -d Ubuntu-22.04, and pass --distro=Ubuntu-22.04 (or set RR_WSL_DISTRO)'],
		};
	}
	if (checkout && facts.CHECKOUT !== 'yes') {
		return {
			problem: `${checkout} in ${distro} is not a git checkout`,
			fix: [
				`Clone rocketride-server there and build it (./builder build --verbose)`,
				'or point --checkout= / RR_WSL_CHECKOUT at the clone you have',
			],
		};
	}

	// With the integration turned off, Docker Desktop leaves a `docker` that only says so
	const desktopStub = /could not be found in this WSL 2 distro/i.test(facts.INFO || '');
	if (!facts.CLI || desktopStub) {
		return {
			problem: `${distro} has no docker`,
			fix: [
				"Either turn on Docker Desktop's WSL integration (one daemon for both sides, nothing to copy later):",
				`  Docker Desktop → Settings → Resources → WSL integration → ${distro} → Apply & restart`,
				`or install Docker Engine in ${distro} (its own daemon; sync-from-wsl then copies the image, ~6 GB):`,
				`  ${ENGINE_INSTALL_URL}`,
				`  then in ${distro}: sudo usermod -aG docker $USER && sudo systemctl enable --now docker`,
				`  and in PowerShell: wsl --terminate ${distro}`,
			],
		};
	}
	if (facts.INFO_RC !== '0') {
		const said = facts.INFO ? [`docker said: ${facts.INFO}`] : [];
		if (/permission denied/i.test(facts.INFO || '')) {
			return {
				problem: `your user in ${distro} may not use its docker daemon`,
				fix: [
					`In ${distro}: sudo usermod -aG docker $USER`,
					`then in PowerShell: wsl --terminate ${distro}`,
					...said,
				],
			};
		}
		if (facts.DESKTOP_CLI === 'yes') {
			return {
				problem: `docker in ${distro} is Docker Desktop's, and Docker Desktop does not answer`,
				fix: ['Start Docker Desktop and wait for "Engine running"', ...said],
			};
		}
		if (facts.ENGINE === 'yes') {
			const start = facts.SYSTEMD === 'yes' ? 'sudo systemctl start docker' : 'sudo service docker start';
			return {
				problem: `Docker Engine is installed in ${distro}, but its daemon is stopped`,
				fix: [
					`wsl -d ${distro} -- ${start}`,
					`or turn on Docker Desktop's WSL integration for ${distro} instead`,
					...said,
				],
			};
		}
		return {
			problem: `no docker daemon answers in ${distro}`,
			fix: [
				`Turn on Docker Desktop's WSL integration for ${distro}, or install and start Docker Engine there`,
				...said,
			],
		};
	}
	return null;
}

/**
 * What to do when the node image is not on the daemon.
 * @param {string} platform - os.platform()
 * @param {string} image - The image the docker runtime starts
 * @returns {{problem: string, fix: string[]}}
 */
function missingImage(platform, image) {
	if (platform === 'win32') {
		return {
			problem: `${image} is not on Docker Desktop's daemon`,
			fix: [
				'.\\builder container:build-on-wsl --checkout=<the rocketride-server checkout in WSL>',
				'.\\builder container:sync-from-wsl   (when WSL runs a daemon of its own)',
			],
		};
	}
	if (platform === 'linux') return { problem: `${image} is not on this daemon`, fix: ['./builder container:build'] };
	return { problem: `${image} is not on this daemon`, fix: [`docker pull ${image}`] };
}

const ENGINES = { win32: 'a Windows engine', darwin: 'a macOS engine' };

/**
 * Why a container task does not run on this OS; the registry puts
 * "<task> is not available on <OS>: " in front. No other task is offered in
 * its place: the ones that run here are in `builder --help`, with what they need.
 * @param {string} task - The task's name
 * @param {string} platform - os.platform()
 * @returns {string}
 */
function unavailableReason(task, platform) {
	const help = `See ${platform === 'win32' ? '.\\builder' : './builder'} --help for the container tasks here`;
	const engine = ENGINES[platform] || `a ${platform} engine`;
	switch (task) {
		case 'container:build':
			return `it builds the image from this tree's dist/server, and dist/server here is ${engine}. ${help}`;
		case 'container:test':
			return (
				"it builds and tests the image from this tree's dist/server, " +
				`and dist/server here is ${engine}. ${help}`
			);
		case 'container:build-on-wsl':
			return 'it runs a build inside a WSL distribution, and WSL exists only on Windows';
		case 'container:sync-from-wsl':
			return "it copies the image from a WSL distribution's daemon, and WSL exists only on Windows";
		default:
			return '';
	}
}

/**
 * The text a task fails with: what is missing, then how to add it.
 * @param {string} taskName - The task that needs it
 * @param {{problem: string, fix: string[]}} diagnosis
 * @returns {string}
 */
function formatDiagnosis(taskName, { problem, fix }) {
	return [`${taskName}: ${problem}.`, ...fix.map((line) => `  ${line}`)].join('\n');
}

module.exports = {
	WSL_ENV,
	WSL_PROBE_SCRIPT,
	wslText,
	parseWslList,
	parseFacts,
	diagnoseLocalDocker,
	diagnoseWsl,
	missingImage,
	unavailableReason,
	formatDiagnosis,
};
