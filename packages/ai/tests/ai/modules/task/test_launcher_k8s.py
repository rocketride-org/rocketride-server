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
Unit tests for the Kubernetes runtime (``ai.modules.task.launcher.k8s``).

The ``K8sLauncher`` runs against a fake kubectl that records the argv of every
command and plays the cluster's side: the events of the pod watch, the first
line of a port-forward. No cluster is needed. Pinned here: the settings, the
Job name and label values, the manifest (isolation, stdin, resources, no
environment value, every ``$`` doubled), the start stream, the order ``create``
→ ``Running`` → ``attach`` → the stream, a start refused by a waiting reason,
the exit code from the watch and never from ``kubectl attach``, a lost pod,
``terminate`` and ``kill``, both address modes and the port's return, the
refusals (store, a loopback address without an alias), the sweep at start and
the cleanup on a failure, and the metrics sampler.
"""

from __future__ import annotations

import asyncio
import io
import json
import re
import shlex
import tarfile
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from ai.modules.task import launcher as launcher_pkg
from ai.modules.task.launcher import LaunchSpec, create_launcher
from ai.modules.task.launcher import k8s as k8
from ai.modules.task.launcher.docker import CliResult, DockerLauncher, StoreUnavailableError
from ai.modules.task.launcher.k8s import (
    BOOTSTRAP,
    K8sError,
    K8sLauncher,
    K8sMetricsSampler,
    KubectlCli,
    double_dollars,
    env_file,
    job_name,
    k8s_config,
    label_value,
    parse_quantity,
    payload_tar,
)

TOKEN_SHA = 'a' * 64
SELECTOR = 'rocketride.eas=host-a_5565'
METRICS_PATH = '/apis/metrics.k8s.io/v1beta1/namespaces/rocketride-tasks/pods/'

# The bootstrap as it runs on a cluster; the launcher must send exactly this.
# umask 077 covers what is unpacked; 022 is the image's own, which the engine has under docker
PINNED_BOOTSTRAP = (
    'set -eu\n'
    'umask 077\n'
    'n=$1; t=$2; shift 2\n'
    'timeout "$t" head -c "$n" | tar -xf - -C /opt/data\n'
    'if [ -f /opt/data/.rr-env ]; then set -a; . /opt/data/.rr-env; set +a; rm -f /opt/data/.rr-env; fi\n'
    'umask 022\n'
    'exec "$@"'
)


class FakeStream:
    """The output of a kubectl that keeps running: what the test feeds it, then EOF."""

    def __init__(self):
        self._chunks = asyncio.Queue()

    def feed(self, text):
        self._chunks.put_nowait(text.encode())

    def close(self):
        self._chunks.put_nowait(b'')

    async def readline(self):
        return await self._chunks.get()

    async def read(self, _size=-1):
        return await self._chunks.get()

    def __aiter__(self):
        return self

    async def __anext__(self):
        line = await self._chunks.get()
        if not line:
            raise StopAsyncIteration
        return line


class FakeStdin:
    """The stdin of the attached kubectl: what was written, and whether anyone closed it."""

    def __init__(self, log):
        self.written = b''
        self.closed = False
        self._log = log

    def write(self, data):
        self.written += data
        self._log.append('write')

    async def drain(self):
        self._log.append('drain')

    def close(self):
        self.closed = True


class FakeProcess:
    """A kubectl that keeps running: the attach, the watch or a port-forward."""

    def __init__(self, log=None):
        self.pid = 777
        self.returncode = None
        self.killed = False
        self.stdin = FakeStdin(log if log is not None else [])
        self.stdout = FakeStream()
        self._exited = asyncio.Event()

    def exit(self, code=0):
        """End by itself, as a watch the API server closed does."""
        self.returncode = code
        self.stdout.close()
        self._exited.set()

    def kill(self):
        self.killed = True
        if self.returncode is None:
            self.exit(-9)

    async def wait(self):
        await self._exited.wait()
        return self.returncode


class FakeKubectl:
    """Records every kubectl command; answers from ``responses`` keyed by the subcommand, and plays the watch."""

    def __init__(self, **responses):
        self.calls = []
        self.attached = []
        self.spawned = []
        self.watches = []
        self.forwards = []
        self.attach_process = None
        # What happened, in order: every command, and each write to the attach's stdin
        self.log = []
        self.responses = {'create': self._create}
        self.responses.update(responses)
        self.attach_error = None
        self.spawn_error = None
        # What the cluster shows of a new Job's pod, in turn: (phase, IP, exit code, waiting reason)
        self.pod_events = [
            ('Pending', '', '', ''),
            ('Pending', '', '', 'ContainerCreating'),
            ('Running', '10.1.0.7', '', ''),
        ]
        # What a port-forward prints before anything connects
        self.forward_says = ['Forwarding from 127.0.0.1:20009 -> 5570\n']

    def _create(self, args, stdin):
        """The cluster takes the Job and its pod appears on the watch."""
        for phase, ip, exit_code, waiting in self.pod_events:
            self.emit(phase, ip, exit_code, waiting, job=json.loads(stdin)['metadata']['name'])
        return CliResult(0, 'job.batch/created\n', '')

    @property
    def job(self):
        """The name of the Job created last."""
        return json.loads([call for call in self.calls if call.args[0] == 'create'][-1].stdin)['metadata']['name']

    @property
    def pod(self):
        """The name of that Job's pod."""
        return f'{self.job}-x7k2p'

    def emit(self, phase='Running', ip='10.1.0.7', exit_code='', waiting='', event='MODIFIED', job=None):
        """One line of the watch about a Job's pod."""
        job = job or self.job
        self.watches[-1].stdout.feed(f'{event}|{job}-x7k2p|{job}|{phase}|{ip}|{exit_code}|{waiting}\n')

    async def run(self, args, *, stdin=None, check=True):
        self.calls.append(SimpleNamespace(args=list(args), stdin=stdin))
        self.log.append(args[0])
        response = self.responses.get(args[0], CliResult(0, '', ''))
        result = response(list(args), stdin) if callable(response) else response
        if check and result.returncode != 0:
            raise K8sError(f'kubectl {args[0]} failed (exit {result.returncode}): {result.stderr}')
        return result

    async def attach(self, args):
        self.attached.append(list(args))
        self.log.append('attach')
        if self.attach_error:
            raise self.attach_error
        self.attach_process = FakeProcess(self.log)
        return self.attach_process

    async def spawn(self, args):
        self.spawned.append(list(args))
        if self.spawn_error:
            raise self.spawn_error
        process = FakeProcess()
        if args[0] == 'port-forward':
            self.log.append('port-forward')
            self.forwards.append(process)
            for line in self.forward_says:
                process.stdout.feed(line)
        else:
            self.log.append('watch')
            self.watches.append(process)
        return process

    def commands(self):
        """The subcommands run to completion so far, in order."""
        return [call.args[0] for call in self.calls]

    def call(self, subcommand):
        """The single call of a subcommand."""
        (found,) = [call for call in self.calls if call.args[0] == subcommand]
        return found

    def deletes(self, kind):
        """The ``delete <kind> ...`` calls, in order."""
        return [call.args for call in self.calls if call.args[:2] == ['delete', kind]]

    def manifest(self):
        """The Job that was created."""
        return json.loads(self.call('create').stdin)

    def container(self):
        """Its one container."""
        (container,) = self.manifest()['spec']['template']['spec']['containers']
        return container

    def payload(self):
        """The start stream written to the attach's stdin, as an archive."""
        return tarfile.open(fileobj=io.BytesIO(self.attach_process.stdin.written))

    def task_environment(self):
        """The environment the bootstrap would source, parsed the way a shell reads it."""
        text = self.payload().extractfile('.rr-env').read().decode()
        return dict(word.split('=', 1) for word in shlex.split(text) if word != 'export')


_launchers = []


@pytest.fixture(autouse=True)
async def _watches_end_with_the_test():
    """No watch outlives its test."""
    yield
    while _launchers:
        await _launchers.pop()._watcher.stop()


def _server():
    """A stand-in for TaskServer's pool and config."""
    return SimpleNamespace(
        _config={'port': 5565},
        assign_port=MagicMock(return_value=20009),
        release_port=MagicMock(),
    )


def _config(**overrides):
    """The k8s settings, with an explicit image so no engine version is needed, and a name for this host."""
    values = dict(k8.DEFAULT_CONFIG, image='rocketride/node:3.4.0', instance='host-a:5565', host_alias='eas-host')
    values.update(overrides)
    return values


