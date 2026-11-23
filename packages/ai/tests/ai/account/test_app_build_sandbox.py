"""The app compiler cannot read or write outside its job/toolchain grant."""

import json
import os
import shutil
import socket
import subprocess
import sys

import pytest

from ai.account import app_build_sandbox as sandbox


def test_hosted_build_cannot_disable_the_boundary(monkeypatch):
    monkeypatch.setattr(sys, 'argv', ['engine', 'ai/eaas.py', '--saas'])
    monkeypatch.setenv('RR_APP_BUILD_SANDBOX', 'off')
    with pytest.raises(sandbox.SandboxUnavailable, match='hosted app builds require'):
        sandbox.required()


@pytest.mark.parametrize('flag', ['--saas', '--hosted', '--shared-host'])
def test_hosted_boundary_is_required_without_configuration(monkeypatch, flag):
    monkeypatch.setattr(sys, 'argv', ['engine', flag])
    monkeypatch.delenv('RR_APP_BUILD_SANDBOX', raising=False)
    assert sandbox.required()


def test_misspelled_configuration_cannot_silently_disable_isolation(monkeypatch):
    monkeypatch.setenv('RR_APP_BUILD_SANDBOX', 'require')
    with pytest.raises(sandbox.SandboxUnavailable, match='must be required or off'):
        sandbox.required()


def test_required_boundary_refuses_an_unavailable_provider(monkeypatch, tmp_path):
    job, tools = tmp_path / 'job', tmp_path / 'tools'
    job.mkdir()
    tools.mkdir()
    monkeypatch.setenv('RR_APP_BUILD_SANDBOX', 'required')
    monkeypatch.setattr(sys, 'platform', 'linux')
    monkeypatch.setattr(shutil, 'which', lambda _: None)
    with pytest.raises(sandbox.SandboxUnavailable, match='bubblewrap is required'):
        sandbox.command([sys.executable, '-c', 'pass'], str(job), str(job), str(tools))


def test_required_boundary_refuses_an_outside_cwd(monkeypatch, tmp_path):
    job, tools, outside = [tmp_path / name for name in ('job', 'tools', 'outside')]
    for directory in (job, tools, outside):
        directory.mkdir()
    monkeypatch.setenv('RR_APP_BUILD_SANDBOX', 'required')
    with pytest.raises(sandbox.SandboxUnavailable, match='roots are not isolated'):
        sandbox.command([sys.executable], str(outside), str(job), str(tools))


@pytest.mark.skipif(sys.platform == 'win32', reason='a double quote is not a legal Windows filename')
def test_policy_paths_cannot_inject_an_allow_rule(monkeypatch, tmp_path):
    job = tmp_path / 'job ")(allow default)("'
    tools = tmp_path / 'tools'
    job.mkdir()
    tools.mkdir()
    monkeypatch.setenv('RR_APP_BUILD_SANDBOX', 'required')
    monkeypatch.setattr(sys, 'platform', 'darwin')
    isfile = os.path.isfile
    monkeypatch.setattr(os.path, 'isfile', lambda p: p == '/usr/bin/sandbox-exec' or isfile(p))
    command = sandbox.command([sys.executable], str(job), str(job), str(tools))
    profile = command[command.index('-p') + 1]
    assert '(subpath ' + json.dumps(os.path.realpath(job)) + ')' in profile
    assert '(subpath "' + str(job) + '")' not in profile


def _platform_node():
    node = os.environ.get('RR_BUILD_NODE') or shutil.which('node')
    if not node:
        if os.environ.get('RR_TEST_APP_COMPILERS') == '1':
            pytest.fail('Node is required for the live compiler gate (RR_TEST_APP_COMPILERS=1)')
        pytest.skip('Node is required for the real compiler boundary probe')
    result = subprocess.run([node, '-p', 'process.execPath'], text=True, capture_output=True, check=True, timeout=30)
    return result.stdout.strip()


