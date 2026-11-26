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
sweep once per process, the mounted directories, and the sampler.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import tarfile
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from rocketride import TASK_STATE

from ai.modules.task import task_engine
from ai.modules.task.launcher import LaunchSpec, create_launcher
from ai.modules.task.launcher import docker as dk
from ai.modules.task.launcher.docker import (
    CliResult,
    DockerError,
    DockerLauncher,
    DockerStatsSampler,
    docker_config,
    is_host_only,
    parse_percent,
    parse_size,
    rewrite_loopback,
    task_tar,
)
from ai.modules.task.task_engine import TaskEngine
from ai.modules.task.types import EngineState

LINUX_ENGINE = {'OSType': 'linux', 'OperatingSystem': 'Ubuntu 22.04.4 LTS'}
DOCKER_DESKTOP = {'OSType': 'linux', 'OperatingSystem': 'Docker Desktop (containerized)'}
ROOTLESS_ENGINE = dict(LINUX_ENGINE, SecurityOptions=['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns'])
TOKEN_SHA = 'a' * 64


@pytest.fixture(autouse=True)
def _engine_on_linux(monkeypatch):
    """Read the address mode as an engine on a Linux host would, whatever host runs the tests."""
    monkeypatch.setattr(dk, 'ENGINE_ON_LINUX', True)


class FakeProcess:
    """The attached ``docker start -a -i``: just a pid and a code."""

    def __init__(self, returncode=None):
        """A running container's CLI, or one that already exited with ``returncode``."""
        self.pid = 777
        self.returncode = returncode
        self.killed = False

    def kill(self):
        """SIGKILL: the next wait() reaps it."""
        self.killed = True

    async def communicate(self, input=None):
        """Nothing more to read: reap it as wait() does."""
        await self.wait()
        return b'', b''

    async def wait(self):
        """Exit with the code given, or as killed (-9) when there is none."""
        if self.returncode is None:
            self.returncode = -9
        return self.returncode


class FakeCli:
    """Records every docker command; answers from ``responses`` keyed by the subcommand."""

    def __init__(self, info=None, **responses):
        """Answer ``info`` with ``info`` (a local Linux Engine by default) and the rest from ``responses``."""
        self.calls = []
        self.attached = []
        # The subcommands of run and attach alike, in the order they came
        self.order = []
        self.responses = {
            'info': CliResult(0, json.dumps(info or LINUX_ENGINE), ''),
            'ps': CliResult(0, '', ''),
            'create': CliResult(0, 'c0ffee\n', ''),
            'cp': CliResult(0, '', ''),
            'inspect': self._inspect,
            'wait': CliResult(0, '42\n', ''),
            'run': CliResult(0, '', ''),
            'context': CliResult(0, 'unix:///var/run/docker.sock\n', ''),
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

    async def run(self, args, *, stdin=None, env=None, check=True, timeout=dk.CONST_CLI_TIMEOUT):
        """Record the command and answer from ``responses``, raising as the real CLI does under ``check``."""
        self.calls.append(SimpleNamespace(args=list(args), stdin=stdin, env=env, timeout=timeout))
        self.order.append(args[0])
        response = self.responses.get(args[0], CliResult(0, '', ''))
        result = response(list(args)) if callable(response) else response
        if check and result.returncode != 0:
            raise DockerError(f'docker {args[0]} failed (exit {result.returncode}): {result.stderr}')
        return result

    async def attach(self, args):
        """Record ``start -a -i``; fail with ``attach_error`` when it is set."""
        self.attached.append(list(args))
        self.order.append(args[0])
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


def _hung(args):
    """A docker rm -f that timed out."""
    raise DockerError('docker rm timed out after 60 s')


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
            'ROCKETRIDE_DB_DSNS': json.dumps(
                {
                    'org': 'postgresql://u:p%40ss@127.0.0.1:5432/tenant',
                    'team:t1': 'postgresql://u:p@db.example:5432/team',
                }
            ),
            'OPENAI_API_KEY': 'sk-secret',
            'MULTI': 'line one\nline two',
        },
        args=['--threads=2', '--dumps', '--trace=debugOut'],
        modelserver='localhost:5590',
        hosted=True,
    )
    values.update(overrides)
    return LaunchSpec(**values)


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def test_config_takes_server_config_over_environment_over_defaults(monkeypatch):
    """The server config wins over RR_DOCKER_*, which win over the defaults."""
    monkeypatch.setattr(dk, 'engine_version', lambda: '3.4.0')
    cfg = docker_config(
        {'port': 5566, 'docker': {'memory': '4g'}},
        {'RR_DOCKER_MEMORY': '3g', 'RR_DOCKER_CPUS': '2', 'RR_DOCKER_PUBLISH': 'TRUE', 'RR_DOCKER_PIDS_LIMIT': '512'},
    )
    assert cfg['memory'] == '4g'
    assert cfg['cpus'] == '2'
    assert cfg['pids_limit'] == '512'
    assert cfg['publish'] == 'true'
    assert cfg['network'] == 'bridge'
    assert cfg['log_driver'] == 'none'


def test_config_image_is_the_engine_version_never_latest(monkeypatch):
    """The default image is this engine's version: a task never runs the nodes of another release."""
    monkeypatch.setattr(dk, 'engine_version', lambda: '3.4.0')
    assert docker_config({}, {})['image'] == 'rocketride/node:3.4.0'


def test_engine_version_drops_the_build_number(monkeypatch):
    """The image tag is major.minor.patch, without the engine's build number."""
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


@pytest.mark.parametrize('network', ['host', 'HOST', 'none', 'container:engine'])
def test_config_refuses_a_network_that_is_not_the_tasks_own(monkeypatch, network):
    """Host mode would bind every task's port on the host, none and container:<name> leave none of its own."""
    monkeypatch.setattr(dk, 'engine_version', lambda: '3.4.0')
    with pytest.raises(ValueError, match='network of its own'):
        docker_config({}, {'RR_DOCKER_NETWORK': network})


def test_config_refuses_an_unknown_publish_value(monkeypatch):
    """RR_DOCKER_PUBLISH takes auto, true or false; anything else is an error, not a guess."""
    monkeypatch.setattr(dk, 'engine_version', lambda: '3.4.0')
    with pytest.raises(ValueError, match='publish'):
        docker_config({}, {'RR_DOCKER_PUBLISH': 'sometimes'})


# ---------------------------------------------------------------------------
# Address mode, from what the daemon is
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'info, publish, expected',
    [
        (LINUX_ENGINE, 'auto', False),
        (DOCKER_DESKTOP, 'auto', True),
        ({'OSType': 'windows', 'OperatingSystem': 'Windows Server'}, 'auto', True),
        (LINUX_ENGINE, 'true', True),
        (DOCKER_DESKTOP, 'false', False),
        (ROOTLESS_ENGINE, 'auto', True),
        (ROOTLESS_ENGINE, 'false', False),
    ],
)
def test_published_mode_follows_the_daemon_not_the_os(info, publish, expected):
    """The container IP routes only to a local, rootful Linux Engine's bridge; a setting other than auto wins."""
    assert _launcher(publish=publish).published_mode(info) is expected