def _launcher(cli=None, environ=None, server=None, **config):
    """A K8sLauncher over a fake kubectl; outside a cluster unless the environment says otherwise."""
    launcher = K8sLauncher(
        server or _server(),
        config=_config(**config),
        cli=cli or FakeKubectl(),
        environ=environ if environ is not None else {'PATH': '/usr/bin', 'HOME': '/home/eas'},
    )
    _launchers.append(launcher)
    return launcher


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
            'ROCKETRIDE_DB_DSNS': json.dumps({'tenant': 'postgresql://u:p%40ss@127.0.0.1:5432/tenant'}),
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


async def _settle():
    """Let the watch's reader take what was fed to it."""
    for _ in range(20):
        await asyncio.sleep(0)


def _no_waiting(monkeypatch):
    """Sleeps return at once: a watch is started again, and the pods counted, without delay."""
    monkeypatch.setattr(k8.asyncio, 'sleep', lambda _s, real=asyncio.sleep: real(0))


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def test_config_takes_server_config_over_environment_over_defaults(monkeypatch):
    monkeypatch.setattr(k8, 'engine_version', lambda: '3.4.0')
    cfg = k8s_config(
        {'port': 5566, 'k8s': {'memory': '4Gi', 'ttl': 60}},
        {'RR_K8S_MEMORY': '3Gi', 'RR_K8S_CPUS': '2', 'RR_K8S_REACH': 'POD', 'RR_K8S_NAMESPACE': 'tasks'},
    )
    assert cfg['memory'] == '4Gi'
    assert cfg['ttl'] == '60'
    assert cfg['cpus'] == '2'
    assert cfg['reach'] == 'pod'
    assert cfg['namespace'] == 'tasks'
    assert cfg['image_pull_policy'] == 'IfNotPresent'


def test_config_defaults(monkeypatch):
    monkeypatch.setattr(k8, 'engine_version', lambda: '3.4.0')
    monkeypatch.setattr(k8.socket, 'gethostname', lambda: 'box')
    assert k8s_config({}, {}) == {
        'namespace': 'rocketride-tasks',
        'context': '',
        'image': 'rocketride/node:3.4.0',
        'image_pull_policy': 'IfNotPresent',
        'memory': '2Gi',
        'cpus': '1',
        'memory_request': '256Mi',
        'cpu_request': '100m',
        'ephemeral_storage': '',
        'reach': 'auto',
        'host_alias': '',
        'mounts': '',
        'instance': 'box-5565',
        'node_selector': '',
        'tolerations': '',
        'node': '',
        'runtime_class': '',
        'start_timeout': '120',
        'ttl': '600',
    }


def test_config_instance_survives_a_restart(monkeypatch):
    """The hostname and the EAS port, not a per-process id, or the startup sweep matches nothing."""
    monkeypatch.setattr(k8, 'engine_version', lambda: '3.4.0')
    monkeypatch.setattr(k8.socket, 'gethostname', lambda: 'box')
    assert k8s_config({'port': 5566}, {})['instance'] == 'box-5566'
    assert k8s_config({}, {'RR_K8S_INSTANCE': 'eas-pod'})['instance'] == 'eas-pod'


def test_config_takes_the_pull_policy_in_any_case(monkeypatch):
    monkeypatch.setattr(k8, 'engine_version', lambda: '3.4.0')
    assert k8s_config({}, {'RR_K8S_IMAGE_PULL_POLICY': 'never'})['image_pull_policy'] == 'Never'


@pytest.mark.parametrize(
    'environ, named',
    [
        ({'RR_K8S_REACH': 'sometimes'}, 'reach'),
        ({'RR_K8S_IMAGE_PULL_POLICY': 'latest'}, 'image_pull_policy'),
        ({'RR_K8S_START_TIMEOUT': 'soon'}, 'start_timeout'),
        ({'RR_K8S_START_TIMEOUT': '0'}, 'start_timeout'),
        ({'RR_K8S_TTL': '-5'}, 'ttl'),
        ({'RR_K8S_NAMESPACE': ' '}, 'namespace'),
        ({'RR_K8S_MOUNTS': 'ROCKETRIDE_MOCK,../etc'}, 'mounts'),
        ({'RR_K8S_NODE_SELECTOR': 'pool'}, 'node_selector'),
        ({'RR_K8S_TOLERATIONS': 'dedicated=tasks'}, 'tolerations'),
        ({'RR_K8S_TOLERATIONS': '{"key": "dedicated"}'}, 'tolerations'),
        ({'RR_K8S_NODE': 'same'}, 'NODE_NAME'),
        ({'RR_K8S_INSTANCE': '...'}, 'instance'),
    ],
)
def test_config_refuses_what_it_cannot_use(monkeypatch, environ, named):
    monkeypatch.setattr(k8, 'engine_version', lambda: '3.4.0')
    with pytest.raises(ValueError, match=named):
        k8s_config({}, environ)


def test_config_node_same_is_the_engines_own_node(monkeypatch):
    monkeypatch.setattr(k8, 'engine_version', lambda: '3.4.0')
    assert k8s_config({}, {'RR_K8S_NODE': 'same', 'NODE_NAME': 'node-7'})['node'] == 'node-7'
    assert k8s_config({}, {'RR_K8S_NODE': 'node-2', 'NODE_NAME': 'node-7'})['node'] == 'node-2'


# ---------------------------------------------------------------------------
# The Job's name and the label values
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'task_id, stem',
    [
        ('proj.src', 'proj-src'),
        ('U1.Proj_A/src b', 'u1-proj-a-src-b'),
        ('..', 'task'),
        ('', 'task'),
        ('x' * 80, 'x' * 40),
        ('a' * 39 + '.b', 'a' * 39),
    ],
)
def test_job_name_is_a_dns_label_made_of_the_task_id(task_id, stem):
    name = job_name(task_id)
    assert re.fullmatch(rf'rr-{stem}-[0-9a-f]{{6}}', name)
    assert len(name) <= 63 - len('-x7k2p')


def test_job_name_tells_two_runs_of_a_task_apart():
    assert job_name('proj.src') != job_name('proj.src')


@pytest.mark.parametrize(
    'text, expected',
    [
        ('proj.src', 'proj.src'),
        ('host-a:5565', 'host-a_5565'),
        ('a b/c', 'a_b_c'),
        ('.hidden.', 'hidden'),
        ('x' * 70, 'x' * 63),
        ('x' * 62 + '..', 'x' * 62),
        ('', ''),
    ],
)
def test_label_value_fits_what_kubernetes_allows(text, expected):
    assert label_value(text) == expected


# ---------------------------------------------------------------------------
# prepare(): the startup sweep and the watch, once
# ---------------------------------------------------------------------------


async def test_prepare_sweeps_this_instances_leftovers_then_watches():
    cli = FakeKubectl()
    await _launcher(cli).prepare()
    assert cli.log == ['delete', 'watch']
    assert cli.call('delete').args == ['delete', 'jobs', '-l', SELECTOR, '--ignore-not-found', '--wait=false']
    assert cli.spawned == [
        [
            'get',
            'pods',
            '-l',
            SELECTOR,
            '--watch',
            '--output-watch-events',
            '-o',
            f'jsonpath={k8.WATCH_FORMAT}',
            # It ends itself: a watch whose engine went without a word must not live on
            '--request-timeout=300s',
        ]
    ]


def test_the_watch_prints_one_line_of_seven_fields_per_event():
    """Its type first (--output-watch-events wraps the pod in .object), then what a launch needs of its pod."""
    fields = k8.WATCH_FORMAT.removesuffix('{"\\n"}').split('|')
    assert fields == [
        '{.type}',
        '{.object.metadata.name}',
        '{.object.metadata.labels.job-name}',
        '{.object.status.phase}',
        '{.object.status.podIP}',
        '{.object.status.containerStatuses[0].state.terminated.exitCode}',
        '{.object.status.containerStatuses[0].state.waiting.reason}',
    ]


async def test_prepare_runs_once_however_many_tasks_start():
    """The sweep never runs per task: it would delete the Jobs of running siblings."""
    cli = FakeKubectl()
    launcher = _launcher(cli)
    await asyncio.gather(launcher.prepare(), launcher.start(_spec()), launcher.start(_spec()))
    await launcher.start(_spec())
    assert len(cli.deletes('jobs')) == 1
    assert len(cli.watches) == 1


