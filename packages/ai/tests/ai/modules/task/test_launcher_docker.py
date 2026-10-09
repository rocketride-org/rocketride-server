# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.


"""
Unit tests for the docker runtime (``ai.modules.task.launcher.docker``) — T1b.

The ``DockerLauncher`` runs against a fake CLI that records the argv of every
command and returns canned output and exit codes; no daemon is needed. Pinned
here: the five-command lifecycle, ``create -i`` and never ``-t``, the task file
as a tar stream, the address in both modes, the environment as names only, the
exit code from ``docker wait``, ``rm -f`` on a failure at any step, the startup
sweep once per process, the store mount and its refusals, and the sampler.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import tarfile
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from ai.modules.task.launcher import LaunchSpec, create_launcher
from ai.modules.task.launcher import docker as dk
from ai.modules.task.launcher.docker import (
    CliResult,
    DockerError,
    DockerLauncher,
    DockerStatsSampler,
    StoreUnavailableError,
    docker_config,
    is_host_only,
    parse_percent,
    parse_size,
    rewrite_loopback,
    task_tar,
)
from ai.modules.task.task_engine import pipeline_opens_store

LINUX_ENGINE = {'OSType': 'linux', 'OperatingSystem': 'Ubuntu 22.04.4 LTS'}
DOCKER_DESKTOP = {'OSType': 'linux', 'OperatingSystem': 'Docker Desktop (containerized)'}
TOKEN_SHA = 'a' * 64


class FakeProcess:
    """The attached ``docker start -a -i``: just a pid and a code."""

    def __init__(self, returncode=None):
        self.pid = 777
        self.returncode = returncode

    async def wait(self):
        if self.returncode is None:
            self.returncode = -9
        return self.returncode


class FakeCli:
    """Records every docker command; answers from ``responses`` keyed by the subcommand."""

    def __init__(self, info=None, **responses):
        self.calls = []
        self.attached = []
        self.responses = {
            'info': CliResult(0, json.dumps(info or LINUX_ENGINE), ''),
            'ps': CliResult(0, '', ''),
            'create': CliResult(0, 'c0ffee\n', ''),
            'cp': CliResult(0, '', ''),
            'inspect': self._inspect,
            'wait': CliResult(0, '42\n', ''),
            'run': CliResult(0, '', ''),
        }
        self.responses.update(responses)
        self.attach_error = None
        # What `inspect --format {{.State.Status}}` answers, in turn; the last one sticks
        self.states = ['running']
        self.networks = json.dumps({'bridge': {'IPAddress': '172.17.0.5'}})

    def _inspect(self, args):
        """Answer the two inspect queries the launcher makes."""
        if '{{.State.Status}}' in args:
            state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
            return CliResult(0, state + '\n', '')
        return CliResult(0, self.networks, '')

    async def run(self, args, *, stdin=None, env=None, check=True):
        self.calls.append(SimpleNamespace(args=list(args), stdin=stdin, env=env))
        response = self.responses.get(args[0], CliResult(0, '', ''))
        result = response(list(args)) if callable(response) else response
        if check and result.returncode != 0:
            raise DockerError(f'docker {args[0]} failed (exit {result.returncode}): {result.stderr}')
        return result

    async def attach(self, args):
        self.attached.append(list(args))
        if self.attach_error:
            raise self.attach_error
        return FakeProcess()

    def commands(self):
        """The subcommands run so far, in order."""
        return [call.args[0] for call in self.calls]

    def call(self, subcommand):
        """The single call of a subcommand."""
        (found,) = [call for call in self.calls if call.args[0] == subcommand]
        return found


def _server():
    """A stand-in for TaskServer's pool and config."""
    return SimpleNamespace(
        _config={'port': 5565},
        assign_port=MagicMock(return_value=20009),
        release_port=MagicMock(),
    )


def _config(**overrides):
    """The docker settings, with an explicit image so no engine version is needed."""
    values = dict(dk.DEFAULT_CONFIG, image='rocketride/node:3.4.0', instance='host-a:5565')
    values.update(overrides)
    return values


def _launcher(cli=None, environ=None, server=None, **config):
    """A DockerLauncher over a fake CLI."""
    return DockerLauncher(
        server or _server(),
        config=_config(**config),
        cli=cli or FakeCli(),
        environ=environ if environ is not None else {'PATH': '/usr/bin', 'HOME': '/home/eas'},
    )