def test_ip_mode_needs_the_engine_on_linux(monkeypatch):
    """From macOS or Windows a VM's container IPs do not route: auto publishes, an explicit false stays."""
    monkeypatch.setattr(dk, 'ENGINE_ON_LINUX', False)
    assert _launcher().published_mode(LINUX_ENGINE) is True
    assert _launcher(publish='false').published_mode(LINUX_ENGINE) is False


@pytest.mark.parametrize(
    'endpoint, remote',
    [
        ('unix:///var/run/docker.sock', False),
        ('npipe:////./pipe/dockerDesktopLinuxEngine', False),
        ('tcp://127.0.0.1:2375', False),
        ('tcp://localhost:2375', False),
        ('tcp://[::1]:2375', False),
        # The same rule as the loopback rewrite: all of 127/8 is this machine
        ('tcp://127.0.0.2:2375', False),
        ('tcp://10.0.0.5:2376', True),
        ('ssh://builder', True),
        ('ssh://me@builder:22', True),
    ],
)
def test_remote_daemon_is_a_tcp_or_ssh_endpoint_on_another_host(endpoint, remote):
    """Only a TCP or SSH endpoint can name another host; loopback is this one."""
    assert dk.remote_daemon(endpoint) is remote


# ---------------------------------------------------------------------------
# prepare(): docker info and the startup sweep, once
# ---------------------------------------------------------------------------


async def test_prepare_sweeps_this_instances_leftovers():
    cli = FakeCli(ps=CliResult(0, 'old1\nold2\n', ''))
    launcher = _launcher(cli)
    await launcher.prepare()
    assert cli.commands() == ['info', 'context', 'ps', 'rm']
    assert cli.call('ps').args == ['ps', '-aq', '--filter', 'label=rocketride.eas=host-a:5565']
    assert cli.call('rm').args == ['rm', '-f', 'old1', 'old2']
    assert launcher.published is False


@pytest.mark.parametrize('rm', [_hung, CliResult(1, '', 'Error response from daemon: removal failed')])
async def test_a_sweep_that_cannot_remove_the_leftovers_does_not_fail_prepare(rm, monkeypatch):
    """The sweep's rm -f hangs or is refused: it is logged, and prepare() is done, so tasks start without it."""
    logged = []
    monkeypatch.setattr(dk, 'debug', logged.append)
    cli = FakeCli(ps=CliResult(0, 'old1\nold2\n', ''), rm=rm)
    launcher = _launcher(cli)
    await launcher.prepare()
    await launcher.prepare()
    assert cli.commands().count('info') == 1
    assert any('could not remove all of 2 container(s)' in line for line in logged)


async def test_prepare_runs_once_however_many_tasks_start():
    """The sweep never runs per task: it would remove the containers of running siblings.

    Starts that come while it runs wait for it, and later ones skip it.
    """
    cli = FakeCli()
    gate = asyncio.Event()
    original = cli.run

    async def run(args, *, stdin=None, env=None, check=True, timeout=dk.CONST_CLI_TIMEOUT):
        """The fake CLI, whose docker info answers only once the gate opens."""
        result = await original(args, stdin=stdin, env=env, check=check, timeout=timeout)
        if args[0] == 'info':
            await gate.wait()
        return result

    cli.run = run
    launcher = _launcher(cli)
    both = asyncio.gather(launcher.prepare(), launcher.start(_spec()), launcher.start(_spec()))
    for _ in range(3):
        await asyncio.sleep(0)
    assert cli.commands() == ['info']
    gate.set()
    await both
    await launcher.start(_spec())
    assert cli.commands().count('info') == 1
    assert cli.commands().count('ps') == 1


async def test_prepare_failure_is_raised_and_retried():
    """No daemon: every caller waiting on prepare() gets its error, and the next call asks docker info again.

    Later calls wait for that retry, even when it began before the other
    callers had seen the failure: a second sweep would remove the containers
    of the tasks started meanwhile.
    """
    cli = FakeCli(info=None)
    cli.responses['info'] = CliResult(1, '', 'Cannot connect to the Docker daemon')
    gate = asyncio.Event()
    original = cli.run

    async def run(args, *, stdin=None, env=None, check=True, timeout=dk.CONST_CLI_TIMEOUT):
        """The fake CLI, whose docker info answers only once the gate opens."""
        if args[0] == 'info':
            await gate.wait()
        return await original(args, stdin=stdin, env=env, check=check, timeout=timeout)

    cli.run = run
    launcher = _launcher(cli)

    async def prepare_then_retry():
        """The first caller, which tries again as soon as it fails, before the other callers see the failure."""
        try:
            await launcher.prepare()
        except DockerError as error:
            cli.responses['info'] = CliResult(0, json.dumps(LINUX_ENGINE), '')
            await launcher.prepare()
            return error

    callers = asyncio.gather(
        prepare_then_retry(), launcher.start(_spec()), launcher.start(_spec()), return_exceptions=True
    )
    for _ in range(3):
        await asyncio.sleep(0)
    gate.set()
    error, *others = await callers
    assert isinstance(error, DockerError) and 'Cannot connect' in str(error)
    assert all(other is error for other in others)
    await launcher.prepare()
    assert cli.commands() == ['info', 'info', 'context', 'ps']


@pytest.mark.parametrize('endpoint', ['tcp://10.0.0.5:2376', 'ssh://builder'])
@pytest.mark.parametrize('publish', ['auto', 'true', 'false'])
async def test_prepare_refuses_a_daemon_on_another_host(endpoint, publish):
    """Its published port is out of reach and its mounts name its files: refused in every mode, before any task."""
    cli = FakeCli(context=CliResult(0, endpoint + '\n', ''))
    with pytest.raises(DockerError, match='on another host'):
        await _launcher(cli, publish=publish).prepare()
    assert 'ps' not in cli.commands()


async def test_prepare_reads_docker_host_when_the_cli_cannot_name_the_daemon():
    """An old CLI without contexts: DOCKER_HOST is the endpoint."""
    cli = FakeCli(context=CliResult(1, '', "docker: 'context' is not a docker command."))
    launcher = _launcher(cli, environ={'PATH': '/usr/bin', 'DOCKER_HOST': 'tcp://10.0.0.5:2376'})
    with pytest.raises(DockerError, match='tcp://10.0.0.5:2376'):
        await launcher.prepare()


async def test_cli_kills_a_command_that_does_not_answer():
    """A daemon that takes the connection and never answers: the command is killed, not waited on."""
    cli = dk.DockerCli(sys.executable)
    with pytest.raises(DockerError, match='timed out after 0.5 s'):
        await asyncio.wait_for(cli.run(['-c', 'import time; time.sleep(60)'], timeout=0.5), 5)