async def test_prepare_failure_is_raised_and_retried():
    cli = FakeKubectl(delete=CliResult(1, '', 'Unable to connect to the server'))
    launcher = _launcher(cli)
    with pytest.raises(K8sError, match='Unable to connect'):
        await launcher.prepare()
    assert cli.watches == []
    cli.responses['delete'] = CliResult(0, '', '')
    await launcher.prepare()
    assert len(cli.deletes('jobs')) == 2
    assert len(cli.watches) == 1


async def test_the_sweep_says_how_many_jobs_it_removed(monkeypatch):
    said = []
    monkeypatch.setattr(k8, 'debug', said.append)
    swept = (
        'job.batch "rr-old-1a2b3c" deleted from rocketride-tasks namespace\n'
        'job.batch "rr-older-4d5e6f" deleted from rocketride-tasks namespace\n'
    )
    await _launcher(FakeKubectl(delete=CliResult(0, swept, ''))).prepare()
    assert any('removed 2 job(s) left by an earlier run of host-a:5565' in line for line in said)


async def test_a_missing_kubectl_is_named():
    cli = FakeKubectl()
    cli.spawn_error = FileNotFoundError('kubectl')
    with pytest.raises(K8sError, match='No usable kubectl for --runtime=k8s'):
        await _launcher(cli).prepare()


# ---------------------------------------------------------------------------
# The manifest
# ---------------------------------------------------------------------------


async def test_manifest_is_a_job_that_never_makes_a_second_pod():
    cli = FakeKubectl()
    await _launcher(cli, ttl='300').start(_spec())
    create = cli.call('create')
    assert create.args == ['create', '-f', '-']
    manifest = cli.manifest()
    assert (manifest['apiVersion'], manifest['kind']) == ('batch/v1', 'Job')
    assert manifest['spec']['backoffLimit'] == 0
    assert manifest['spec']['ttlSecondsAfterFinished'] == 300
    assert manifest['spec']['template']['spec']['restartPolicy'] == 'Never'


async def test_manifest_labels_are_cut_and_the_values_kept_in_annotations():
    cli = FakeKubectl()
    await _launcher(cli).start(_spec(task_id='u1.proj src'))
    metadata = cli.manifest()['metadata']
    labels = {'rocketride.task': 'u1.proj_src', 'rocketride.eas': 'host-a_5565'}
    assert re.fullmatch(r'rr-u1-proj-src-[0-9a-f]{6}', metadata['name'])
    assert metadata['labels'] == labels
    assert metadata['annotations'] == {'rocketride.task-id': 'u1.proj src', 'rocketride.eas-instance': 'host-a:5565'}
    # The pod carries them too: the watch and the sweep select by them
    assert cli.manifest()['spec']['template']['metadata']['labels'] == labels


async def test_manifest_carries_the_isolation():
    cli = FakeKubectl()
    await _launcher(cli).start(_spec())
    pod = cli.manifest()['spec']['template']['spec']
    assert pod['automountServiceAccountToken'] is False
    # Or the addresses of the namespace's services land in the task's environment
    assert pod['enableServiceLinks'] is False
    assert pod['securityContext'] == {
        'runAsNonRoot': True,
        'runAsUser': 1000,
        'runAsGroup': 1000,
        'seccompProfile': {'type': 'RuntimeDefault'},
    }
    assert cli.container()['securityContext'] == {
        'allowPrivilegeEscalation': False,
        'capabilities': {'drop': ['ALL']},
    }


async def test_manifest_stdin_is_open_once_and_never_a_tty():
    """Without stdin --autoterm ends the run at once; a tty would make its close a hangup, not EOF."""
    cli = FakeKubectl()
    await _launcher(cli).start(_spec())
    container = cli.container()
    assert container['name'] == 'task'
    assert (container['stdin'], container['stdinOnce'], container['tty']) == (True, True, False)


async def test_manifest_image_and_resources():
    cli = FakeKubectl()
    await _launcher(cli, image_pull_policy='Never').start(_spec())
    container = cli.container()
    assert (container['image'], container['imagePullPolicy']) == ('rocketride/node:3.4.0', 'Never')
    assert container['resources'] == {
        'requests': {'memory': '256Mi', 'cpu': '100m'},
        'limits': {'memory': '2Gi', 'cpu': '1'},
    }


async def test_manifest_limits_the_disk_only_when_configured():
    cli = FakeKubectl()
    await _launcher(cli, ephemeral_storage='4Gi').start(_spec())
    assert cli.container()['resources']['limits'] == {'memory': '2Gi', 'cpu': '1', 'ephemeral-storage': '4Gi'}


async def test_manifest_places_the_pod_only_when_configured():
    toleration = {'key': 'dedicated', 'operator': 'Equal', 'value': 'tasks', 'effect': 'NoSchedule'}
    cli = FakeKubectl()
    await _launcher(
        cli,
        node_selector='pool=tasks, zone=a',
        tolerations=json.dumps([toleration]),
        node='node-7',
        runtime_class='gvisor',
    ).start(_spec())
    pod = cli.manifest()['spec']['template']['spec']
    assert pod['nodeSelector'] == {'pool': 'tasks', 'zone': 'a'}
    assert pod['tolerations'] == [toleration]
    assert pod['nodeName'] == 'node-7'
    assert pod['runtimeClassName'] == 'gvisor'

    plain = FakeKubectl()
    await _launcher(plain).start(_spec())
    assert not {'nodeSelector', 'tolerations', 'nodeName', 'runtimeClassName'} & set(
        plain.manifest()['spec']['template']['spec']
    )


async def test_manifest_holds_no_environment_value_and_no_task_file():
    """Nothing of a task is stored in the cluster: both travel on the attach's stdin."""
    cli = FakeKubectl()
    await _launcher(cli).start(_spec())
    text = cli.call('create').stdin.decode()
    assert 'env' not in cli.container() and 'envFrom' not in cli.container()
    assert 'volumes' not in cli.manifest()['spec']['template']['spec']
    for secret in ('sk-secret', 's3cr3t', 'p%40ss', 'line one'):
        assert secret not in text


def test_bootstrap_is_the_pinned_script():
    assert BOOTSTRAP == PINNED_BOOTSTRAP


def test_bootstrap_unpacks_privately_and_gives_the_engine_the_images_umask():
    """What arrives is the owner's alone; what the task writes afterwards is as under docker."""
    lines = BOOTSTRAP.split('\n')
    assert lines.index('umask 077') < next(i for i, line in enumerate(lines) if 'tar -xf' in line)
    assert lines[-2:] == ['umask 022', 'exec "$@"']


async def test_command_is_the_bootstrap_then_the_engine():
    """The docker runtime's argv after the bootstrap's own: no --hosted, no --node_path, the port fixed."""
    cli = FakeKubectl()
    await _launcher(cli, start_timeout='90').start(_spec())
    command = cli.container()['command']
    assert command[:4] == ['sh', '-c', BOOTSTRAP.replace('$', '$$'), 'rr-task']
    # How many bytes of stdin are the start stream, and how long the pod waits for them
    assert command[4:6] == [str(len(cli.attach_process.stdin.written)), '90']
    assert command[6:] == [
        './engine',
        'ai/node.py',
        '/opt/data/task.json',
        '--autoterm',
        '--monitor=app',
        '--data_port=5570',
        '--data_host=0.0.0.0',
        f'--data_token_sha256={TOKEN_SHA}',
        '--modelserver=eas-host:5590',
        '--threads=2',
        '--trace=debugOut',
    ]
    assert '--hosted' not in command
    assert not any(element.startswith('--node_path') for element in command)


def test_engine_arguments_are_the_docker_runtimes():
    spec = _spec(modelserver='model.rocketride.dev:443')
    assert _launcher().task_args(spec) == DockerLauncher.task_args(spec)


async def test_every_dollar_in_the_command_is_doubled():
    """Kubernetes turns $$ into $ and expands $(NAME) in a command: doubled, both arrive as written."""
    cli = FakeKubectl()
    await _launcher(cli).start(_spec(pipeline_args=['--name=$(HOME)', '--cost=5$']))
    command = cli.container()['command']
    assert command[-3:-1] == ['--name=$$(HOME)', '--cost=5$$']
    assert not any('$' in element.replace('$$', '') for element in command)
    assert double_dollars(['a$b', '$$', 'plain']) == ['a$$b', '$$$$', 'plain']


# ---------------------------------------------------------------------------
# The start stream
# ---------------------------------------------------------------------------