def _spec(**overrides):
    """A LaunchSpec with every piece set."""
    values = dict(
        task_id='proj.src',
        task_file=b'{"type": "pipeline", "secret": "s3cr3t"}\n\n',
        token_sha256=TOKEN_SHA,
        env={
            'PATH': '/host/bin',
            'HOME': '/home/eas',
            'UV_CACHE_DIR': '/host/uv',
            'XDG_CACHE_HOME': '/home/eas/.cache',
            'LANG': 'C.UTF-8',
            'ROCKETRIDE_DB_DSN': 'postgresql://u:p%40ss@127.0.0.1:5432/tenant',
            'OPENAI_API_KEY': 'sk-secret',
            'MULTI': 'line one\nline two',
        },
        pipeline_args=['--threads=2'],
        modelserver='localhost:5590',
        hosted=True,
        trace_arg='--trace=debugOut',
        node_path_arg='--node_path=/ws/nodes',
    )
    values.update(overrides)
    return LaunchSpec(**values)


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def test_config_takes_server_config_over_environment_over_defaults(monkeypatch):
    monkeypatch.setattr(dk, 'engine_version', lambda: '3.4.0')
    cfg = docker_config(
        {'port': 5566, 'docker': {'memory': '4g'}},
        {'RR_DOCKER_MEMORY': '3g', 'RR_DOCKER_CPUS': '2', 'RR_DOCKER_PUBLISH': 'TRUE'},
    )
    assert cfg['memory'] == '4g'
    assert cfg['cpus'] == '2'
    assert cfg['publish'] == 'true'
    assert cfg['network'] == 'bridge'
    assert cfg['log_driver'] == 'none'


def test_config_image_is_the_engine_version_never_latest(monkeypatch):
    monkeypatch.setattr(dk, 'engine_version', lambda: '3.4.0')
    assert docker_config({}, {})['image'] == 'rocketride/node:3.4.0'


def test_engine_version_drops_the_build_number(monkeypatch):
    import rocketlib

    monkeypatch.setattr(rocketlib, 'getVersion', lambda: {'version': '3.4.0.9999'}, raising=False)
    assert dk.engine_version() == '3.4.0'


def test_config_instance_survives_a_restart(monkeypatch):
    """hostname:EAS port, not a per-process id, or the startup sweep matches nothing."""
    monkeypatch.setattr(dk, 'engine_version', lambda: '3.4.0')
    monkeypatch.setattr(dk.socket, 'gethostname', lambda: 'box')
    assert docker_config({'port': 5566}, {})['instance'] == 'box:5566'
    assert docker_config({'port': 5566}, {})['instance'] == docker_config({'port': 5566}, {})['instance']
    assert docker_config({}, {'RR_DOCKER_INSTANCE': 'eas-pod'})['instance'] == 'eas-pod'


def test_config_refuses_an_unknown_publish_value(monkeypatch):
    monkeypatch.setattr(dk, 'engine_version', lambda: '3.4.0')
    with pytest.raises(ValueError, match='publish'):
        docker_config({}, {'RR_DOCKER_PUBLISH': 'sometimes'})


# ---------------------------------------------------------------------------
# Address mode, from what the daemon is
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'info, environ, publish, expected',
    [
        (LINUX_ENGINE, {}, 'auto', False),
        (DOCKER_DESKTOP, {}, 'auto', True),
        ({'OSType': 'windows', 'OperatingSystem': 'Windows Server'}, {}, 'auto', True),
        (LINUX_ENGINE, {'DOCKER_HOST': 'tcp://10.0.0.5:2376'}, 'auto', True),
        (LINUX_ENGINE, {'DOCKER_HOST': 'ssh://builder'}, 'auto', True),
        (LINUX_ENGINE, {'DOCKER_HOST': 'unix:///var/run/docker.sock'}, 'auto', False),
        (LINUX_ENGINE, {}, 'true', True),
        (DOCKER_DESKTOP, {}, 'false', False),
    ],
)
def test_published_mode_follows_the_daemon_not_the_os(info, environ, publish, expected):
    assert _launcher(environ=environ, publish=publish).published_mode(info) is expected


# ---------------------------------------------------------------------------
# prepare(): docker info and the startup sweep, once
# ---------------------------------------------------------------------------


async def test_prepare_sweeps_this_instances_leftovers():
    cli = FakeCli(ps=CliResult(0, 'old1\nold2\n', ''))
    launcher = _launcher(cli)
    await launcher.prepare()
    assert cli.commands() == ['info', 'ps', 'rm']
    assert cli.call('ps').args == ['ps', '-aq', '--filter', 'label=rocketride.eas=host-a:5565']
    assert cli.call('rm').args == ['rm', '-f', 'old1', 'old2']
    assert launcher.published is False


async def test_prepare_runs_once_however_many_tasks_start():
    """The sweep never runs per task: it would remove the containers of running siblings."""
    cli = FakeCli()
    launcher = _launcher(cli)
    await asyncio.gather(launcher.prepare(), launcher.start(_spec()), launcher.start(_spec()))
    await launcher.start(_spec())
    assert cli.commands().count('info') == 1
    assert cli.commands().count('ps') == 1