async def test_only_docker_wait_runs_without_a_time_limit():
    """Every command but docker wait has the CLI timeout; docker wait lasts as long as the task."""
    cli = FakeCli()
    launch = await _launcher(cli).start(_spec())
    assert await launch.wait() == 42
    assert cli.call('wait').timeout is None
    assert {call.timeout for call in cli.calls if call.args[0] != 'wait'} == {dk.CONST_CLI_TIMEOUT}


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
    """Every container drops its capabilities, gains no privileges, and has its limits and labels."""
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    args = cli.call('create').args
    pairs = {args[i]: args[i + 1] for i in range(len(args) - 1) if args[i].startswith('--')}
    assert pairs['--cap-drop'] == 'ALL'
    assert pairs['--security-opt'] == 'no-new-privileges'
    assert pairs['--memory'] == '2g'
    assert pairs['--cpus'] == '1'
    assert pairs['--pids-limit'] == '4096'
    assert pairs['--network'] == 'bridge'
    assert pairs['--log-driver'] == 'none'
    assert pairs['--add-host'] == 'host.docker.internal:host-gateway'
    labels = [args[i + 1] for i, a in enumerate(args) if a == '--label']
    assert labels == ['rocketride.task=proj.src', 'rocketride.eas=host-a:5565']


async def test_command_line_inside_the_container():
    """The subprocess runtime's argv, both hosting flags kept, the port fixed, the model server rewritten."""
    cli = FakeCli()
    await _launcher(cli).start(_spec(shared_host=True))
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
        '--hosted',
        '--shared-host',
        '--modelserver=host.docker.internal:5590',
        '--threads=2',
        '--dumps',
        '--trace=debugOut',
    ]


async def test_environment_goes_in_as_names_only():
    """-e NAME, the values in the CLI's own environment: nothing on argv, no env file."""
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
    assert {'OPENAI_API_KEY', 'MULTI'} <= set(names)
    # docker create skips an -e NAME its own environment lacks
    assert all(name in create.env for name in names)


async def test_host_only_variables_stay_out_and_the_cli_keeps_its_own():
    """Variables of the engine's host stay out; the CLI itself runs with the engine's PATH, HOME and docker settings."""
    cli = FakeCli()
    spec = _spec()
    spec.env.update(DOCKER_API_VERSION='1.41', DOCKER_TLS='0')
    environ = {'PATH': '/usr/bin', 'HOME': '/home/eas', 'DOCKER_API_VERSION': '1.43', 'DOCKER_TLS': '1'}
    await _launcher(cli, environ=environ).start(spec)
    create = cli.call('create')
    names = [create.args[i + 1] for i, a in enumerate(create.args) if a == '-e']
    for host_only in ('PATH', 'HOME', 'UV_CACHE_DIR', 'XDG_CACHE_HOME', 'DOCKER_API_VERSION', 'DOCKER_TLS'):
        assert host_only not in names
    assert 'LANG' in names
    # The CLI runs with the engine's PATH, HOME and docker settings, not the task's
    assert create.env['PATH'] == '/usr/bin'
    assert create.env['HOME'] == '/home/eas'
    assert create.env['DOCKER_API_VERSION'] == '1.43'
    assert create.env['DOCKER_TLS'] == '1'


async def test_loopback_dsn_moves_to_the_host_gateway():
    """Each database DSN on loopback points at host.docker.internal inside the container; others stay."""
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    assert json.loads(cli.call('create').env['ROCKETRIDE_DB_DSNS']) == {
        'org': 'postgresql://u:p%40ss@host.docker.internal:5432/tenant',
        'team:t1': 'postgresql://u:p@db.example:5432/team',
    }


@pytest.mark.parametrize('value', ['not json', '["postgresql://127.0.0.1/x"]', '{"org": 5}'])
def test_a_dsn_map_that_is_no_map_of_strings_stays_as_it_is(value):
    """The nodes report a malformed map themselves: the launcher does not reshape it."""
    assert dk.rewrite_loopback_dsns(value) == value


async def test_models_volume_and_hf_home_only_when_configured(tmp_path):
    """A models directory is mounted read-only with HF_HOME on it; without one, nothing is mounted.

    The host's own hub cache would win over HF_HOME, so it stays out.
    """
    cli = FakeCli()
    await _launcher(cli, models=str(tmp_path)).start(_spec(env={**_spec().env, 'HF_HUB_CACHE': '/host/hf/hub'}))
    create = cli.call('create')
    assert create.args[create.args.index('-v') + 1] == f'{tmp_path}:/models:ro'
    assert create.env['HF_HOME'] == '/models'
    assert 'HF_HUB_CACHE' not in create.env

    plain = FakeCli()
    await _launcher(plain).start(_spec())
    assert '-v' not in plain.call('create').args


async def test_a_relative_models_path_goes_in_absolute(monkeypatch, tmp_path):
    """Docker -v reads a bare name as a named volume: a path relative to the engine's directory goes in absolute."""
    (tmp_path / 'models').mkdir()
    monkeypatch.chdir(tmp_path)
    cli = FakeCli()
    await _launcher(cli, models='models').start(_spec())
    create = cli.call('create')
    assert create.args[create.args.index('-v') + 1] == f'{os.path.abspath("models")}:/models:ro'


async def test_a_models_directory_that_is_missing_stops_the_task(tmp_path):
    """Docker -v would create it empty on the host: the start fails before create."""
    cli = FakeCli()
    with pytest.raises(DockerError, match='docker.models is mounted'):
        await _launcher(cli, models=str(tmp_path / 'missing')).start(_spec())
    assert 'create' not in cli.commands()


@pytest.mark.skipif(os.name == 'nt', reason='no ":" in a Windows file name')
async def test_a_models_path_with_a_colon_stops_the_task(monkeypatch):
    """Docker -v would split the path: the start fails before create."""
    monkeypatch.setattr(dk.os.path, 'isdir', lambda p: True)
    cli = FakeCli()
    with pytest.raises(DockerError, match='docker.models is mounted.*has a ":"'):
        await _launcher(cli, models='/srv/mo:dels').start(_spec())
    assert 'create' not in cli.commands()


@pytest.mark.parametrize('flag', ['-p', '--publish'])
async def test_ip_mode_publishes_nothing(flag):
    """In IP mode the data port is not published: the engine dials the container itself."""
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    assert flag not in cli.call('create').args


def _ids(monkeypatch, uid, gid):
    """Pretend the engine runs as uid:gid."""
    monkeypatch.setattr(dk.os, 'getuid', lambda: uid, raising=False)
    monkeypatch.setattr(dk.os, 'getgid', lambda: gid, raising=False)