def test_payload_is_the_task_file_and_the_environment_both_private():
    archive = tarfile.open(fileobj=io.BytesIO(payload_tar(b'{"a": 1}', {'LANG': 'C.UTF-8'}, {})))
    task, env = archive.getmembers()
    assert (task.name, env.name) == ('task.json', '.rr-env')
    for member in (task, env):
        assert (member.uid, member.gid, member.mode) == (1000, 1000, 0o600)
        assert member.isfile()
    assert archive.extractfile(task).read() == b'{"a": 1}'
    assert archive.extractfile(env).read() == b'export LANG=C.UTF-8\n'


def test_payload_has_no_member_for_the_root(tmp_path):
    """Unpacking ./ would change /opt/data itself."""
    (tmp_path / 'a.txt').write_bytes(b'a')
    archive = tarfile.open(fileobj=io.BytesIO(payload_tar(b'{}', {}, {'ROCKETRIDE_MOCK': str(tmp_path)})))
    assert not [name for name in archive.getnames() if name in ('', '.', './') or name.startswith(('/', './', '..'))]


def test_env_file_keeps_every_value_literal():
    """Quotes, $, backticks and line breaks reach the task as they are: a shell reads back what went in."""
    env = {
        'PLAIN': 'value',
        'EMPTY': '',
        'SPACED': 'two words',
        'TRICKY': 'line one\nit\'s "quoted" $HOME `id` $(id) \\ end',
    }
    text = env_file(env).decode()
    assert text.count('export ') == len(env)
    assert dict(word.split('=', 1) for word in shlex.split(text) if word != 'export') == env


def test_env_file_leaves_out_a_name_the_shell_cannot_hold():
    text = env_file({'GOOD_1': 'a', 'ProgramFiles(x86)': 'b', '1BAD': 'c', 'A B': 'd', 'X;rm -rf /': 'e'}).decode()
    assert text == 'export GOOD_1=a\n'


def test_payload_carries_the_mounted_directories(tmp_path):
    mocks = tmp_path / 'mocks'
    (mocks / 'pkg' / 'deep').mkdir(parents=True)
    (mocks / 'empty').mkdir()
    (mocks / 'a.py').write_bytes(b'a = 1\n')
    (mocks / 'pkg' / 'deep' / 'b.bin').write_bytes(b'\x00\x01' * 300)
    archive = tarfile.open(fileobj=io.BytesIO(payload_tar(b'{}', {}, {'ROCKETRIDE_MOCK': str(mocks)})))
    assert archive.getnames()[2:] == [
        'mounts/ROCKETRIDE_MOCK',
        'mounts/ROCKETRIDE_MOCK/a.py',
        'mounts/ROCKETRIDE_MOCK/empty',
        'mounts/ROCKETRIDE_MOCK/pkg',
        'mounts/ROCKETRIDE_MOCK/pkg/deep',
        'mounts/ROCKETRIDE_MOCK/pkg/deep/b.bin',
    ]
    assert archive.getmember('mounts/ROCKETRIDE_MOCK/empty').isdir()
    assert archive.extractfile('mounts/ROCKETRIDE_MOCK/a.py').read() == b'a = 1\n'
    assert archive.extractfile('mounts/ROCKETRIDE_MOCK/pkg/deep/b.bin').read() == b'\x00\x01' * 300


def test_payload_refuses_directories_over_the_limit(tmp_path, monkeypatch):
    """They travel in the start stream of every task, so their size is capped."""
    monkeypatch.setattr(k8, 'CONST_MOUNT_SIZE_LIMIT', 2 * 2**20)
    for name in ('one', 'two'):
        (tmp_path / name).mkdir()
        (tmp_path / name / 'blob').write_bytes(b'x' * (2**20 + 1))
    payload_tar(b'{}', {}, {'ONE': str(tmp_path / 'one')})
    with pytest.raises(K8sError, match='more than 2 MiB'):
        payload_tar(b'{}', {}, {'ONE': str(tmp_path / 'one'), 'TWO': str(tmp_path / 'two')})


def test_the_limit_on_mounted_directories_is_16_mib():
    assert k8.CONST_MOUNT_SIZE_LIMIT == 16 * 1024 * 1024


async def test_task_file_and_environment_go_in_on_the_attach_stdin():
    cli = FakeKubectl()
    await _launcher(cli).start(_spec())
    assert cli.payload().extractfile('task.json').read() == _spec().task_file
    env = cli.task_environment()
    assert env['OPENAI_API_KEY'] == 'sk-secret'
    assert env['MULTI'] == 'line one\nline two'


async def test_host_only_variables_stay_out():
    cli = FakeKubectl()
    await _launcher(cli).start(_spec())
    env = cli.task_environment()
    for host_only in ('PATH', 'HOME', 'UV_CACHE_DIR', 'XDG_CACHE_HOME'):
        assert host_only not in env
    assert env['LANG'] == 'C.UTF-8'


async def test_the_crashpad_database_has_a_fixed_place_in_the_pod():
    """The engine's own setting names a path of its host."""
    cli = FakeKubectl()
    spec = _spec()
    spec.env['ROCKETRIDE_CRASHDB_DIR'] = '/var/lib/eas/crashdb'
    await _launcher(cli).start(spec)
    assert cli.task_environment()['ROCKETRIDE_CRASHDB_DIR'] == '/opt/data/crashdb'


async def test_a_variable_named_in_mounts_travels_and_points_at_its_copy(tmp_path):
    (tmp_path / 'mock.py').write_bytes(b'mock = True\n')
    spec = _spec()
    spec.env['ROCKETRIDE_MOCK'] = str(tmp_path)
    cli = FakeKubectl()
    await _launcher(cli, mounts='ROCKETRIDE_MOCK').start(spec)
    assert cli.payload().extractfile('mounts/ROCKETRIDE_MOCK/mock.py').read() == b'mock = True\n'
    assert cli.task_environment()['ROCKETRIDE_MOCK'] == '/opt/data/mounts/ROCKETRIDE_MOCK'


async def test_a_variable_not_named_in_mounts_stays_a_host_path(tmp_path):
    spec = _spec()
    spec.env['ROCKETRIDE_MOCK'] = str(tmp_path)
    cli = FakeKubectl()
    await _launcher(cli).start(spec)
    assert cli.payload().getnames() == ['task.json', '.rr-env']
    assert cli.task_environment()['ROCKETRIDE_MOCK'] == str(tmp_path)


async def test_directories_over_the_limit_are_refused_before_anything_is_created(tmp_path, monkeypatch):
    monkeypatch.setattr(k8, 'CONST_MOUNT_SIZE_LIMIT', 10)
    (tmp_path / 'blob').write_bytes(b'x' * 11)
    spec = _spec()
    spec.env['ROCKETRIDE_MOCK'] = str(tmp_path)
    cli = FakeKubectl()
    with pytest.raises(K8sError, match='k8s.mounts'):
        await _launcher(cli, mounts='ROCKETRIDE_MOCK').start(spec)
    assert 'create' not in cli.commands()


# ---------------------------------------------------------------------------
# The order of a start
# ---------------------------------------------------------------------------


async def test_start_creates_waits_attaches_and_only_then_sends():
    cli = FakeKubectl()
    launch = await _launcher(cli).start(_spec())
    assert cli.log == ['delete', 'watch', 'create', 'attach', 'write', 'drain', 'port-forward']
    assert cli.attached == [['attach', '-i', '-q', '-c', 'task', cli.pod]]
    assert launch.process is cli.attach_process
    assert launch.pid == 777


async def test_attach_waits_for_the_watch_to_show_the_pod_running():
    """An attach does not wait: on a pod still being created it fails with 'container task not found'."""
    cli = FakeKubectl()
    cli.pod_events = [('Pending', '', '', ''), ('Pending', '10.1.0.7', '', 'ContainerCreating')]
    starting = asyncio.ensure_future(_launcher(cli).start(_spec()))
    while 'create' not in cli.log:
        await asyncio.sleep(0)
    await _settle()
    assert cli.attached == [] and not starting.done()
    cli.emit('Running')
    await starting
    assert cli.attached == [['attach', '-i', '-q', '-c', 'task', cli.pod]]


async def test_the_attach_stdin_stays_open_after_the_start_stream():
    """Closing it is how the task learns its engine is gone (--autoterm)."""
    cli = FakeKubectl()
    await _launcher(cli).start(_spec())
    assert cli.attach_process.stdin.written
    assert cli.attach_process.stdin.closed is False