async def test_prepare_failure_is_raised_and_retried():
    cli = FakeCli(info=None)
    cli.responses['info'] = CliResult(1, '', 'Cannot connect to the Docker daemon')
    launcher = _launcher(cli)
    with pytest.raises(DockerError, match='Cannot connect'):
        await launcher.prepare()
    cli.responses['info'] = CliResult(0, json.dumps(LINUX_ENGINE), '')
    await launcher.prepare()
    assert cli.commands().count('info') == 2


# ---------------------------------------------------------------------------
# The create call
# ---------------------------------------------------------------------------


async def test_create_is_interactive_never_a_tty_and_never_pulls():
    """-i or --autoterm ends the run at once; -t would make stdin close a hangup, not EOF."""
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    args = cli.call('create').args
    assert args[:2] == ['create', '-i']
    assert '-t' not in args and '--tty' not in args
    assert args[args.index('--pull') + 1] == 'never'


async def test_create_removes_itself_when_it_exits():
    """--rm: an engine that dies leaves no stopped container behind (its tasks end by --autoterm)."""
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    assert '--rm' in cli.call('create').args


async def test_a_container_already_run_and_removed_counts_as_started(monkeypatch):
    """It exited and --rm removed it before the poll: the CLI's own code is the container's."""
    monkeypatch.setattr(dk.asyncio, 'sleep', lambda _s, real=asyncio.sleep: real(0))
    cli = FakeCli(wait=CliResult(1, '', 'Error: No such container: c0ffee'))
    original = cli._inspect
    cli.responses['inspect'] = lambda args: (
        CliResult(1, '', 'Error: No such object: c0ffee') if '{{.State.Status}}' in args else original(args)
    )
    launch = await _launcher(cli, publish='true').start(_spec())
    launch.process.returncode = 3
    assert await launch.wait() == 3


async def test_create_carries_the_isolation_and_limits():
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    args = cli.call('create').args
    pairs = {args[i]: args[i + 1] for i in range(len(args) - 1) if args[i].startswith('--')}
    assert pairs['--cap-drop'] == 'ALL'
    assert pairs['--security-opt'] == 'no-new-privileges'
    assert pairs['--memory'] == '2g'
    assert pairs['--cpus'] == '1'
    assert pairs['--network'] == 'bridge'
    assert pairs['--log-driver'] == 'none'
    assert pairs['--add-host'] == 'host.docker.internal:host-gateway'
    labels = [args[i + 1] for i, a in enumerate(args) if a == '--label']
    assert labels == ['rocketride.task=proj.src', 'rocketride.eas=host-a:5565']


async def test_command_line_inside_the_container():
    """The subprocess runtime's argv minus --hosted and --node_path, the port fixed, the model server rewritten."""
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    args = cli.call('create').args
    image_at = args.index('rocketride/node:3.4.0')
    assert args[image_at + 1 :] == [
        './engine',
        'ai/node.py',
        '/opt/data/task.json',
        '--autoterm',
        '--monitor=app',
        '--data_port=5570',
        '--data_host=0.0.0.0',
        f'--data_token_sha256={TOKEN_SHA}',
        '--modelserver=host.docker.internal:5590',
        '--threads=2',
        '--trace=debugOut',
    ]
    assert '--hosted' not in args
    assert not any(a.startswith('--node_path') for a in args)


async def test_environment_goes_in_as_names_only():
    """-e NAME, the values in the CLI's own environment: nothing on argv, nothing on disk."""
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    create = cli.call('create')
    names = [create.args[i + 1] for i, a in enumerate(create.args) if a == '-e']
    assert names and all('=' not in name for name in names)
    assert '--env-file' not in create.args
    assert not any('sk-secret' in a or 's3cr3t' in a for a in create.args)
    assert create.env['OPENAI_API_KEY'] == 'sk-secret'
    # A multiline value survives: it is never written to an env file
    assert create.env['MULTI'] == 'line one\nline two'
    assert 'MULTI' in names


async def test_host_only_variables_stay_out_and_the_cli_keeps_its_own():
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    create = cli.call('create')
    names = [create.args[i + 1] for i, a in enumerate(create.args) if a == '-e']
    for host_only in ('PATH', 'HOME', 'UV_CACHE_DIR', 'XDG_CACHE_HOME'):
        assert host_only not in names
    assert 'LANG' in names
    # The CLI runs with the engine's PATH and HOME, not the task's
    assert create.env['PATH'] == '/usr/bin'
    assert create.env['HOME'] == '/home/eas'