async def test_tasks_run_as_the_engines_user_in_the_images_group(monkeypatch):
    """The engine's uid:gid, to read a mount as the engine does; the image's group, to write what a run installs."""
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
    """An engine whose gid is the image's group runs tasks as itself, with no --group-add."""
    _ids(monkeypatch, 1000, 1000)
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    args = cli.call('create').args
    assert args[args.index('--user') + 1] == '1000:1000'
    assert '--group-add' not in args


async def test_a_rootless_daemon_runs_tasks_as_its_root(monkeypatch):
    """Rootless: the container's root is the engine's user on the host."""
    _ids(monkeypatch, 1001, 1001)
    cli = FakeCli(info=ROOTLESS_ENGINE)
    await _launcher(cli).start(_spec())
    args = cli.call('create').args
    assert args[args.index('--user') + 1] == '0:0'
    assert args[args.index('--group-add') + 1] == '1000'
    member = tarfile.open(fileobj=io.BytesIO(cli.call('cp').stdin)).getmember('task.json')
    assert (member.uid, member.gid) == (0, 0)


async def test_a_root_engine_never_runs_a_task_as_root(monkeypatch):
    """Container root is host root on a daemon without user namespaces: a root engine's tasks run as the image user."""
    _ids(monkeypatch, 0, 0)
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    assert '--user' not in cli.call('create').args
    member = tarfile.open(fileobj=io.BytesIO(cli.call('cp').stdin)).getmember('task.json')
    assert (member.uid, member.gid) == (1000, 1000)
    # Rootless is another matter: there the container's root is the engine's own user
    assert _launcher().task_user(ROOTLESS_ENGINE) == (0, 0)


async def test_an_engine_without_a_uid_keeps_the_image_user(monkeypatch):
    """An engine with no uid (Windows): no --user, and the task file belongs to the image user."""
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
    """The task tar holds task.json alone, 0600 and owned by rocketride."""
    archive = tarfile.open(fileobj=io.BytesIO(task_tar(b'{"a": 1}')))
    (member,) = archive.getmembers()
    assert member.name == 'task.json'
    assert (member.uid, member.gid, member.mode) == (1000, 1000, 0o600)
    assert (member.uname, member.gname) == ('rocketride', 'rocketride')
    assert archive.extractfile(member).read() == b'{"a": 1}'


def test_task_tar_for_another_user_is_known_by_number_only():
    """For another user the tar names the owner by number only: the image has no such names."""
    (member,) = tarfile.open(fileobj=io.BytesIO(task_tar(b'{}', 1001, 1002))).getmembers()
    assert (member.uid, member.gid, member.mode) == (1001, 1002, 0o600)
    assert (member.uname, member.gname) == ('', '')


async def test_task_file_goes_in_as_a_tar_stream_before_start():
    """The task file reaches /opt/data as a tar stream on stdin, before the container starts."""
    cli = FakeCli()
    await _launcher(cli).start(_spec())
    cp = cli.call('cp')
    assert cp.args == ['cp', '-', 'c0ffee:/opt/data']
    member = tarfile.open(fileobj=io.BytesIO(cp.stdin)).extractfile('task.json').read()
    assert member == _spec().task_file
    assert cli.order.index('cp') < cli.order.index('start')
    assert cli.attached == [['start', '-a', '-i', 'c0ffee']]


def _node(root, name, files):
    """A node folder unpacked on the engine's disk: its files and the digest of its package."""
    folder = root / name
    folder.mkdir()
    for file, text in {**files, '.rrnode.sha256': name}.items():
        (folder / file).write_text(text)
    return str(folder)


async def test_the_runs_nodes_go_in_as_a_tar_stream_before_start(tmp_path):
    """The packaged nodes the run loads reach the image's nodes folder before the container
    starts, each with its digest file: the task's scan loads them, and depends() keeps its lock.
    """
    cli = FakeCli()
    nodes = [
        _node(tmp_path, 'embed_y', {'__init__.py': ''}),
        _node(tmp_path, 'llm_x', {'IGlobal.py': 'x = 1', 'requirements.txt': 'openai'}),
    ]
    await _launcher(cli).start(_spec(nodes=nodes))

    copies = [call for call in cli.calls if call.args[0] == 'cp']
    assert [call.args for call in copies] == [
        ['cp', '-', 'c0ffee:/opt/data'],
        ['cp', '-', 'c0ffee:/opt/rocketride/nodes'],
    ]
    archive = tarfile.open(fileobj=io.BytesIO(copies[1].stdin))
    assert sorted(archive.getnames()) == [
        'embed_y',
        'embed_y/.rrnode.sha256',
        'embed_y/__init__.py',
        'llm_x',
        'llm_x/.rrnode.sha256',
        'llm_x/IGlobal.py',
        'llm_x/requirements.txt',
    ]
    assert archive.extractfile('llm_x/IGlobal.py').read() == b'x = 1'
    assert len(cli.order) - cli.order[::-1].index('cp') - 1 < cli.order.index('start')


async def test_the_runs_nodes_belong_to_the_user_the_task_runs_as(monkeypatch, tmp_path):
    """Every member is the task user's; folders and programs 0755, other files 0644, whatever the engine's disk says."""
    _ids(monkeypatch, 1001, 1001)
    node = _node(tmp_path, 'llm_x', {'IGlobal.py': '', 'tool.cmd': ''})
    os.chmod(os.path.join(node, 'IGlobal.py'), 0o666)
    os.chmod(os.path.join(node, 'tool.cmd'), 0o755)
    cli = FakeCli()
    await _launcher(cli).start(_spec(nodes=[node]))

    (_, copy) = [call for call in cli.calls if call.args[0] == 'cp']
    members = {member.name: member for member in tarfile.open(fileobj=io.BytesIO(copy.stdin)).getmembers()}
    assert {(m.uid, m.gid, m.uname, m.gname) for m in members.values()} == {(1001, 1001, '', '')}
    assert [members[name].mode for name in ('llm_x', 'llm_x/IGlobal.py', 'llm_x/tool.cmd')] == [0o755, 0o644, 0o755]


def test_links_in_a_node_folder_stay_out(tmp_path):
    """Only the folder's own files go in: a link could carry anything of the engine's host into the task."""
    node = _node(tmp_path, 'llm_x', {'IGlobal.py': ''})
    (tmp_path / 'secret').write_text('not for the task')
    try:
        os.symlink(tmp_path / 'secret', os.path.join(node, 'leak.txt'))
    except OSError:
        pytest.skip('this host cannot make a symbolic link')
    archive = tarfile.open(fileobj=io.BytesIO(dk.nodes_tar([node], 1000, 1000)))
    assert sorted(archive.getnames()) == ['llm_x', 'llm_x/.rrnode.sha256', 'llm_x/IGlobal.py']