async def test_events_of_other_jobs_are_not_this_launchs():
    cli = FakeKubectl()
    cli.pod_events = [('Pending', '', '', '')]
    starting = asyncio.ensure_future(_launcher(cli).start(_spec()))
    while 'create' not in cli.log:
        await asyncio.sleep(0)
    cli.emit('Running', job='rr-someone-else-000000')
    cli.watches[-1].stdout.feed('W1013 a warning from kubectl\n')
    await _settle()
    assert not starting.done()
    cli.emit('Running')
    await starting


@pytest.mark.parametrize(
    'reason, message',
    [
        ('ErrImageNeverPull', 'Image rocketride/node:3.4.0 not found on the node'),
        ('ImagePullBackOff', 'Image rocketride/node:3.4.0 cannot be pulled'),
        ('CreateContainerConfigError', 'CreateContainerConfigError'),
    ],
)
async def test_a_pod_that_cannot_start_is_a_clear_error_and_its_job_goes(reason, message):
    cli = FakeKubectl()
    cli.pod_events = [('Pending', '', '', ''), ('Pending', '10.1.0.7', '', reason)]
    server = _server()
    with pytest.raises(K8sError, match=message):
        await _launcher(cli, server=server).start(_spec())
    assert cli.attached == []
    assert cli.calls[-1].args == ['delete', 'job', cli.job, '--ignore-not-found', '--wait=false']
    server.assign_port.assert_not_called()


async def test_a_pod_that_never_runs_times_out_saying_where_it_stood():
    cli = FakeKubectl()
    cli.pod_events = [('Pending', '', '', 'ContainerCreating')]
    with pytest.raises(K8sError, match=r'did not start within 0.05 s \(Pending, ContainerCreating\)'):
        await _launcher(cli, start_timeout='0.05').start(_spec())
    assert cli.calls[-1].args[:3] == ['delete', 'job', cli.job]


async def test_a_job_whose_pod_never_appears_times_out():
    cli = FakeKubectl()
    cli.pod_events = []
    with pytest.raises(K8sError, match='no pod yet'):
        await _launcher(cli, start_timeout='0.05').start(_spec())


async def test_a_pod_that_ended_before_it_ran_is_not_attached_to():
    cli = FakeKubectl()
    cli.pod_events = [('Pending', '', '', ''), ('Failed', '10.1.0.7', '128', '')]
    with pytest.raises(K8sError, match='ended before the task was given to it .exit code 128.'):
        await _launcher(cli).start(_spec())
    assert cli.attached == []


# ---------------------------------------------------------------------------
# The address
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'reach, environ, expected',
    [
        ('auto', {}, True),
        ('auto', {'KUBERNETES_SERVICE_HOST': '10.96.0.1'}, False),
        ('pod', {}, False),
        ('forward', {'KUBERNETES_SERVICE_HOST': '10.96.0.1'}, True),
    ],
)
def test_forward_mode_follows_where_the_engine_runs(reach, environ, expected):
    assert _launcher(environ=environ, reach=reach).forwarded is expected


async def test_forward_mode_dials_loopback_and_gives_the_port_back():
    server = _server()
    cli = FakeKubectl()
    launch = await _launcher(cli, server=server).start(_spec())
    assert cli.spawned[-1] == ['port-forward', f'pod/{cli.pod}', '20009:5570', '--address', '127.0.0.1']
    assert launch.address == '127.0.0.1:20009'
    server.release_port.assert_not_called()
    await launch.cleanup()
    assert cli.forwards[0].killed
    server.release_port.assert_called_once_with(20009)


async def test_forward_mode_waits_until_the_forward_listens():
    cli = FakeKubectl()
    cli.forward_says = []
    starting = asyncio.ensure_future(_launcher(cli).start(_spec()))
    while not cli.forwards:
        await asyncio.sleep(0)
    await _settle()
    assert not starting.done()
    cli.forwards[0].stdout.feed('Forwarding from 127.0.0.1:20009 -> 5570\n')
    assert (await starting).address == '127.0.0.1:20009'


async def test_pod_mode_dials_the_pod_ip_and_takes_no_port():
    server = _server()
    cli = FakeKubectl()
    launch = await _launcher(cli, server=server, environ={'KUBERNETES_SERVICE_HOST': '10.96.0.1'}).start(_spec())
    assert launch.address == '10.1.0.7:5570'
    assert cli.forwards == []
    server.assign_port.assert_not_called()
    await launch.cleanup()
    server.release_port.assert_not_called()


async def test_pod_mode_waits_for_the_ip():
    cli = FakeKubectl()
    cli.pod_events = [('Running', '', '', '')]
    starting = asyncio.ensure_future(_launcher(cli, reach='pod').start(_spec()))
    while 'create' not in cli.log:
        await asyncio.sleep(0)
    await _settle()
    assert not starting.done()
    cli.emit('Running', ip='fd00::7')
    assert (await starting).address == '[fd00::7]:5570'


async def test_a_forward_that_does_not_come_up_fails_the_start_and_gives_the_port_back():
    server = _server()
    cli = FakeKubectl()
    cli.forward_says = ['error: unable to forward port because pod is not running\n', '']
    with pytest.raises(K8sError, match='port-forward to pod .* failed: error: unable to forward port'):
        await _launcher(cli, server=server).start(_spec())
    assert cli.forwards[0].killed and cli.attach_process.killed
    assert cli.calls[-1].args[:3] == ['delete', 'job', cli.job]
    server.release_port.assert_called_once_with(20009)


async def test_a_forward_that_stays_silent_is_given_up(monkeypatch):
    monkeypatch.setattr(k8, 'CONST_FORWARD_TIMEOUT', 0.05)
    server = _server()
    cli = FakeKubectl()
    cli.forward_says = []
    with pytest.raises(K8sError, match='did not listen within 0.05 s'):
        await _launcher(cli, server=server).start(_spec())
    assert cli.forwards[0].killed
    server.release_port.assert_called_once_with(20009)


# ---------------------------------------------------------------------------
# Exit code, stop, cleanup
# ---------------------------------------------------------------------------


async def test_exit_code_comes_from_the_watch_not_from_kubectl_attach():
    """The attach returns 0 whatever the task did; the pod's own code is 42."""
    cli = FakeKubectl()
    launch = await _launcher(cli).start(_spec())
    assert launch.returncode is None
    launch.process.exit(0)
    await _settle()
    assert launch.returncode is None
    # The code comes while the phase still reads Running
    cli.emit('Running', exit_code='42')
    assert await launch.wait() == 42
    assert launch.returncode == 42


async def test_wait_survives_a_timeout_around_it():
    """_process_exit_code wraps wait() in a timeout; the code must still arrive after it."""
    cli = FakeKubectl()
    launch = await _launcher(cli).start(_spec())
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(launch.wait(), timeout=0.01)
    cli.emit('Failed', exit_code='7')
    assert await launch.wait() == 7


async def test_the_first_exit_code_stays():
    cli = FakeKubectl()
    launch = await _launcher(cli).start(_spec())
    cli.emit('Running', exit_code='7')
    cli.emit('Failed', exit_code='7', event='DELETED')
    await _settle()
    assert launch.returncode == 7


async def test_a_pod_deleted_without_an_exit_code_is_lost():
    """Deleted by force, or by someone else: no code will come, so it reads as killed."""
    cli = FakeKubectl()
    launch = await _launcher(cli).start(_spec())
    cli.emit('Running', event='DELETED')
    assert await launch.wait() == -9


async def test_the_watch_is_started_again_when_it_ends(monkeypatch):
    _no_waiting(monkeypatch)
    cli = FakeKubectl()
    launcher = _launcher(cli)
    await launcher.prepare()
    cli.watches[0].stdout.feed('error: watch closed before UntilWithoutRetry timeout\n')
    cli.watches[0].exit(1)
    await _settle()
    assert len(cli.watches) == 2
    assert cli.spawned[1] == cli.spawned[0]
    # And a task started now is told of its pod by the new one
    launch = await launcher.start(_spec())
    cli.emit('Succeeded', exit_code='0')
    assert await launch.wait() == 0


async def test_a_watch_that_cannot_be_started_again_is_tried_again(monkeypatch):
    _no_waiting(monkeypatch)
    cli = FakeKubectl()
    launcher = _launcher(cli)
    await launcher.prepare()
    cli.spawn_error = OSError('no kubectl binary')
    cli.watches[0].exit(1)
    await _settle()
    assert len(cli.watches) == 1 and len(cli.spawned) > 2
    cli.spawn_error = None
    await _settle()
    assert len(cli.watches) == 2