async def test_loopback_dsn_moves_to_the_host_gateway():
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    assert cli.call('create').env['ROCKETRIDE_DB_DSN'] == 'postgresql://u:p%40ss@host.docker.internal:5432/tenant'


async def test_models_volume_and_hf_home_only_when_configured():
    cli = FakeCli()
    await _launcher(cli, models='/srv/models').start(_spec())
    create = cli.call('create')
    assert create.args[create.args.index('-v') + 1] == '/srv/models:/models:ro'
    assert create.env['HF_HOME'] == '/models'

    plain = FakeCli()
    await _launcher(plain).start(_spec())
    assert '-v' not in plain.call('create').args


@pytest.mark.parametrize('flag', ['-p', '--publish'])
async def test_ip_mode_publishes_nothing(flag):
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    assert flag not in cli.call('create').args


def _ids(monkeypatch, uid, gid):
    """Pretend the engine runs as uid:gid."""
    monkeypatch.setattr(dk.os, 'getuid', lambda: uid, raising=False)
    monkeypatch.setattr(dk.os, 'getgid', lambda: gid, raising=False)


async def test_tasks_run_as_the_engines_user_in_the_images_group(monkeypatch):
    """The engine's uid:gid, so a mount keeps one owner; the image's group to write what a run installs."""
    _ids(monkeypatch, 1001, 1001)
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    args = cli.call('create').args
    assert args[args.index('--user') + 1] == '1001:1001'
    assert args[args.index('--group-add') + 1] == '1000'
    # The task file is that user's, or the task could not read it
    member = tarfile.open(fileobj=io.BytesIO(cli.call('cp').stdin)).getmember('task.json')
    assert (member.uid, member.gid, member.mode) == (1001, 1001, 0o600)


async def test_an_engine_in_the_images_group_needs_no_group_add(monkeypatch):
    _ids(monkeypatch, 1000, 1000)
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    args = cli.call('create').args
    assert args[args.index('--user') + 1] == '1000:1000'
    assert '--group-add' not in args


async def test_a_rootless_daemon_runs_tasks_as_its_root(monkeypatch):
    """Rootless: the container's root is the engine's user on the host."""
    _ids(monkeypatch, 1001, 1001)
    info = dict(LINUX_ENGINE, SecurityOptions=['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns'])
    cli = FakeCli(info=info)
    await _launcher(cli).start(_spec())
    args = cli.call('create').args
    assert args[args.index('--user') + 1] == '0:0'
    assert args[args.index('--group-add') + 1] == '1000'
    member = tarfile.open(fileobj=io.BytesIO(cli.call('cp').stdin)).getmember('task.json')
    assert (member.uid, member.gid) == (0, 0)


async def test_an_engine_without_a_uid_keeps_the_image_user(monkeypatch):
    monkeypatch.delattr(dk.os, 'getuid', raising=False)
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    assert '--user' not in cli.call('create').args
    member = tarfile.open(fileobj=io.BytesIO(cli.call('cp').stdin)).getmember('task.json')
    assert (member.uid, member.gid) == (1000, 1000)


# ---------------------------------------------------------------------------
# The task file
# ---------------------------------------------------------------------------


def test_task_tar_is_one_private_member_owned_by_the_image_user():
    archive = tarfile.open(fileobj=io.BytesIO(task_tar(b'{"a": 1}')))
    (member,) = archive.getmembers()
    assert member.name == 'task.json'
    assert (member.uid, member.gid, member.mode) == (1000, 1000, 0o600)
    assert (member.uname, member.gname) == ('rocketride', 'rocketride')
    assert archive.extractfile(member).read() == b'{"a": 1}'


def test_task_tar_for_another_user_is_known_by_number_only():
    (member,) = tarfile.open(fileobj=io.BytesIO(task_tar(b'{}', 1001, 1002))).getmembers()
    assert (member.uid, member.gid, member.mode) == (1001, 1002, 0o600)
    assert (member.uname, member.gname) == ('', '')


async def test_task_file_goes_in_as_a_tar_stream_before_start():
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    cp = cli.call('cp')
    assert cp.args == ['cp', '-', 'c0ffee:/opt/data']
    member = tarfile.open(fileobj=io.BytesIO(cp.stdin)).extractfile('task.json').read()
    assert member == _spec().task_file
    assert cli.commands().index('cp') < len(cli.calls)
    assert cli.attached == [['start', '-a', '-i', 'c0ffee']]


def test_task_data_path_is_the_images():
    assert _launcher().task_data_path == '/opt/data'


# ---------------------------------------------------------------------------
# The address
# ---------------------------------------------------------------------------