@pytest.mark.integration
def test_real_boundary_denies_outside_reads_symlinks_and_toolchain_writes(monkeypatch, tmp_path):
    if sys.platform == 'darwin' and os.environ.get('RR_TEST_APP_COMPILERS') != '1':
        pytest.skip('opt in with RR_TEST_APP_COMPILERS=1 and a standalone platform Node')
    if sys.platform.startswith('linux') and not shutil.which('bwrap'):
        if os.environ.get('RR_TEST_APP_COMPILERS') == '1':
            pytest.fail('bubblewrap is required for the live compiler gate')
        pytest.skip('bubblewrap is not installed')
    if sys.platform != 'darwin' and not sys.platform.startswith('linux'):
        pytest.skip('no app build filesystem provider for this platform')
    job, tools = tmp_path / 'job', tmp_path / 'tools'
    job.mkdir()
    tools.mkdir()
    (job / 'inside.txt').write_text('inside')
    (tools / 'platform.txt').write_text('read-only')
    secret = tmp_path / 'another-tenant-secret.txt'
    secret.write_text('never expose this marker')
    (job / 'escape.txt').symlink_to(secret)
    monkeypatch.setenv('RR_APP_BUILD_SANDBOX', 'required')
    script = """
const fs = require('node:fs');
const [job, tools, secret] = process.argv.slice(1);
const probe = fn => { try { fn(); return true; } catch { return false; } };
const result = {
  insideRead: probe(() => fs.readFileSync(job + '/inside.txt')),
  platformRead: probe(() => fs.readFileSync(tools + '/platform.txt')),
  jobWrite: probe(() => fs.writeFileSync(job + '/output.txt', 'ok')),
  outsideRead: probe(() => fs.readFileSync(secret)),
  symlinkRead: probe(() => fs.readFileSync(job + '/escape.txt')),
  toolchainWrite: probe(() => fs.writeFileSync(tools + '/platform.txt', 'poisoned')),
};
console.log(JSON.stringify(result));
"""
    argv = [_platform_node(), '-e', script, str(job), str(tools), str(secret)]
    wrapped = sandbox.command(argv, str(job), str(job), str(tools))
    result = subprocess.run(wrapped, cwd=job, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        'insideRead': True,
        'platformRead': True,
        'jobWrite': True,
        'outsideRead': False,
        'symlinkRead': False,
        'toolchainWrite': False,
    }
    assert (tools / 'platform.txt').read_text() == 'read-only'