async def test_a_pod_that_went_while_the_watch_was_down_is_lost(monkeypatch):
    """The new watch lists the pods that exist and says nothing of one that is gone."""
    _no_waiting(monkeypatch)
    cli = FakeKubectl()
    launcher = _launcher(cli)
    gone = await launcher.start(_spec())
    alive = await launcher.start(_spec(task_id='proj.other'))
    cli.responses['get'] = CliResult(0, f'{cli.pod} some-other-pod', '')
    cli.watches[0].exit(1)
    assert await gone.wait() == -9
    assert alive.returncode is None
    listing = [call.args for call in cli.calls if call.args[0] == 'get']
    assert listing == [['get', 'pods', '-l', SELECTOR, '-o', 'jsonpath={.items[*].metadata.name}']]


async def test_a_listing_that_fails_judges_nobody(monkeypatch):
    _no_waiting(monkeypatch)
    cli = FakeKubectl(get=CliResult(1, '', 'Unable to connect to the server'))
    launch = await _launcher(cli).start(_spec())
    cli.watches[0].exit(1)
    await _settle()
    assert 'get' in cli.commands()
    assert launch.returncode is None


async def test_terminate_and_kill_delete_the_pod():
    cli = FakeKubectl()
    launch = await _launcher(cli).start(_spec())
    launch.terminate()
    launch.kill()
    await _settle()
    assert cli.deletes('pod') == [
        ['delete', 'pod', cli.pod, '--grace-period=5', '--wait=false'],
        ['delete', 'pod', cli.pod, '--grace-period=0', '--force', '--wait=false'],
    ]


async def test_a_task_that_has_ended_is_not_signalled():
    cli = FakeKubectl()
    launch = await _launcher(cli).start(_spec())
    cli.emit('Succeeded', exit_code='0')
    await launch.wait()
    launch.terminate()
    launch.kill()
    await _settle()
    assert cli.deletes('pod') == []


async def test_cleanup_deletes_the_job_once():
    server = _server()
    cli = FakeKubectl()
    launch = await _launcher(cli, server=server).start(_spec())
    await launch.cleanup()
    await launch.cleanup()
    assert cli.deletes('job') == [['delete', 'job', cli.job, '--ignore-not-found', '--wait=false']]
    assert launch.job == cli.job
    server.release_port.assert_called_once_with(20009)
    # Nothing is signalled once the Job is gone
    launch.kill()
    await _settle()
    assert cli.deletes('pod') == []


async def test_cleanup_ends_a_wait_nobody_will_answer():
    """The Job goes and its pod with it: a code that has not come by now never will."""
    cli = FakeKubectl()
    launch = await _launcher(cli).start(_spec())
    waiting = asyncio.ensure_future(launch.wait())
    await launch.cleanup()
    assert await waiting == -9


async def test_a_cleanup_without_kubectl_still_gives_the_port_back():
    server = _server()
    cli = FakeKubectl()
    launch = await _launcher(cli, server=server).start(_spec())

    async def no_cli(args, *, stdin=None, check=True):
        raise OSError('no kubectl binary')

    cli.run = no_cli
    await launch.cleanup()
    server.release_port.assert_called_once_with(20009)


async def test_an_announced_dump_is_remembered_and_said_once_not_to_be_fetched(monkeypatch):
    said = []
    monkeypatch.setattr(k8, 'debug', said.append)
    cli = FakeKubectl()
    launch = await _launcher(cli).start(_spec())
    del said[:]
    launch.crash_dump_announced('engine.3.4.0.dmp')
    launch.crash_dump_announced('second.dmp')
    assert launch._dumps == ['engine.3.4.0.dmp', 'second.dmp']
    (line,) = said
    assert 'engine.3.4.0.dmp' in line and 'not fetched under --runtime=k8s' in line
    # Nothing is copied out of the pod yet
    await launch.cleanup()
    assert not {'exec', 'cp'} & set(cli.commands())


# ---------------------------------------------------------------------------
# The Job goes on a failure at any step
# ---------------------------------------------------------------------------


async def test_a_refused_job_is_an_error_and_takes_no_port():
    cli = FakeKubectl(create=CliResult(1, '', 'Error from server (Forbidden): jobs.batch is forbidden'))
    server = _server()
    with pytest.raises(K8sError, match='kubectl create failed .exit 1.: Error from server .Forbidden.'):
        await _launcher(cli, server=server).start(_spec())
    assert cli.attached == []
    server.assign_port.assert_not_called()
    server.release_port.assert_not_called()


@pytest.mark.parametrize('failing', ['attach', 'send', 'port'])
async def test_a_failure_after_create_deletes_the_job(failing):
    cli = FakeKubectl()
    server = _server()
    if failing == 'attach':
        cli.attach_error = OSError('no kubectl binary')
    elif failing == 'send':
        original = cli.attach

        async def broken_attach(args):
            process = await original(args)

            async def drain():
                raise ConnectionResetError('attach went away')

            process.stdin.drain = drain
            return process

        cli.attach = broken_attach
    else:
        server.assign_port.side_effect = RuntimeError('no free port')
    with pytest.raises((OSError, RuntimeError)):
        await _launcher(cli, server=server).start(_spec())
    assert cli.calls[-1].args == ['delete', 'job', cli.job, '--ignore-not-found', '--wait=false']
    if failing != 'attach':
        assert cli.attach_process.killed
    server.release_port.assert_not_called()


async def test_an_attach_that_does_not_take_the_start_stream_is_given_up():
    cli = FakeKubectl()
    original = cli.attach

    async def stuck_attach(args):
        process = await original(args)
        process.stdin.drain = asyncio.Event().wait
        return process

    cli.attach = stuck_attach
    with pytest.raises(K8sError, match='kubectl attach did not take the task within 0.05 s'):
        await _launcher(cli, start_timeout='0.05').start(_spec())
    assert cli.attach_process.killed
    assert cli.calls[-1].args[:3] == ['delete', 'job', cli.job]


async def test_a_start_that_is_cancelled_deletes_the_job():
    cli = FakeKubectl()
    cli.pod_events = [('Pending', '', '', '')]
    starting = asyncio.ensure_future(_launcher(cli).start(_spec()))
    while 'create' not in cli.log:
        await asyncio.sleep(0)
    starting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await starting
    assert cli.calls[-1].args[:3] == ['delete', 'job', cli.job]


# ---------------------------------------------------------------------------
# What is refused before anything is created
# ---------------------------------------------------------------------------


async def test_store_refused_on_a_filesystem_store(tmp_path):
    cli = FakeKubectl()
    environ = {'RR_STORE_URL': f'filesystem://{tmp_path}/store'}
    with pytest.raises(StoreUnavailableError, match='^tool_filesystem is not available under --runtime=k8s'):
        await _launcher(cli, environ=environ).start(_spec(uses_store=True, storage_root='users/u1/files'))
    assert 'create' not in cli.commands()
    assert not (tmp_path / 'store').exists()


async def test_store_refused_for_s3_through_a_web_identity_token():
    cli = FakeKubectl()
    environ = {'RR_STORE_URL': 's3://bucket/prefix', 'AWS_WEB_IDENTITY_TOKEN_FILE': '/var/run/secrets/token'}
    with pytest.raises(
        StoreUnavailableError, match='^tool_filesystem is not available under --runtime=k8s.*web-identity'
    ):
        await _launcher(cli, environ=environ).start(_spec(uses_store=True, storage_root='users/u1/files'))
    assert 'create' not in cli.commands()


async def test_s3_with_a_static_key_passes_through_the_environment():
    cli = FakeKubectl()
    environ = {'RR_STORE_URL': 's3://bucket/prefix', 'RR_STORE_SECRET_KEY': 'k'}
    spec = _spec(uses_store=True, storage_root='users/u1/files')
    spec.env['RR_STORE_SECRET_KEY'] = 'k'
    await _launcher(cli, environ=environ).start(spec)
    assert cli.task_environment()['RR_STORE_SECRET_KEY'] == 'k'


async def test_a_pipeline_that_opens_no_store_is_not_asked_about_it(tmp_path):
    cli = FakeKubectl()
    await _launcher(cli, environ={'RR_STORE_URL': f'filesystem://{tmp_path}/store'}).start(_spec())
    assert 'create' in cli.commands()