async def test_ip_mode_dials_the_container_ip_from_its_network():
    cli = FakeCli()
    launch = await _launcher(cli).start(_spec())
    assert launch.address == '172.17.0.5:5570'
    inspects = [c.args for c in cli.calls if c.args[0] == 'inspect']
    assert ['inspect', '--format', '{{json .NetworkSettings.Networks}}', 'c0ffee'] in inspects


async def test_ip_mode_waits_for_the_daemon_to_give_an_ip(monkeypatch):
    monkeypatch.setattr(dk.asyncio, 'sleep', lambda _s, real=asyncio.sleep: real(0))
    answers = iter([json.dumps({'bridge': {'IPAddress': ''}}), json.dumps({'bridge': {'IPAddress': '172.17.0.9'}})])
    cli = FakeCli()
    original = cli._inspect
    cli.responses['inspect'] = lambda args: (
        original(args) if '{{.State.Status}}' in args else CliResult(0, next(answers), '')
    )
    launch = await _launcher(cli).start(_spec())
    assert launch.address == '172.17.0.9:5570'


async def test_published_mode_dials_loopback_and_gives_the_port_back():
    server = _server()
    cli = FakeCli(info=DOCKER_DESKTOP)
    launch = await _launcher(cli, server=server).start(_spec())
    args = cli.call('create').args
    assert args[args.index('-p') + 1] == '127.0.0.1:20009:5570'
    assert launch.address == '127.0.0.1:20009'
    assert not any('{{json .NetworkSettings.Networks}}' in c.args for c in cli.calls)
    await launch.cleanup()
    server.release_port.assert_called_once_with(20009)


# ---------------------------------------------------------------------------
# Exit code, stop, cleanup
# ---------------------------------------------------------------------------


async def test_exit_code_comes_from_docker_wait_not_the_cli():
    """The CLI died by SIGKILL (-9); the container's own code is 42."""
    launch = await _launcher().start(_spec())
    launch.process.returncode = -9
    assert await launch.wait() == 42
    assert launch.returncode == 42


async def test_exit_is_watched_only_once_the_container_has_started(monkeypatch):
    """A created container makes docker wait return 0 at once, so it must not run before start."""
    monkeypatch.setattr(dk.asyncio, 'sleep', lambda _s, real=asyncio.sleep: real(0))
    cli = FakeCli()
    cli.states = ['created', 'created', 'running']
    launch = await _launcher(cli).start(_spec())
    await asyncio.sleep(0)
    statuses = [i for i, c in enumerate(cli.calls) if '{{.State.Status}}' in c.args]
    waits = [i for i, c in enumerate(cli.calls) if c.args[0] == 'wait']
    assert len(statuses) == 3
    assert waits and waits[0] > statuses[-1]
    assert await launch.wait() == 42


async def test_a_container_that_never_starts_is_removed(monkeypatch):
    """The CLI died while the container was still only created: an error, and the container goes."""
    monkeypatch.setattr(dk.asyncio, 'sleep', lambda _s, real=asyncio.sleep: real(0))
    cli = FakeCli()
    cli.states = ['created']
    original_attach = cli.attach

    async def dead_attach(args):
        process = await original_attach(args)
        process.returncode = 1
        return process

    cli.attach = dead_attach
    with pytest.raises(DockerError, match='did not start'):
        await _launcher(cli).start(_spec())
    assert cli.calls[-1].args == ['rm', '-f', 'c0ffee']
    assert 'wait' not in cli.commands()


async def test_wait_survives_a_timeout_around_it():
    """_process_exit_code wraps wait() in a timeout; the watch on docker wait must outlive it."""
    gate = asyncio.Event()

    async def slow_wait(args):
        await gate.wait()
        return CliResult(0, '7\n', '')

    cli = FakeCli()

    async def run(args, *, stdin=None, env=None, check=True):
        if args[0] == 'wait':
            return await slow_wait(args)
        return await FakeCli.run(cli, args, stdin=stdin, env=env, check=check)

    cli.run = run
    launch = await _launcher(cli).start(_spec())
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(launch.wait(), timeout=0.01)
    gate.set()
    assert await launch.wait() == 7


async def test_terminate_and_kill_go_through_the_daemon():
    cli = FakeCli(wait=CliResult(0, '', ''))
    gate = asyncio.Event()
    original = cli.run

    async def run(args, *, stdin=None, env=None, check=True):
        if args[0] == 'wait':
            await gate.wait()
        return await original(args, stdin=stdin, env=env, check=check)

    cli.run = run
    launch = await _launcher(cli).start(_spec())
    launch.terminate()
    launch.kill()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    kills = [c.args for c in cli.calls if c.args[0] == 'kill']
    assert kills == [['kill', '-s', 'TERM', 'c0ffee'], ['kill', 'c0ffee']]
    gate.set()