def test_nodes_over_their_limit_are_refused(monkeypatch, tmp_path):
    """They are read into memory at every start, so their size is capped."""
    monkeypatch.setattr(dk, 'CONST_NODES_SIZE_LIMIT', 1024)
    node = _node(tmp_path, 'llm_x', {'model.bin': 'x' * 4096})
    with pytest.raises(ValueError, match="run's nodes take more than"):
        dk.nodes_tar([node], 1000, 1000)


async def test_create_finds_the_clis_config_but_the_task_never_sees_it():
    """Windows: docker create gets what the CLI reads its context from; none of it goes into the container."""
    environ = {
        'PATH': 'C:\\Windows\\system32',
        'USERPROFILE': 'C:\\Users\\eas',
        'APPDATA': 'C:\\Users\\eas\\AppData\\Roaming',
        'SYSTEMROOT': 'C:\\Windows',
    }
    cli = FakeCli()
    await _launcher(cli, environ=environ).start(_spec())
    create = cli.call('create')
    assert {name: create.env[name] for name in ('USERPROFILE', 'APPDATA', 'SYSTEMROOT')} == {
        'USERPROFILE': 'C:\\Users\\eas',
        'APPDATA': 'C:\\Users\\eas\\AppData\\Roaming',
        'SYSTEMROOT': 'C:\\Windows',
    }
    names = [create.args[i + 1] for i, a in enumerate(create.args) if a == '-e']
    assert not {'USERPROFILE', 'APPDATA', 'SYSTEMROOT'} & set(names)


async def test_the_clis_own_variables_never_go_in_from_the_task():
    """Docker create would hand the task the CLI's value of these: the daemon's address, its config and keys."""
    cli = FakeCli()
    spec = _spec()
    spec.env.update({'DOCKER_HOST': 'tcp://task:2375', 'DOCKER_CONFIG': '/task/docker', 'APPDATA': 'C:\\task'})
    await _launcher(cli).start(spec)
    names = [cli.call('create').args[i + 1] for i, a in enumerate(cli.call('create').args) if a == '-e']
    assert not {'DOCKER_HOST', 'DOCKER_CONFIG', 'APPDATA'} & set(names)


def test_task_data_path_is_the_images():
    """Tasks keep their data in the image's /opt/data."""
    assert _launcher().task_data_path == '/opt/data'


# ---------------------------------------------------------------------------
# The address
# ---------------------------------------------------------------------------


async def test_ip_mode_dials_the_container_ip_from_its_network():
    """In IP mode the engine dials the container's IP on its network, at port 5570."""
    cli = FakeCli()
    launch = await _launcher(cli).start(_spec())
    assert launch.address == '172.17.0.5:5570'
    inspects = [c.args for c in cli.calls if c.args[0] == 'inspect']
    assert ['inspect', '--format', '{{json .NetworkSettings.Networks}}', 'c0ffee'] in inspects


async def test_ip_mode_waits_for_the_daemon_to_give_an_ip(monkeypatch):
    """An IP the daemon has not assigned yet is polled for until it appears."""
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
    """In published mode the pool's port is published on loopback, dialled there and released by cleanup."""
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


async def test_exit_code_comes_from_the_cli_when_docker_wait_cannot_run():
    """A docker wait that cannot even be spawned (EMFILE, say): the CLI's code stands, so the task can end."""
    cli = FakeCli()
    original = cli.run

    async def run(args, *, stdin=None, env=None, check=True, timeout=dk.CONST_CLI_TIMEOUT):
        """The fake CLI, whose docker wait cannot be spawned."""
        if args[0] == 'wait':
            raise OSError(24, 'Too many open files')
        return await original(args, stdin=stdin, env=env, check=check, timeout=timeout)

    cli.run = run
    launch = await _launcher(cli).start(_spec())
    launch.process.returncode = 3
    assert await launch.wait() == 3
    assert launch.returncode == 3


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
        """Attach, and find the CLI already dead."""
        process = await original_attach(args)
        process.returncode = 1
        return process

    cli.attach = dead_attach
    with pytest.raises(DockerError, match='did not start'):
        await _launcher(cli).start(_spec())
    assert cli.calls[-1].args == ['rm', '-f', 'c0ffee']
    assert 'wait' not in cli.commands()


async def test_a_start_whose_every_look_is_slow_ends_in_time(monkeypatch):
    """Each look answers, slowly, that the container is only created: the start ends within its time, not its count."""
    monkeypatch.setattr(dk, 'CONST_CLI_TIMEOUT', 0.2)
    cli = FakeCli()
    cli.states = ['created']
    original = cli.run

    async def run(args, *, stdin=None, env=None, check=True, timeout=dk.CONST_CLI_TIMEOUT):
        """The fake CLI, whose every inspect takes a while to answer."""
        if args[0] == 'inspect':
            await asyncio.sleep(0.05)
        return await original(args, stdin=stdin, env=env, check=check, timeout=timeout)

    cli.run = run
    with pytest.raises(DockerError, match=r'did not start within 0\.2 s'):
        await _launcher(cli).start(_spec())
    assert len([c for c in cli.calls if '{{.State.Status}}' in c.args]) < 200
    assert cli.calls[-1].args == ['rm', '-f', 'c0ffee']


async def test_wait_survives_a_timeout_around_it():
    """_process_exit_code wraps wait() in a timeout; the watch on docker wait must outlive it."""
    gate = asyncio.Event()

    async def slow_wait(args):
        """A docker wait that returns only once the gate opens."""
        await gate.wait()
        return CliResult(0, '7\n', '')

    cli = FakeCli()

    async def run(args, *, stdin=None, env=None, check=True, timeout=dk.CONST_CLI_TIMEOUT):
        """The fake CLI, with docker wait held at the gate."""
        if args[0] == 'wait':
            return await slow_wait(args)
        return await FakeCli.run(cli, args, stdin=stdin, env=env, check=check, timeout=timeout)

    cli.run = run
    launch = await _launcher(cli).start(_spec())
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(launch.wait(), timeout=0.01)
    gate.set()
    assert await launch.wait() == 7


async def test_terminate_and_kill_go_through_the_daemon():
    """SIGTERM and SIGKILL reach the container as docker kill commands."""
    cli = FakeCli(wait=CliResult(0, '', ''))
    gate = asyncio.Event()
    original = cli.run

    async def run(args, *, stdin=None, env=None, check=True, timeout=dk.CONST_CLI_TIMEOUT):
        """The fake CLI, with docker wait held at the gate so the task keeps running."""
        if args[0] == 'wait':
            await gate.wait()
        return await original(args, stdin=stdin, env=env, check=check, timeout=timeout)

    cli.run = run
    launch = await _launcher(cli).start(_spec())
    launch.terminate()
    launch.kill()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    kills = [c.args for c in cli.calls if c.args[0] == 'kill']
    assert kills == [['kill', '-s', 'TERM', 'c0ffee'], ['kill', 'c0ffee']]
    gate.set()