async def test_loopback_addresses_move_to_the_host_alias():
    cli = FakeKubectl()
    await _launcher(cli, host_alias='host.docker.internal').start(_spec())
    assert '--modelserver=host.docker.internal:5590' in cli.container()['command']
    assert json.loads(cli.task_environment()['ROCKETRIDE_DB_DSNS']) == {
        'tenant': 'postgresql://u:p%40ss@host.docker.internal:5432/tenant'
    }


@pytest.mark.parametrize(
    'overrides, named',
    [
        ({'modelserver': 'localhost:5590'}, '--modelserver'),
        ({'modelserver': 'ws://127.0.0.1:5590/models'}, '--modelserver'),
        ({'modelserver': None}, 'ROCKETRIDE_DB_DSNS'),
    ],
)
async def test_a_loopback_address_without_an_alias_is_refused_before_anything_is_created(overrides, named):
    cli = FakeKubectl()
    with pytest.raises(K8sError, match='RR_K8S_HOST_ALIAS') as refused:
        await _launcher(cli, host_alias='').start(_spec(**overrides))
    assert named in str(refused.value)
    # A DSN carries a password: the address itself is never repeated
    assert 'p%40ss' not in str(refused.value) and '127.0.0.1' not in str(refused.value)
    assert 'create' not in cli.commands()


async def test_addresses_of_other_hosts_need_no_alias():
    cli = FakeKubectl()
    spec = _spec(modelserver='model.rocketride.dev:443')
    spec.env['ROCKETRIDE_DB_DSNS'] = json.dumps({'tenant': 'postgresql://u:p@10.0.0.4:5432/db'})
    await _launcher(cli, host_alias='').start(spec)
    assert '--modelserver=model.rocketride.dev:443' in cli.container()['command']
    assert json.loads(cli.task_environment()['ROCKETRIDE_DB_DSNS']) == {'tenant': 'postgresql://u:p@10.0.0.4:5432/db'}


async def test_only_the_loopback_dsns_of_the_map_move_to_the_host_alias():
    cli = FakeKubectl()
    spec = _spec()
    spec.env['ROCKETRIDE_DB_DSNS'] = json.dumps(
        {'tenant': 'postgresql://u:p@localhost:5432/t', 'shared': 'postgresql://u:p@db.internal:5432/s'}
    )
    await _launcher(cli, host_alias='host.docker.internal').start(spec)
    assert json.loads(cli.task_environment()['ROCKETRIDE_DB_DSNS']) == {
        'tenant': 'postgresql://u:p@host.docker.internal:5432/t',
        'shared': 'postgresql://u:p@db.internal:5432/s',
    }


@pytest.mark.parametrize('value', ['not json', '["postgresql://u:p@127.0.0.1:5432/db"]', '{"tenant": 5}'])
async def test_a_dsns_value_that_is_no_map_of_strings_passes_as_it_is(value):
    """What the docker runtime does too: the node that reads it says what is wrong."""
    cli = FakeKubectl()
    spec = _spec(modelserver='model.rocketride.dev:443')
    spec.env['ROCKETRIDE_DB_DSNS'] = value
    await _launcher(cli, host_alias='').start(spec)
    assert cli.task_environment()['ROCKETRIDE_DB_DSNS'] == value


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def _pod_metrics(*usages):
    """What the metrics API answers for a pod: one usage per container."""
    return json.dumps(
        {
            'kind': 'PodMetrics',
            'window': '15s',
            'containers': [{'name': f'c{i}', 'usage': usage} for i, usage in enumerate(usages)],
        }
    )


async def test_metrics_sampler_reads_cpu_and_memory():
    """Nanocores to percent summed over cores, the way psutil reports it."""
    cli = FakeKubectl(get=CliResult(0, _pod_metrics({'cpu': '1502500000n', 'memory': '262144Ki'}), ''))
    assert await K8sMetricsSampler(cli, 'rocketride-tasks', 'rr-x-abc').sample() == (
        pytest.approx(150.25),
        256 * 1024**2,
    )
    assert cli.calls[0].args == ['get', '--raw', f'{METRICS_PATH}rr-x-abc']


async def test_metrics_sampler_adds_up_the_containers():
    cli = FakeKubectl(
        get=CliResult(0, _pod_metrics({'cpu': '250m', 'memory': '1Mi'}, {'cpu': '1', 'memory': '1024'}), '')
    )
    assert await K8sMetricsSampler(cli, 'ns', 'pod').sample() == (pytest.approx(125.0), 2**20 + 1024)


@pytest.mark.parametrize(
    'result',
    [
        # No metrics API in the cluster
        CliResult(1, '', 'Error from server (NotFound): the server could not find the requested resource'),
        # No sample of this pod yet
        CliResult(1, '', 'Error from server (NotFound): pods.metrics.k8s.io "rr-x-abc" not found'),
        CliResult(0, 'not json', ''),
        CliResult(0, '[]', ''),
        CliResult(0, _pod_metrics(), ''),
        CliResult(0, _pod_metrics({'cpu': 'lots', 'memory': '1Mi'}), ''),
        CliResult(0, _pod_metrics({'memory': '1Mi'}), ''),
    ],
)
async def test_metrics_sampler_returns_none_when_it_cannot_read(result):
    cli = FakeKubectl(get=result)
    assert await K8sMetricsSampler(cli, 'rocketride-tasks', 'rr-x-abc').sample() is None


async def test_metrics_sampler_returns_none_when_kubectl_times_out():
    """A metrics API that does not answer costs a reading, not the task."""
    cli = FakeKubectl()

    async def hung(args, *, stdin=None, check=True):
        raise K8sError('kubectl get timed out after 60 s')

    cli.run = hung
    assert await K8sMetricsSampler(cli, 'rocketride-tasks', 'rr-x-abc').sample() is None


class HungKubectl:
    """A kubectl process whose API server never answers: it ends only when killed."""

    def __init__(self):
        self.returncode = None
        self._killed = asyncio.Event()

    def kill(self):
        """End it, as SIGKILL would."""
        self.returncode = -9
        self._killed.set()

    async def communicate(self, data=None):
        """Wait for the answer that never comes, unless killed."""
        await self._killed.wait()
        return b'', b''


async def test_a_kubectl_command_that_does_not_end_is_killed(monkeypatch):
    """An unreachable API server keeps kubectl waiting without end: the run gives up, kills it and reaps it."""
    hung = HungKubectl()

    async def spawn(*args, **kwargs):
        """Hand over the hung process."""
        return hung

    monkeypatch.setattr(k8.asyncio, 'create_subprocess_exec', spawn)
    with pytest.raises(K8sError, match='kubectl get timed out after 0.05 s'):
        await KubectlCli().run(['get', 'pods'], timeout=0.05)
    assert hung.returncode == -9


async def test_a_kubectl_command_is_killed_when_its_run_is_cancelled(monkeypatch):
    """A cancelled start leaves no kubectl behind, a create that would make a Job nobody removes included."""
    hung = HungKubectl()

    async def spawn(*args, **kwargs):
        """Hand over the hung process."""
        return hung

    monkeypatch.setattr(k8.asyncio, 'create_subprocess_exec', spawn)
    run = asyncio.ensure_future(KubectlCli().run(['create', '-f', '-'], stdin=b'{}'))
    await asyncio.sleep(0)
    run.cancel()
    with pytest.raises(asyncio.CancelledError):
        await run
    assert hung.returncode == -9


async def test_removing_a_job_never_raises_when_kubectl_times_out():
    """remove() runs while a failure is on its way up: a cluster that does not answer is only logged."""
    launcher = _launcher(FakeKubectl())

    async def hung(args, *, stdin=None, check=True):
        raise K8sError('kubectl delete timed out after 60 s')

    launcher._cli.run = hung
    await launcher.remove('rr-x-abc')


async def test_metrics_sampler_returns_none_without_kubectl():
    cli = FakeKubectl()

    async def no_cli(args, *, stdin=None, check=True):
        raise OSError('no kubectl binary')

    cli.run = no_cli
    assert await K8sMetricsSampler(cli, 'rocketride-tasks', 'rr-x-abc').sample() is None


async def test_metrics_come_from_the_metrics_api_no_oftener_than_it_measures():
    cli = FakeKubectl()
    launch = await _launcher(cli).start(_spec())
    sampler = launch.metrics()['sampler']
    assert isinstance(sampler, K8sMetricsSampler)
    assert sampler.min_interval == 15.0
    await sampler.sample()
    assert cli.calls[-1].args == ['get', '--raw', f'{METRICS_PATH}{cli.pod}']