async def test_cleanup_removes_the_container_once():
    cli = FakeCli()
    launch = await _launcher(cli).start(_spec())
    await launch.cleanup()
    await launch.cleanup()
    assert [c.args for c in cli.calls if c.args[0] == 'rm'] == [['rm', '-f', 'c0ffee']]


async def test_metrics_come_from_docker_stats():
    launch = await _launcher().start(_spec())
    sampler = launch.metrics()['sampler']
    assert isinstance(sampler, DockerStatsSampler)
    assert sampler.min_interval >= 1.0


# ---------------------------------------------------------------------------
# rm -f on a failure at any step
# ---------------------------------------------------------------------------


async def test_missing_image_names_container_build_and_never_pulls():
    cli = FakeCli(create=CliResult(1, '', 'Error response from daemon: No such image: rocketride/node:3.4.0'))
    server = _server()
    with pytest.raises(DockerError, match='container:build'):
        await _launcher(cli, server=server, publish='true').start(_spec())
    assert 'rm' not in cli.commands()[2:]
    server.release_port.assert_called_once_with(20009)


@pytest.mark.parametrize('failing', ['cp', 'attach', 'inspect'])
async def test_a_failure_after_create_removes_the_container(failing, monkeypatch):
    monkeypatch.setattr(dk.asyncio, 'sleep', lambda _s, real=asyncio.sleep: real(0))
    cli = FakeCli()
    if failing == 'cp':
        cli.responses['cp'] = CliResult(1, '', 'cp refused')
    elif failing == 'attach':
        cli.attach_error = OSError('no docker binary')
    else:
        cli.networks = json.dumps({'bridge': {'IPAddress': ''}})
    with pytest.raises((DockerError, OSError)):
        await _launcher(cli).start(_spec())
    assert cli.calls[-1].args == ['rm', '-f', 'c0ffee']


# ---------------------------------------------------------------------------
# The store (tool_filesystem) and the test mocks
# ---------------------------------------------------------------------------


def _store_environ(tmp_path, **extra):
    environ = {'PATH': '/usr/bin', 'RR_STORE_URL': f'filesystem://{tmp_path}/store'}
    environ.update(extra)
    return environ


def _probe_writes(args):
    """The probe container as a working daemon runs it: it sees the marker and writes one back."""
    mount = args[args.index('-v') + 1]
    probe = mount[: -len(':/probe')]
    assert os.path.isfile(os.path.join(probe, 'engine'))
    with open(os.path.join(probe, 'task'), 'w') as f:
        f.write('')
    return CliResult(0, '', '')


def _real_user():
    """This test process's uid and gid, which a probe file really gets."""
    return os.getuid(), os.getgid()


# Windows has no uid: test_store_without_a_uid_keeps_the_image_user covers that case
needs_uid = pytest.mark.skipif(not hasattr(os, 'getuid'), reason='no uid on Windows')


async def test_store_subtree_is_mounted_and_the_task_store_points_at_it(tmp_path):
    cli = FakeCli(run=_probe_writes)
    launcher = _launcher(cli, environ=_store_environ(tmp_path))
    await launcher.start(_spec(uses_store=True, storage_root='users/u1/files'))
    create = cli.call('create')
    mounts = [create.args[i + 1] for i, a in enumerate(create.args) if a == '-v']
    assert mounts == [f'{os.path.join(tmp_path, "store", "users/u1/files")}:/opt/store/users/u1/files']
    assert create.env['RR_STORE_URL'] == 'filesystem:///opt/store'
    assert (tmp_path / 'store' / 'users' / 'u1' / 'files').is_dir()
    # The daemon was asked, once, as a task runs, and the probe left nothing behind
    probe = cli.call('run').args
    assert probe[:4] == ['run', '--rm', '--pull', 'never']
    if hasattr(os, 'getuid'):
        assert probe[probe.index('--user') + 1] == '%d:%d' % _real_user()
    assert probe[probe.index('--cap-drop') + 1] == 'ALL'
    assert probe[probe.index('-v') + 1].startswith(os.path.join(tmp_path, 'store', '.rocketride-probe-'))
    assert not any(name.startswith('.rocketride-probe') for name in os.listdir(tmp_path / 'store'))


@needs_uid
async def test_store_works_whatever_uid_the_engine_runs_as(tmp_path):
    """No uid 1000 rule: the task runs as the engine's own user, so the mount keeps one owner."""
    cli = FakeCli(run=_probe_writes)
    await _launcher(cli, environ=_store_environ(tmp_path)).start(_spec(uses_store=True, storage_root='users/u1'))
    create = cli.call('create').args
    assert create[create.index('--user') + 1] == '%d:%d' % _real_user()
    assert any(a.endswith(':/opt/store/users/u1') for a in create)