def _running_engine(launch):
    """A running TaskEngine over ``launch``, with only what stop_task reads."""
    engine = TaskEngine.__new__(TaskEngine)
    engine.engine_key = 'enginehash:user-1'
    engine.state = EngineState.RUNNING
    engine._status = SimpleNamespace(state=TASK_STATE.RUNNING.value)
    engine._launch = launch
    engine._termination_lock = asyncio.Lock()
    engine._stop_count = 0
    engine._given_up_on = None
    engine.debug_message = MagicMock()
    return engine


async def test_a_stop_whose_kills_the_daemon_refuses_lets_go_and_a_later_stop_signals_again(monkeypatch):
    """An authorization plugin refuses docker kill, so the container runs on with its attach up.

    The stop gives up after its bound and says so, the lock is free, and the next stop sends both signals again.
    """
    monkeypatch.setattr(task_engine, 'CONST_CANCEL_WAIT_TIMEOUT_SECONDS', 0.01)
    monkeypatch.setattr(task_engine, 'CONST_STOP_WAIT_TIMEOUT', 0.2)
    said = []
    monkeypatch.setattr(task_engine, 'warning', said.append)
    cli = FakeCli(kill=CliResult(1, '', 'Error response from daemon: authorization denied by plugin authz'))
    gate = asyncio.Event()
    original = cli.run

    async def run(args, *, stdin=None, env=None, check=True, timeout=dk.CONST_CLI_TIMEOUT):
        """The fake CLI, with docker wait held at the gate so the container keeps running."""
        if args[0] == 'wait':
            await gate.wait()
        return await original(args, stdin=stdin, env=env, check=check, timeout=timeout)

    cli.run = run
    launch = await _launcher(cli).start(_spec())
    engine = _running_engine(launch)

    await asyncio.wait_for(TaskEngine.stop_task(engine, reason='ttl'), timeout=5)
    assert launch.returncode is None and engine.state is EngineState.STOPPING
    assert not engine._termination_lock.locked()
    assert len(said) == 1 and 'left running' in said[0]
    assert engine.left_running

    await asyncio.wait_for(TaskEngine.stop_task(engine, reason='user'), timeout=5)
    kills = [c.args for c in cli.calls if c.args[0] == 'kill']
    assert kills == [['kill', '-s', 'TERM', 'c0ffee'], ['kill', 'c0ffee']] * 2
    assert engine.left_running
    gate.set()


async def test_cleanup_removes_the_container_once():
    """Cleanup runs rm -f once, however often it is called."""
    cli = FakeCli()
    launch = await _launcher(cli).start(_spec())
    await launch.cleanup()
    await launch.cleanup()
    assert [c.args for c in cli.calls if c.args[0] == 'rm'] == [['rm', '-f', 'c0ffee']]


async def test_a_container_the_daemon_did_not_remove_keeps_its_port_until_it_goes():
    """A refused rm -f: cleanup says so and keeps the port; the next call removes it, and a container gone counts."""
    server = _server()
    cli = FakeCli(
        rm=CliResult(
            1,
            '',
            'Error response from daemon: cannot remove container "/c0ffee": could not kill: '
            'tried to kill container, but did not receive an exit event',
        )
    )
    launch = await _launcher(cli, server=server, publish='true').start(_spec())

    with pytest.raises(DockerError, match='docker rm failed'):
        await launch.cleanup()
    server.release_port.assert_not_called()

    cli.responses['rm'] = CliResult(1, '', 'Error response from daemon: No such container: c0ffee')
    await launch.cleanup()
    server.release_port.assert_called_once_with(20009)
    await launch.cleanup()
    assert cli.commands().count('rm') == 2


async def test_a_container_the_daemon_is_already_removing_counts_as_removed():
    """--rm and rm -f meet as the task exits: "already in progress" gives the port back at once."""
    server = _server()
    cli = FakeCli(rm=CliResult(1, '', 'Error response from daemon: removal of container c0ffee is already in progress'))
    launch = await _launcher(cli, server=server, publish='true').start(_spec())

    await launch.cleanup()
    server.release_port.assert_called_once_with(20009)
    await launch.cleanup()
    assert cli.commands().count('rm') == 1


async def test_metrics_come_from_docker_stats():
    """A task's CPU and memory come from docker stats, at most once a second."""
    launch = await _launcher().start(_spec())
    sampler = launch.metrics()['sampler']
    assert isinstance(sampler, DockerStatsSampler)
    assert sampler.min_interval >= 1.0


# ---------------------------------------------------------------------------
# rm -f on a failure at any step
# ---------------------------------------------------------------------------


async def test_a_create_that_fails_for_another_reason_says_so():
    """A network that is not found is no missing image: the daemon's own message comes up."""
    cli = FakeCli(create=CliResult(1, '', 'Error response from daemon: network tasks not found'))
    with pytest.raises(DockerError, match='network tasks not found'):
        await _launcher(cli).start(_spec())


async def test_a_cancelled_command_is_killed_and_reaped(monkeypatch):
    """A task stopped while docker create runs: the command does not go on to make a container nobody removes."""
    started = []
    real_exec = asyncio.create_subprocess_exec

    async def keep(*args, **kwargs):
        """Start the process, and keep it to look at."""
        process = await real_exec(*args, **kwargs)
        started.append(process)
        return process

    monkeypatch.setattr(dk.asyncio, 'create_subprocess_exec', keep)
    run = asyncio.ensure_future(dk.DockerCli(sys.executable).run(['-c', 'import time; time.sleep(60)'], timeout=None))
    while not started and not run.done():
        await asyncio.sleep(0.05)
    assert started, run.exception()
    run.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(run, 5)
    assert started[0].returncode is not None


@pytest.mark.parametrize(
    ('image', 'fix'),
    [
        ('rocketride/node:3.4.0', 'run ./builder container:build'),
        # container:build makes only the default image
        ('registry.example/team/node:dev', 'pull or load it'),
    ],
)
async def test_missing_image_says_how_to_get_it_and_never_pulls(monkeypatch, image, fix):
    """A missing image says how to get it; nothing is pulled, and the port goes back."""
    monkeypatch.setattr(dk, 'engine_version', lambda: '3.4.0')
    cli = FakeCli(create=CliResult(1, '', f'Error response from daemon: No such image: {image}'))
    server = _server()
    with pytest.raises(DockerError) as raised:
        await _launcher(cli, server=server, publish='true', image=image).start(_spec())
    assert str(raised.value) == f'Image {image} not found; {fix} (the runtime never pulls while a task starts)'
    assert 'rm' not in cli.commands()[2:]
    server.release_port.assert_called_once_with(20009)