@pytest.mark.parametrize(
    'text, expected',
    [
        ('1502500000n', 1.5025),
        ('250000u', 0.25),
        ('250m', 0.25),
        ('2', 2.0),
        ('0.5', 0.5),
        ('262144Ki', 256 * 1024**2),
        ('128Mi', 128 * 1024**2),
        ('2Gi', 2 * 1024**3),
        ('3M', 3_000_000),
        ('1024', 1024),
    ],
)
def test_parse_quantity(text, expected):
    assert parse_quantity(text) == pytest.approx(expected)


@pytest.mark.parametrize('text', ['lots', '', None, '12 parsecs', '1ki'])
def test_parse_quantity_rejects_junk(text):
    assert parse_quantity(text) is None


# ---------------------------------------------------------------------------
# The CLI
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'context, expected',
    [
        ('docker-desktop', ['--context', 'docker-desktop', '-n', 'rocketride-tasks', 'get', 'pods']),
        ('', ['-n', 'rocketride-tasks', 'get', 'pods']),
    ],
)
def test_every_command_names_its_namespace_and_the_context_when_set(context, expected):
    assert KubectlCli(context=context, namespace='rocketride-tasks').argv(['get', 'pods']) == expected


async def test_the_cli_runs_kubectl_in_the_configured_scope(monkeypatch):
    """run, attach and spawn all go through one place that adds the scope; kubectl keeps the engine's environment."""
    started = []

    class Finished:
        returncode = 1

        async def communicate(self, _stdin=None):
            return b'', b'Error from server (NotFound): namespaces "nope" not found\n'

    async def fake_exec(*argv, **kwargs):
        started.append((list(argv), kwargs))
        return Finished()

    monkeypatch.setattr(k8.asyncio, 'create_subprocess_exec', fake_exec)
    monkeypatch.setattr(k8, '_helpers', set())
    cli = KubectlCli(context='kind-dev', namespace='nope')
    with pytest.raises(K8sError, match=r'kubectl create failed \(exit 1\): Error from server \(NotFound\)'):
        await cli.run(['create', '-f', '-'], stdin=b'{}')
    assert (await cli.run(['get', 'pods'], check=False)).returncode == 1
    await cli.attach(['attach', '-i', '-q', '-c', 'task', 'pod-1'])
    await cli.spawn(['port-forward', 'pod/pod-1', '20009:5570'])
    scope = ['kubectl', '--context', 'kind-dev', '-n', 'nope']
    assert [argv[:6] for argv, _ in started] == [
        [*scope, 'create'],
        [*scope, 'get'],
        [*scope, 'attach'],
        [*scope, 'port-forward'],
    ]
    assert all('env' not in kwargs for _, kwargs in started)
    # The attach carries the task's stdio; a helper's two outputs are one stream, read by one reader
    attach, spawn = started[2][1], started[3][1]
    assert attach['stdin'] == attach['stdout'] == attach['stderr'] == asyncio.subprocess.PIPE
    assert (spawn['stdin'], spawn['stderr']) == (asyncio.subprocess.DEVNULL, asyncio.subprocess.STDOUT)


def test_the_launcher_builds_its_cli_from_the_settings():
    launcher = K8sLauncher(_server(), config=_config(context='kind-dev', namespace='tasks'), environ={})
    assert (launcher._cli.context, launcher._cli.namespace) == ('kind-dev', 'tasks')


# ---------------------------------------------------------------------------
# The helper processes when the engine exits
# ---------------------------------------------------------------------------


class Helper:
    """A kubectl the real CLI started: only what the exit hook may still use once the event loop is closed."""

    def __init__(self, pid, returncode=None):
        self.pid = pid
        self.returncode = returncode

    def kill(self):
        raise AssertionError('the exit hook signals by pid: the transport needs the event loop')

    async def wait(self):
        self.returncode = -9
        return self.returncode


def _helpers_of(monkeypatch, *helpers):
    """A CLI whose spawn() hands out these processes, over an empty register; returns the pids signalled."""
    signalled = []
    handed = iter(helpers)

    async def fake_exec(*_argv, **_kwargs):
        return next(handed)

    monkeypatch.setattr(k8.asyncio, 'create_subprocess_exec', fake_exec)
    monkeypatch.setattr(k8, '_helpers', set())
    monkeypatch.setattr(k8.os, 'kill', lambda pid, sig: signalled.append((pid, sig)))
    return KubectlCli(namespace='rocketride-tasks'), signalled


async def test_helpers_still_running_are_ended_by_pid_as_the_engine_exits(monkeypatch):
    """A watch and a port-forward have no stdin to see the engine go, and a child is not ended with its parent."""
    watch, forward, ended = Helper(4101), Helper(4102), Helper(4103, returncode=1)
    cli, signalled = _helpers_of(monkeypatch, watch, forward, ended)
    for _ in range(3):
        await cli.spawn(['port-forward', 'pod/pod-1', '20009:5570'])
    k8._end_helpers()
    assert sorted(signalled) == [(4101, k8.signal.SIGTERM), (4102, k8.signal.SIGTERM)]
    # Once: a second call finds nothing left to end
    k8._end_helpers()
    assert len(signalled) == 2


async def test_only_what_outlives_the_engine_is_kept_for_the_exit_hook(monkeypatch):
    """The attach is not: its stdin is the engine's, and it ends when that closes."""
    cli, signalled = _helpers_of(monkeypatch, Helper(4201), Helper(4202))
    await cli.attach(['attach', '-i', '-q', '-c', 'task', 'pod-1'])
    await cli.spawn(['get', 'pods', '--watch'])
    k8._end_helpers()
    assert signalled == [(4202, k8.signal.SIGTERM)]


async def test_a_helper_that_was_stopped_is_not_signalled_again(monkeypatch):
    """Its pid may be another process's by the time the engine exits."""
    helper = Helper(4301, returncode=0)
    cli, signalled = _helpers_of(monkeypatch, helper)
    await cli.spawn(['port-forward', 'pod/pod-1', '20009:5570'])
    await k8._stop(helper)
    assert k8._helpers == set()
    helper.returncode = None
    k8._end_helpers()
    assert signalled == []


async def test_a_watch_that_ended_by_itself_is_not_signalled(monkeypatch):
    cli = FakeKubectl()
    launcher = _launcher(cli)
    await launcher.prepare()
    monkeypatch.setattr(k8, '_helpers', {cli.watches[0]})
    cli.watches[0].exit(0)
    await _settle()
    assert k8._helpers == set()


async def test_the_exit_hook_survives_a_helper_that_is_already_gone(monkeypatch):
    cli, _ = _helpers_of(monkeypatch, Helper(4401), Helper(4402))
    await cli.spawn(['get', 'pods', '--watch'])
    await cli.spawn(['port-forward', 'pod/pod-1', '20009:5570'])
    signalled = []

    def gone(pid, _sig):
        signalled.append(pid)
        raise ProcessLookupError(pid)

    monkeypatch.setattr(k8.os, 'kill', gone)
    k8._end_helpers()
    assert sorted(signalled) == [4401, 4402]
    assert k8._helpers == set()


# ---------------------------------------------------------------------------
# Runtime selection
# ---------------------------------------------------------------------------


def test_k8s_is_a_runtime_and_never_the_default():
    assert launcher_pkg.RUNTIMES == ('spawn', 'docker', 'k8s')
    assert 'k8s' not in (launcher_pkg.default_runtime(True), launcher_pkg.default_runtime(False))


def test_create_launcher_builds_the_k8s_runtime(monkeypatch):
    monkeypatch.setattr(k8, 'engine_version', lambda: '3.4.0')
    launcher = create_launcher('k8s', _server())
    assert isinstance(launcher, K8sLauncher)
    assert (launcher.name, launcher.isolated) == ('k8s', True)
    assert launcher.config['image'] == 'rocketride/node:3.4.0'


def test_task_data_path_is_the_images():
    assert _launcher().task_data_path == '/opt/data'


def test_task_server_runs_k8s_when_told_to(monkeypatch):
    from ai.modules.task import task_server as ts

    monkeypatch.setattr(k8, 'engine_version', lambda: '3.4.0')
    server = ts.TaskServer.__new__(ts.TaskServer)
    server._config = {'port': 5565, 'runtime': 'k8s'}
    server._launcher = None
    assert server.launcher().name == 'k8s'