async def test_store_probe_runs_once_per_process(tmp_path):
    cli = FakeCli(run=_probe_writes)
    launcher = _launcher(cli, environ=_store_environ(tmp_path))
    for _ in range(3):
        await launcher.start(_spec(uses_store=True, storage_root='users/u1/files'))
    assert cli.commands().count('run') == 1


async def test_store_refused_when_the_daemon_does_not_see_it(tmp_path):
    cli = FakeCli(run=CliResult(3, '', ''))
    with pytest.raises(StoreUnavailableError, match='does not see'):
        await _launcher(cli, environ=_store_environ(tmp_path)).start(
            _spec(uses_store=True, storage_root='users/u1/files')
        )
    assert 'create' not in cli.commands()
    assert not any(name.startswith('.rocketride-probe') for name in os.listdir(tmp_path / 'store'))


async def test_store_refused_when_a_task_cannot_write_it(tmp_path):
    cli = FakeCli(run=CliResult(4, '', 'touch: cannot touch /probe/task: Permission denied'))
    with pytest.raises(StoreUnavailableError, match='cannot write the store'):
        await _launcher(cli, environ=_store_environ(tmp_path)).start(
            _spec(uses_store=True, storage_root='users/u1/files')
        )
    assert 'create' not in cli.commands()


@needs_uid
async def test_store_refused_when_a_tasks_file_is_not_the_engines(tmp_path, monkeypatch):
    """A daemon that remaps users: the file the probe wrote is someone else's on this host."""
    real_uid = os.getuid()
    monkeypatch.setattr(dk.os, 'getuid', lambda: real_uid + 1)
    cli = FakeCli(run=_probe_writes)
    with pytest.raises(StoreUnavailableError, match=f'belongs to uid {real_uid}'):
        await _launcher(cli, environ=_store_environ(tmp_path)).start(
            _spec(uses_store=True, storage_root='users/u1/files')
        )
    assert 'create' not in cli.commands()


async def test_store_without_a_uid_keeps_the_image_user(tmp_path, monkeypatch):
    """An engine with no uid (Windows): no --user, and no owner to compare."""
    monkeypatch.delattr(dk.os, 'getuid', raising=False)
    cli = FakeCli(run=_probe_writes)
    await _launcher(cli, environ=_store_environ(tmp_path)).start(_spec(uses_store=True, storage_root='users/u1'))
    assert '--user' not in cli.call('run').args
    assert '--user' not in cli.call('create').args


async def test_store_refused_for_s3_through_a_web_identity_token():
    cli = FakeCli()
    environ = {'RR_STORE_URL': 's3://bucket/prefix', 'AWS_WEB_IDENTITY_TOKEN_FILE': '/var/run/secrets/token'}
    with pytest.raises(StoreUnavailableError, match='web-identity'):
        await _launcher(cli, environ=environ).start(_spec(uses_store=True, storage_root='users/u1/files'))


async def test_s3_with_a_static_key_needs_no_mount():
    cli = FakeCli()
    environ = {'RR_STORE_URL': 's3://bucket/prefix', 'RR_STORE_SECRET_KEY': 'k'}
    await _launcher(cli, environ=environ).start(_spec(uses_store=True, storage_root='users/u1/files'))
    assert '-v' not in cli.call('create').args


async def test_no_store_mount_without_tool_filesystem(tmp_path):
    cli = FakeCli()
    await _launcher(cli, environ=_store_environ(tmp_path)).start(_spec())
    assert '-v' not in cli.call('create').args
    assert 'run' not in cli.commands()


@pytest.mark.parametrize('path', ['/home/me/rr/nodes/test/mocks', 'E:\\rr\\nodes\\test\\mocks'])
async def test_a_variable_named_in_mounts_is_mounted_and_points_at_the_mount(monkeypatch, path):
    """The same on Linux and Windows: a Windows path is no path in a Linux container."""
    monkeypatch.setattr(dk.os.path, 'isdir', lambda p: p == path)
    spec = _spec()
    spec.env['ROCKETRIDE_MOCK'] = path
    cli = FakeCli()
    await _launcher(cli, mounts='ROCKETRIDE_MOCK').start(spec)
    create = cli.call('create')
    assert create.args[create.args.index('-v') + 1] == f'{path}:/opt/mounts/ROCKETRIDE_MOCK:ro'
    assert create.env['ROCKETRIDE_MOCK'] == '/opt/mounts/ROCKETRIDE_MOCK'