@pytest.mark.parametrize('rm', [_hung, CliResult(1, '', 'Error response from daemon: removal failed')])
@pytest.mark.parametrize('failing', ['cp', 'start'])
async def test_a_rollback_that_fails_gives_the_port_back_only_before_docker_start(rm, failing, monkeypatch):
    """The rollback's rm -f hangs or is refused: it is logged, and the start's own failure is raised.

    Its port goes back only if docker start never ran: a container that started may hold it, as in cleanup().
    """
    monkeypatch.setattr(dk.asyncio, 'sleep', lambda _s, real=asyncio.sleep: real(0))
    logged = []
    monkeypatch.setattr(dk, 'debug', logged.append)
    server = _server()
    cli = FakeCli(rm=rm)
    if failing == 'cp':
        cli.responses['cp'] = CliResult(1, '', 'cp refused')
    else:
        cli.states = ['created']
    launcher = _launcher(cli, server=server, publish='true')
    with pytest.raises(DockerError, match='cp refused' if failing == 'cp' else 'did not start'):
        await launcher.start(_spec())
    if failing == 'cp':
        server.release_port.assert_called_once_with(20009)
    else:
        server.release_port.assert_not_called()
    assert any('could not remove c0ffee after a failed start' in line for line in logged)


async def test_a_task_that_exits_before_its_address_says_so(monkeypatch):
    """IP mode, and the task is gone before the daemon gave it an address: the error names its exit code."""
    monkeypatch.setattr(dk.asyncio, 'sleep', lambda _s, real=asyncio.sleep: real(0))
    logged = []
    monkeypatch.setattr(dk, 'debug', logged.append)

    class Crashed(FakeProcess):
        """A task that wrote its crash and exited with 3."""

        async def communicate(self, input=None):
            """What it wrote on stderr before it went."""
            return b'', b'Traceback: boom'

    async def gone(args):
        """The attached CLI of a task that has already exited."""
        return Crashed(returncode=3)

    cli = FakeCli()
    cli.networks = json.dumps({'bridge': {'IPAddress': ''}})
    cli.attach = gone
    with pytest.raises(DockerError, match=r'exited \(code 3\) before its address was read'):
        await _launcher(cli).start(_spec())
    assert any('Traceback: boom' in line for line in logged)


async def test_a_start_that_fails_after_attach_kills_and_reaps_the_cli(monkeypatch):
    """No IP ever comes: the attached docker start goes with the container, killed and waited for."""
    monkeypatch.setattr(dk.asyncio, 'sleep', lambda _s, real=asyncio.sleep: real(0))
    cli = FakeCli()
    cli.networks = json.dumps({'bridge': {'IPAddress': ''}})
    attached = []
    original_attach = cli.attach

    async def keep(args):
        """Attach, and keep the process to look at."""
        process = await original_attach(args)
        attached.append(process)
        return process

    cli.attach = keep
    with pytest.raises(DockerError, match='no IPv4 address'):
        await _launcher(cli).start(_spec())
    ((process),) = attached
    assert process.killed and process.returncode == -9
    assert cli.calls[-1].args == ['rm', '-f', 'c0ffee']


@pytest.mark.parametrize('failing', ['cp', 'attach', 'inspect'])
async def test_a_failure_after_create_removes_the_container(failing, monkeypatch):
    """Whichever step fails after create, the container is removed with rm -f."""
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
# The directories named in docker.mounts (the test mocks)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'path',
    [
        '/home/me/rr/nodes/test/mocks',
        # A Windows engine's path; elsewhere its ':' is refused (test_a_mount_whose_path_has_a_colon_stops_the_task)
        pytest.param('E:\\rr\\nodes\\test\\mocks', marks=pytest.mark.skipif(os.name != 'nt', reason='Windows path')),
    ],
)
async def test_a_variable_named_in_mounts_is_mounted_and_points_at_the_mount(monkeypatch, path):
    """The same on Linux and Windows: a Windows path is no path in a Linux container."""
    # As mounted_directories reads it: from Python 3.13 a POSIX path is not absolute on Windows
    expected = path if os.path.isabs(path) else os.path.abspath(path)
    monkeypatch.setattr(dk.os.path, 'isdir', lambda p: p == expected)
    spec = _spec()
    spec.env['RR_MOCK'] = path
    cli = FakeCli()
    await _launcher(cli, mounts='RR_MOCK').start(spec)
    create = cli.call('create')
    assert create.args[create.args.index('-v') + 1] == f'{expected}:/opt/mounts/RR_MOCK:ro'
    assert create.env['RR_MOCK'] == '/opt/mounts/RR_MOCK'


async def test_a_variable_not_named_in_mounts_is_not_mounted(tmp_path):
    """A variable outside docker.mounts is not mounted, whatever directory it names."""
    spec = _spec()
    spec.env['RR_MOCK'] = str(tmp_path)
    cli = FakeCli()
    await _launcher(cli).start(spec)
    assert '-v' not in cli.call('create').args


async def test_a_mount_whose_directory_is_missing_stops_the_task(tmp_path):
    """The host path would reach the task unchanged: the start fails before create, naming the variable."""
    spec = _spec()
    spec.env['RR_MOCK'] = str(tmp_path / 'missing')
    cli = FakeCli()
    with pytest.raises(DockerError, match='RR_MOCK is mounted'):
        await _launcher(cli, mounts='RR_MOCK').start(spec)
    assert 'create' not in cli.commands()


@pytest.mark.parametrize('name', ['HOME', 'PATH', 'DOCKER_CONFIG', 'USERPROFILE'])
async def test_a_mount_cannot_name_a_variable_of_the_engine_host(name):
    """The docker CLI keeps its own value of these, which the task would get instead of the mount."""
    cli = FakeCli()
    with pytest.raises(DockerError, match=f'{name} cannot be mounted'):
        await _launcher(cli, mounts=f'RR_MOCK,{name}').start(_spec())
    assert 'create' not in cli.commands()


@pytest.mark.skipif(os.name == 'nt', reason='no ":" in a Windows file name')
async def test_a_mount_whose_path_has_a_colon_stops_the_task(monkeypatch):
    """Docker -v would split the path: the start fails before create, naming the variable."""
    monkeypatch.setattr(dk.os.path, 'isdir', lambda p: True)
    spec = _spec()
    spec.env['RR_MOCK'] = '/srv/mo:cks'
    cli = FakeCli()
    with pytest.raises(DockerError, match='RR_MOCK is mounted.*has a ":"'):
        await _launcher(cli, mounts='RR_MOCK').start(spec)
    assert 'create' not in cli.commands()


async def test_a_relative_mount_path_goes_in_absolute(monkeypatch, tmp_path):
    """Docker -v reads a bare name as a named volume: a path relative to the engine's directory goes in absolute."""
    (tmp_path / 'mocks').mkdir()
    monkeypatch.chdir(tmp_path)
    spec = _spec()
    spec.env['RR_MOCK'] = 'mocks'
    cli = FakeCli()
    await _launcher(cli, mounts='RR_MOCK').start(spec)
    create = cli.call('create')
    assert create.args[create.args.index('-v') + 1] == f'{os.path.abspath("mocks")}:/opt/mounts/RR_MOCK:ro'


