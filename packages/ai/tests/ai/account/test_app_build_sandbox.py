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


@pytest.mark.skipif(sys.platform == 'win32', reason='a quote is not a legal Windows file name character')
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
        pytest.skip('Node is required for the real compiler boundary probe')
    result = subprocess.run([node, '-p', 'process.execPath'], text=True, capture_output=True, check=True)
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


@pytest.mark.parametrize(
    'argv,code,output,expected',
    [
        (
            ['/usr/bin/bwrap', '--', 'node'],
            1,
            'bwrap: No permissions to create new namespace\n',
            'No permissions to create new namespace',
        ),
        (
            ['/usr/bin/sandbox-exec', '-p', 'x'],
            71,
            'sandbox-exec: sandbox_apply: Operation not permitted\n',
            'sandbox_apply: Operation not permitted',
        ),
        (['/usr/bin/bwrap'], 1, "src/a.ts(1,1): error TS2304: Cannot find name 'x'.\n", None),
        (['/usr/bin/bwrap'], 0, 'bwrap: noise on a successful run\n', None),
        (['/usr/bin/node', 'tsc'], 1, 'bwrap: written by the app itself\n', None),
        # A compiler line that begins like the provider's, after other output, stays a compile error.
        (
            ['/usr/bin/bwrap'],
            1,
            "src/a.ts(1,1): error TS2304: Cannot find name 'x'.\nbwrap: x.ts(1,1): error TS1005: ';' expected.\n",
            None,
        ),
        (
            ['/usr/bin/sandbox-exec'],
            1,
            "bwrap: x.ts(1,1): error TS1005: ';' expected.\nsrc/a.ts(2,1): error TS2304: Cannot find name 'y'.\n",
            None,
        ),
    ],
)
def test_a_sandbox_that_cannot_start_is_not_a_compile_error(argv, code, output, expected):
    assert sandbox.startup_failure(argv, code, output) == expected


async def test_exec_compiler_raises_an_infrastructure_failure_when_the_sandbox_cannot_start(monkeypatch, tmp_path):
    from ai.account import app_build

    job, tools = tmp_path / 'job', tmp_path / 'tools'
    job.mkdir()
    tools.mkdir()
    monkeypatch.setattr(
        app_build.app_build_sandbox, 'command', lambda argv, cwd, job_dir, env_dir: ['/usr/bin/bwrap', '--', *argv]
    )

    async def fake_exec(argv, cwd, timeout, on_line=None):
        return 1, 'bwrap: No permissions to create new namespace\n'

    monkeypatch.setattr(app_build, '_exec', fake_exec)
    with pytest.raises(app_build.BuildInfraFailure) as raised:
        await app_build._exec_compiler(['/usr/bin/node', 'rsbuild'], str(job), 5, str(job), str(tools))
    assert raised.value.phase == 'sandbox'
    assert 'No permissions to create new namespace' in str(raised.value)

    async def compile_error(argv, cwd, timeout, on_line=None):
        return 2, "error TS2304: Cannot find name 'x'.\n"

    monkeypatch.setattr(app_build, '_exec', compile_error)
    assert await app_build._exec_compiler(['/usr/bin/node', 'tsc'], str(job), 5, str(job), str(tools)) == (
        2,
        "error TS2304: Cannot find name 'x'.\n",
    )