async def test_a_variable_not_named_in_mounts_is_not_mounted(tmp_path):
    spec = _spec()
    spec.env['ROCKETRIDE_MOCK'] = str(tmp_path)
    cli = FakeCli()
    await _launcher(cli).start(spec)
    assert '-v' not in cli.call('create').args


def test_pipeline_opens_store_finds_tool_filesystem_by_node_path():
    services = {
        'tool_filesystem': {'path': 'nodes.tool_filesystem'},
        'filestore': {'path': 'nodes.tool_filesystem'},
        'chat': {'path': 'nodes.chat'},
    }
    get = services.get
    assert pipeline_opens_store({'components': [{'provider': 'chat'}, {'provider': 'filestore'}]}, get)
    assert not pipeline_opens_store({'components': [{'provider': 'chat'}, {'provider': 'unknown'}]}, get)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'address, expected',
    [
        ('127.0.0.1:5590', 'host.docker.internal:5590'),
        ('localhost:5590', 'host.docker.internal:5590'),
        ('[::1]:5590', 'host.docker.internal:5590'),
        ('ws://localhost:5590/models', 'ws://host.docker.internal:5590/models'),
        ('postgresql://u:p@127.0.0.1:5432/db?x=1', 'postgresql://u:p@host.docker.internal:5432/db?x=1'),
        ('5590', '5590'),
        ('model.rocketride.dev:443', 'model.rocketride.dev:443'),
        ('postgresql://u:p@10.0.0.4:5432/db', 'postgresql://u:p@10.0.0.4:5432/db'),
    ],
)
def test_rewrite_loopback(address, expected):
    assert rewrite_loopback(address) == expected


@pytest.mark.parametrize(
    'text, expected',
    [('0B', 0), ('512KiB', 512 * 1024), ('12.5MiB', int(12.5 * 1024**2)), ('2GiB', 2 * 1024**3), ('3MB', 3_000_000)],
)
def test_parse_size(text, expected):
    assert parse_size(text) == expected


def test_parse_size_and_percent_reject_junk():
    assert parse_size('lots') is None
    assert parse_percent('--') is None
    assert parse_percent('12.34%') == pytest.approx(12.34)


@pytest.mark.parametrize('name', ['PATH', 'HOME', 'UV_CACHE_DIR', 'XDG_RUNTIME_DIR', 'SSL_CERT_FILE'])
def test_host_only_names(name):
    assert is_host_only(name)


@pytest.mark.parametrize('name', ['LANG', 'OPENAI_API_KEY', 'ROCKETRIDE_DB_DSN', 'AWS_REGION', 'HTTP_PROXY'])
def test_task_names_pass(name):
    assert not is_host_only(name)


async def test_stats_sampler_reads_cpu_and_memory():
    row = {'CPUPerc': '150.25%', 'MemUsage': '256MiB / 2GiB'}
    cli = FakeCli(stats=CliResult(0, json.dumps(row) + '\n', ''))
    assert await DockerStatsSampler(cli, 'c0ffee').sample() == (pytest.approx(150.25), 256 * 1024**2)
    assert cli.calls[0].args == ['stats', '--no-stream', '--format', '{{json .}}', 'c0ffee']


@pytest.mark.parametrize('result', [CliResult(1, '', 'gone'), CliResult(0, 'not json', ''), CliResult(0, '', '')])
async def test_stats_sampler_returns_none_when_it_cannot_read(result):
    cli = FakeCli(stats=result)
    assert await DockerStatsSampler(cli, 'c0ffee').sample() is None


@pytest.mark.parametrize(
    'runtime, hosted, expected',
    [
        (None, False, 'spawn'),
        (None, True, 'docker'),
        ('spawn', True, 'spawn'),
        ('docker', False, 'docker'),
    ],
)
def test_task_server_runtime_follows_the_hosted_flag_unless_given(monkeypatch, runtime, hosted, expected):
    """A config without a runtime gets docker on a hosted engine and spawn otherwise; a given one wins."""
    from ai.modules.task import task_server as ts

    monkeypatch.setattr(dk, 'engine_version', lambda: '3.4.0')
    monkeypatch.setattr(ts, '_is_saas_engine', lambda: hosted)
    server = ts.TaskServer.__new__(ts.TaskServer)
    server._config = {'port': 5565} if runtime is None else {'port': 5565, 'runtime': runtime}
    server._launcher = None
    assert server.launcher().name == expected


def test_create_launcher_builds_the_docker_runtime(monkeypatch):
    monkeypatch.setattr(dk, 'engine_version', lambda: '3.4.0')
    launcher = create_launcher('docker', _server())
    assert isinstance(launcher, DockerLauncher)
    assert launcher.config['image'] == 'rocketride/node:3.4.0'