async def test_a_mount_whose_variable_is_unset_is_skipped():
    """Nothing to mount, nothing to point at: the task starts without it."""
    cli = FakeCli()
    await _launcher(cli, mounts='RR_MOCK').start(_spec())
    assert '-v' not in cli.call('create').args


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'address, expected',
    [
        ('127.0.0.1:5590', 'host.docker.internal:5590'),
        ('127.0.0.2:5590', 'host.docker.internal:5590'),
        ('localhost:5590', 'host.docker.internal:5590'),
        ('[::1]:5590', 'host.docker.internal:5590'),
        ('ws://localhost:5590/models', 'ws://host.docker.internal:5590/models'),
        ('postgresql://u:p@127.0.0.1:5432/db?x=1', 'postgresql://u:p@host.docker.internal:5432/db?x=1'),
        ('5590', '5590'),
        ('model.rocketride.dev:443', 'model.rocketride.dev:443'),
        ('postgresql://u:p@10.0.0.4:5432/db', 'postgresql://u:p@10.0.0.4:5432/db'),
        ('WSS://model.rocketride.dev:443', 'WSS://model.rocketride.dev:443'),
        ('PostgreSQL://u:p@10.0.0.4:5432/db?sslmode=require', 'PostgreSQL://u:p@10.0.0.4:5432/db?sslmode=require'),
        ('postgresql://db.internal/app?', 'postgresql://db.internal/app?'),
        ('postgresql:///db?host=10.0.0.4', 'postgresql:///db?host=10.0.0.4'),
        # A host list stays as it is, whatever form its first host has; a ',' in a password is no list
        ('postgresql://u@[::1]:5432,db.internal:5432/app', 'postgresql://u@[::1]:5432,db.internal:5432/app'),
        ('postgresql://u@127.0.0.1:5432,db.internal:5432/app', 'postgresql://u@127.0.0.1:5432,db.internal:5432/app'),
        ('postgresql://u:p,w@127.0.0.1:5432/db', 'postgresql://u:p,w@host.docker.internal:5432/db'),
    ],
)
def test_rewrite_loopback(address, expected):
    """Loopback hosts move to the host gateway, in every address form; any other address comes back as it was."""
    assert rewrite_loopback(address) == expected


@pytest.mark.parametrize(
    'text, expected',
    [('0B', 0), ('512KiB', 512 * 1024), ('12.5MiB', int(12.5 * 1024**2)), ('2GiB', 2 * 1024**3), ('3MB', 3_000_000)],
)
def test_parse_size(text, expected):
    """Sizes from docker stats, in decimal and binary units, as bytes."""
    assert parse_size(text) == expected


def test_parse_size_and_percent_reject_junk():
    """Text that is not a size or a percentage reads as None."""
    assert parse_size('lots') is None
    assert parse_percent('--') is None
    assert parse_percent('12.34%') == pytest.approx(12.34)


@pytest.mark.parametrize(
    'name',
    [
        'PATH',
        'HOME',
        'UV_CACHE_DIR',
        'XDG_RUNTIME_DIR',
        'SSL_CERT_FILE',
        'HF_HUB_CACHE',
        'TRANSFORMERS_CACHE',
        'TORCH_HOME',
    ],
)
def test_host_only_names(name):
    """Variables that describe the engine's host stay out of a container."""
    assert is_host_only(name)


@pytest.mark.parametrize('name', ['LANG', 'OPENAI_API_KEY', 'ROCKETRIDE_DB_DSNS', 'AWS_REGION', 'HTTP_PROXY'])
def test_task_names_pass(name):
    """Variables a task needs reach its container."""
    assert not is_host_only(name)


async def test_stats_sampler_reads_cpu_and_memory():
    """One docker stats call gives the CPU percentage and the memory in bytes."""
    row = {'CPUPerc': '150.25%', 'MemUsage': '256MiB / 2GiB'}
    cli = FakeCli(stats=CliResult(0, json.dumps(row) + '\n', ''))
    assert await DockerStatsSampler(cli, 'c0ffee').sample() == (pytest.approx(150.25), 256 * 1024**2)
    assert cli.calls[0].args == ['stats', '--no-stream', '--format', '{{json .}}', 'c0ffee']


@pytest.mark.parametrize('result', [CliResult(1, '', 'gone'), CliResult(0, 'not json', ''), CliResult(0, '', '')])
async def test_stats_sampler_returns_none_when_it_cannot_read(result):
    """A failed or unreadable docker stats is no reading."""
    cli = FakeCli(stats=result)
    assert await DockerStatsSampler(cli, 'c0ffee').sample() is None


async def test_stats_sampler_returns_none_when_docker_does_not_answer():
    """A docker stats that timed out is no reading either."""

    def no_answer(args):
        """The CLI's timeout, as DockerCli.run raises it."""
        raise DockerError('docker stats timed out after 60 s')

    cli = FakeCli(stats=no_answer)
    assert await DockerStatsSampler(cli, 'c0ffee').sample() is None


@pytest.fixture
def _no_docker_environment(monkeypatch):
    """Settings exported in the developer's shell do not reach the launcher."""
    for name in [n for n in os.environ if n.startswith('RR_DOCKER_')]:
        monkeypatch.delenv(name)


@pytest.mark.parametrize(
    'runtime, hosted, expected',
    [
        (None, False, 'spawn'),
        (None, True, 'spawn'),
        ('spawn', True, 'spawn'),
        ('docker', False, 'docker'),
    ],
)
def test_task_server_runtime_is_spawn_unless_given(monkeypatch, _no_docker_environment, runtime, hosted, expected):
    """A config without a runtime gets spawn, on a hosted engine too; a given one wins."""
    from ai.modules.task import task_server as ts

    monkeypatch.setattr(dk, 'engine_version', lambda: '3.4.0')
    monkeypatch.setattr('ai.modules.task.task_engine._is_saas_engine', lambda: hosted)
    server = ts.TaskServer.__new__(ts.TaskServer)
    server._config = {'port': 5565} if runtime is None else {'port': 5565, 'runtime': runtime}
    server._launcher = None
    launcher = server.launcher()
    assert (launcher.name, launcher.isolated) == (expected, expected == 'docker')
    # One launcher per process: a second one would remove the first one's containers when it starts
    assert server.launcher() is launcher


def test_create_launcher_builds_the_docker_runtime(monkeypatch, _no_docker_environment):
    """The docker runtime is built by name, with the image of the engine's version."""
    monkeypatch.setattr(dk, 'engine_version', lambda: '3.4.0')
    launcher = create_launcher('docker', _server())
    assert isinstance(launcher, DockerLauncher)
    assert launcher.config['image'] == 'rocketride/node:3.4.0'