@pytest.mark.integration
def test_real_boundary_cannot_connect_to_host_loopback(monkeypatch, tmp_path):
    if sys.platform == 'darwin' and os.environ.get('RR_TEST_APP_COMPILERS') != '1':
        pytest.skip('opt in with RR_TEST_APP_COMPILERS=1 and a standalone platform Node')
    if sys.platform.startswith('linux') and not shutil.which('bwrap'):
        if os.environ.get('RR_TEST_APP_COMPILERS') == '1':
            pytest.fail('bubblewrap is required for the live compiler gate')
        pytest.skip('bubblewrap is not installed')
    if sys.platform != 'darwin' and not sys.platform.startswith('linux'):
        pytest.skip('no app build filesystem provider for this platform')
    job, tools = tmp_path / 'job', tmp_path / 'tools'
    job.mkdir()
    tools.mkdir()
    monkeypatch.setenv('RR_APP_BUILD_SANDBOX', 'required')
    script = """
const net = require('node:net');
const socket = net.connect({host: '127.0.0.1', port: Number(process.argv[1])});
socket.setTimeout(500);
socket.once('connect', () => { console.log('connected'); socket.destroy(); });
socket.once('error', () => { console.log('denied'); socket.destroy(); });
socket.once('timeout', () => { console.log('denied'); socket.destroy(); });
"""
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        argv = [_platform_node(), '-e', script, str(listener.getsockname()[1])]
        wrapped = sandbox.command(argv, str(job), str(job), str(tools))
        result = subprocess.run(wrapped, cwd=job, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'denied'


_SPOOF = 'bwrap: No permissions to create new namespace.ts(1,12): error TS1109: Expression expected.\n'


@pytest.mark.parametrize(
    'argv,code,output,started,expected',
    [
        # bwrap is judged by its own status, not by its text: no child pid and a non-zero exit is a startup failure.
        (
            ['/usr/bin/bwrap', '--', 'node'],
            1,
            'bwrap: No permissions to create new namespace\n',
            False,
            'No permissions to create new namespace',
        ),
        (['/usr/bin/bwrap'], 1, '', False, 'bwrap exited with status 1 before the sandbox started'),
        # The sandbox started: whatever the compiler printed, even a line shaped like bwrap's, is its own result.
        (['/usr/bin/bwrap'], 1, _SPOOF, True, None),
        (['/usr/bin/bwrap'], 1, 'bwrap: No permissions to create new namespace\n', True, None),
        (['/usr/bin/bwrap'], 0, 'bwrap: noise on a successful run\n', False, None),
        # Without the status channel nothing can be decided for bwrap.
        (['/usr/bin/bwrap'], 1, 'bwrap: No permissions to create new namespace\n', None, None),
        (['/usr/bin/node', 'tsc'], 1, 'bwrap: written by the app itself\n', False, None),
        # sandbox-exec has no such channel: only pure provider lines count, and never a compiler diagnostic.
        (
            ['/usr/bin/sandbox-exec', '-p', 'x'],
            71,
            'sandbox-exec: sandbox_apply: Operation not permitted\n',
            None,
            'sandbox_apply: Operation not permitted',
        ),
        (['/usr/bin/sandbox-exec'], 1, "sandbox-exec: x.ts(1,1): error TS1005: ';' expected.\n", None, None),
        (
            ['/usr/bin/sandbox-exec'],
            1,
            "src/a.ts(1,1): error TS2304: Cannot find name 'x'.\nsandbox-exec: y\n",
            None,
            None,
        ),
        (['/usr/bin/sandbox-exec'], 0, 'sandbox-exec: noise\n', None, None),
    ],
)
def test_a_sandbox_that_cannot_start_is_not_a_compile_error(argv, code, output, started, expected):
    assert sandbox.startup_failure(argv, code, output, started) == expected


def _exec_stub(monkeypatch, app_build, code, output, report_pid):
    """Replace the process seam; a started bwrap writes its child pid to the status fd it was given."""
    seen = {}

    async def fake_exec(argv, cwd, timeout, on_line=None, pass_fds=()):
        seen['argv'] = argv
        if report_pid and '--info-fd' in argv:
            flag = argv.index('--info-fd')
            assert int(argv[flag + 1]) in pass_fds
            os.write(int(argv[flag + 1]), b'{"child-pid": 4242}')
        return code, output

    monkeypatch.setattr(app_build, '_exec', fake_exec)
    return seen


@pytest.mark.skipif(os.name == 'nt', reason='bwrap and its --info-fd status channel are POSIX-only')
async def test_exec_compiler_raises_an_infrastructure_failure_when_the_sandbox_cannot_start(monkeypatch, tmp_path):
    from ai.account import app_build

    job, tools = tmp_path / 'job', tmp_path / 'tools'
    job.mkdir()
    tools.mkdir()
    monkeypatch.setattr(
        app_build.app_build_sandbox, 'command', lambda argv, cwd, job_dir, env_dir: ['/usr/bin/bwrap', '--', *argv]
    )
    errors = []
    monkeypatch.setattr(app_build, 'error', errors.append)
    _exec_stub(
        monkeypatch, app_build, 1, 'bwrap: No permissions to create new namespace at /srv/host/path\n', report_pid=False
    )
    with pytest.raises(app_build.BuildInfraFailure) as raised:
        await app_build._exec_compiler(['/usr/bin/node', 'rsbuild'], str(job), 5, str(job), str(tools))
    assert raised.value.phase == 'sandbox'
    # The developer sees a fixed message; the provider's text (host paths) goes only to the operator log.
    assert 'could not start' in str(raised.value)
    assert '/srv/host/path' not in str(raised.value) and 'namespace' not in str(raised.value)
    assert any('/srv/host/path' in line for line in errors)


@pytest.mark.skipif(os.name == 'nt', reason='bwrap and its --info-fd status channel are POSIX-only')
async def test_a_compile_error_that_names_bwrap_stays_a_compile_error(monkeypatch, tmp_path):
    from ai.account import app_build

    job, tools = tmp_path / 'job', tmp_path / 'tools'
    job.mkdir()
    tools.mkdir()
    monkeypatch.setattr(
        app_build.app_build_sandbox, 'command', lambda argv, cwd, job_dir, env_dir: ['/usr/bin/bwrap', '--', *argv]
    )
    # An app file named like bwrap's message makes tsc print exactly one provider-shaped line.
    seen = _exec_stub(monkeypatch, app_build, 2, _SPOOF, report_pid=True)
    result = await app_build._exec_compiler(['/usr/bin/node', 'tsc'], str(job), 5, str(job), str(tools))
    assert result == (2, _SPOOF)
    assert '--info-fd' in seen['argv']  # bwrap was asked to report its own start


async def test_exec_compiler_passes_other_results_through(monkeypatch, tmp_path):
    from ai.account import app_build

    job, tools = tmp_path / 'job', tmp_path / 'tools'
    job.mkdir()
    tools.mkdir()
    monkeypatch.setattr(
        app_build.app_build_sandbox, 'command', lambda argv, cwd, job_dir, env_dir: ['/usr/bin/bwrap', '--', *argv]
    )
    _exec_stub(monkeypatch, app_build, 0, 'ok\n', report_pid=True)
    assert await app_build._exec_compiler(['/usr/bin/node', 'tsc'], str(job), 5, str(job), str(tools)) == (0, 'ok\n')
