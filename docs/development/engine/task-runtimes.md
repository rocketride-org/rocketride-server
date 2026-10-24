# Testing the task runtimes

The engine server (`ai/eaas.py`) runs every pipeline as a **task**, and
`--runtime` decides what a task is: a child process, a container or a
Kubernetes Job. This page is about testing all three end to end, and seeing
what happens while you do. What each runtime does and every `RR_DOCKER_*` and
`RR_K8S_*` setting is on the public page
[Tasks in Containers](../../public/product/operate/self-hosting/task-containers.md);
none of that is repeated here.

Commands are given as `./builder`; on Windows type `.\builder`. Where the two
shells differ, both are shown.

## The three runtimes

| `--runtime` | A task is                                        | What it needs                                                                      |
| ----------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `spawn`     | a child process of the engine                    | nothing beyond a build                                                             |
| `docker`    | a container from `rocketride/node:<version>`     | a docker daemon, and that image on it                                              |
| `k8s`       | a Kubernetes Job of one pod, from the same image | `kubectl`, a cluster on your machine, a namespace, and the image where pods get it |

Without the flag an engine runs `spawn`, or `docker` when it is started with
`--saas`. `k8s` is never a default.

## Preparing

`spawn` needs only `./builder build`. To see that the engine starts, from
`dist/server`: `./engine -c "print('engine loads')"`.

### docker

The node image is built from a Linux `dist/server`, so where you build it
depends on your OS ([Image tasks](../../../docker/README.md#image-tasks) has
the details):

| You are on | Run                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| Linux      | `./builder container:build`                                                                                                 |
| Windows    | `.\builder container:build-on-wsl --checkout=<the checkout in WSL>`, then `.\builder container:sync-from-wsl`               |
| macOS      | pull the published node image of the engine's version and tag it `rocketride/node:<version>` (there is no local build task) |

```bash
docker images rocketride/node                 # expect <version> and <version>-clean
docker info --format '{{.OperatingSystem}}'   # which daemon: Docker Desktop, or a Linux engine
docker system df                              # the image takes several gigabytes
```

The first build is long: it fills the image's wheel cache. A rebuild with
nothing changed takes seconds.

A task runs the Python that is **in the image**, not the one in your checkout.
After editing Python, refresh the image, which takes seconds:

```bash
./builder container:sync
```

The checks `container:test` makes on the image are two shell scripts, and each
runs alone against a daemon that has the image (on Windows, run them in the
WSL distribution):

```bash
sh docker/test-node-image.sh rocketride/node:<version>         # the engine as a task gets it, offline installs
sh docker/test-node-crash-dump.sh rocketride/node:<version>    # a crash leaves a minidump that can be copied out
```

#### On Windows: the image comes from WSL

`dist\server` on Windows holds a Windows engine, so the image's binaries are
built in a second checkout, inside a WSL distribution, and reach Docker Desktop
from there. Three tasks, run in the Windows checkout, in this order:

| Step | Run                                                         | Needed after                                                       |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| 1    | `.\builder container:build-on-wsl --checkout=<path in WSL>` | a change to C++, or to anything else that step 3 does not carry    |
| 2    | `.\builder container:sync-from-wsl`                         | every step 1, when the distribution has a docker daemon of its own |
| 3    | `.\builder container:sync`                                  | a change to Python; after such a change this step alone is enough  |

Step 1 builds whatever the WSL checkout has checked out. It touches neither
tree, prints the commit of each, and warns when they differ. So bring that
checkout to your commit first; no push is needed, it can fetch from the
Windows checkout:

```bash
# in the WSL checkout; a fetch carries commits, not uncommitted changes
git fetch /mnt/<drive>/<path to the Windows checkout> <branch>
git switch --detach FETCH_HEAD
```

`RR_WSL_CHECKOUT` stands in for `--checkout=`, and `--distro=` or
`RR_WSL_DISTRO` names a distribution other than `Ubuntu-22.04`. Steps 1 and 2
check the WSL side first and name the first missing piece. With Docker
Desktop's WSL integration turned on for the distribution, both sides share one
daemon and step 2 reports that there is nothing to copy.
[Image tasks](../../../docker/README.md#image-tasks) has the rest.

Step 3 copies the Python trees of `dist\server` — `ai/`, `nodes/`,
`rocketride/` and `rocketride_common/` — over the image. The engine,
`libengine.so`, the C++ nodes and the other libraries come only from step 1.

**Nothing on Windows notices stale binaries.** On Linux `container:sync`
compares `dist/server/libengine.so` with the image's `rocketride.engine-sha256`
label and warns when they differ. On Windows there is no Linux engine to
compare with, so it only notes that the image keeps the engine it was built
with: an image can carry today's Python on an engine built days ago. To see
it, read the label on both sides:

```powershell
docker inspect --format '{{json .Config.Labels}}' rocketride/node:<version>-clean
wsl -d Ubuntu-22.04 -- docker inspect --format '{{json .Config.Labels}}' rocketride/node:<version>-clean
```

The two `rocketride.engine-sha256` values must be the same, and equal to the
engine the WSL checkout holds now
(`wsl -d Ubuntu-22.04 -- sha256sum <checkout>/dist/server/libengine.so`). With
one shared daemon both commands read the same image, and only that last
comparison says anything.

For `--runtime=k8s` the same image serves: Docker Desktop's cluster uses the
daemon's images. A kind cluster keeps a copy of its own, so
`kind load docker-image rocketride/node:<version>` again after every build or
refresh.

### k8s

1. **A cluster on your machine.** Docker Desktop has one (Settings →
   Kubernetes → Enable Kubernetes; its context is `docker-desktop`). kind works
   too (its contexts are `kind-<name>`).

   ```bash
   kubectl config current-context    # docker-desktop
   kubectl get nodes                 # one node, STATUS Ready
   ```

2. **The namespace.** The engine never creates it.

   ```bash
   kubectl create namespace rocketride-tasks
   # optional: a task's pod fits the restricted Pod Security Standard
   kubectl label namespace rocketride-tasks pod-security.kubernetes.io/enforce=restricted
   ```

3. **The image, where the cluster's nodes get it.** Docker Desktop's cluster
   uses the daemon's own images, so the docker preparation above is all it
   takes. Any other cluster has to be given the image: with kind,
   `kind load docker-image rocketride/node:<version>`. To see what a node has:

   ```bash
   # Linux / macOS
   kubectl get nodes -o jsonpath="{range .items[*].status.images[*]}{.names[*]}{'\n'}{end}" | grep rocketride/node
   ```

   ```powershell
   # Windows
   kubectl get nodes -o jsonpath="{range .items[*].status.images[*]}{.names[*]}{'\n'}{end}" | Select-String rocketride/node
   ```

**The context rule.** `nodes:test --runtime=k8s` runs only against a cluster
on your machine. It accepts the contexts `docker-desktop`, `kind-*`, `k3d-*`,
`minikube`, `rancher-desktop` and `orbstack`, and refuses any other before it
asks the cluster anything. A local name is not enough: the context's API
server, read from the kubeconfig, must be on this machine too (a loopback
address, or Docker Desktop's `kubernetes.docker.internal`; for `minikube` also a
private-network address), so a `kind-dev` that points at a remote cluster is
refused as well. The context is `RR_K8S_CONTEXT` when set, else `kubectl`'s
current one, and the tests run on the one the check judged.

## Unit tests

```bash
./builder ai:test
```

This lane needs neither a daemon nor a cluster. The launcher tests drive each
runtime against a fake CLI that records every command:

| File under `packages/ai/tests/ai/`         | Covers                                      |
| ------------------------------------------ | ------------------------------------------- |
| `modules/task/test_launcher_subprocess.py` | `spawn`, and how a runtime is chosen        |
| `modules/task/test_launcher_docker.py`     | `docker`                                    |
| `modules/task/test_launcher_k8s.py`        | `k8s`                                       |
| `test_eaas_runtime.py`                     | `--runtime` and its default on `ai/eaas.py` |

To run one file, or a few, pass pytest's own options through `ai:run-pytest`,
one token per `--pytest=` flag:

```bash
./builder ai:run-pytest --pytest=-k --pytest=test_launcher_k8s
./builder ai:run-pytest --pytest=-k "--pytest=test_launcher_docker or test_eaas_runtime"
```

These tests import `ai` from the source tree, so `ai:run-pytest` tests an edit
as it is, with no build in between.

The builder's own checks for the container and cluster tasks run without the
engine, and so does the lint CI runs on the build scripts:

```bash
node --test scripts/lib/registry.test.js nodes/scripts/container-checks.test.js
pnpm run lint:scripts
```

For the Python, `ruff check` and `ruff format --check`, as in
[CI Gates](../ci-gates.md).

## Node tests

```bash
./builder nodes:test                     # spawn
./builder nodes:test --runtime=docker    # every task in a container
./builder nodes:test --runtime=k8s       # every task in a Job
./builder container:test                 # Linux only: container:build, the image probes, then --runtime=docker
```

Expect the same counts as under spawn, apart from the tests in the table
below. The builder starts a test server of its own each time and prints
`Server ready on port <port> (mocks enabled, runtime <name>)`.

Under `docker` and `k8s` the builder does three more things:

- **Checks first.** `nodes:docker-preflight` wants a daemon and the image;
  `nodes:k8s-preflight` wants `kubectl`, a local context, the namespace and,
  on Docker Desktop, the image. Each stops at the first missing piece and says
  how to add it.
- **Tells the test server what it needs.** Its tasks are labelled with an id
  of that server's own (`nodes-test-<uuid>`), and the test mocks reach every
  task (`RR_DOCKER_MOUNTS`, `RR_K8S_MOUNTS`). Under `k8s` it also sets
  `RR_K8S_IMAGE_PULL_POLICY=Never`, names the context it checked, and on Docker
  Desktop sets `RR_K8S_HOST_ALIAS=host.docker.internal`. A `RR_K8S_*` value
  you set yourself wins.
- **Cleans up after the server stops.** The last line reads
  `Server stopped, N task container(s) removed`, or `N task job(s) removed`
  and `N kubectl process(es) ended`.

Three test files behave differently under a runtime, because a task there does
not see the engine's files:

| Test                                  | `docker`                                                                                                                       | `k8s`                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `tool_filesystem/test_live_anchor.py` | Runs as under spawn, through a mount of the run's part of the store. Where the daemon cannot give one, it asserts the refusal. | Asserts the refusal: `tool_filesystem is not available under --runtime=k8s`.                                   |
| `media_inspect/test_live.py`          | As under spawn.                                                                                                                | Its pipeline saves through the store, so it asserts the same refusal.                                          |
| `task_crash/test_crash_dump.py`       | The dump is copied out of the container before it is removed.                                                                  | Checks that the task failed and that its Job and pod are gone, then skips: the dump is not fetched from a pod. |

So under `k8s` one test is reported skipped that passes under spawn.

To run a few tests rather than all of them:

```bash
./builder nodes:test --runtime=docker --pytest-pattern=live_anchor
./builder nodes:test --runtime=k8s --pytest-pattern=crash_dump --pytest-parallel=off
```

Writing node tests is covered in [Node Testing](../nodes/testing.md).

## Running the engine server by hand

The server runs the copy of the Python tree in `dist/server`, not your
sources. The test tasks bring that copy up to date themselves; before a start
by hand, after an edit, do it yourself:

```bash
./builder ai:sync nodes:sync
```

Then start it through the builder, which builds first and listens on port
5565:

```bash
./builder server:run --runtime=docker
./builder server:run --runtime=k8s --trace=debugOut
```

Or the engine binary itself, from inside `dist/server`:

```bash
# Linux / macOS
cd dist/server
./engine ./ai/eaas.py --host=127.0.0.1 --runtime=docker
```

```powershell
# Windows
cd dist\server
.\engine.exe ./ai/eaas.py --host=127.0.0.1 --runtime=docker
```

Under `docker` and `k8s` the startup banner is followed by
`Task runtime: docker` (or `k8s`); under `spawn` there is no such line. Add
`--port=` to listen elsewhere.

`--runtime=k8s` reads its settings from the environment. With a locally built
image, tell it not to pull:

```bash
# Linux / macOS
RR_K8S_IMAGE_PULL_POLICY=Never ./engine ./ai/eaas.py --host=127.0.0.1 --runtime=k8s
```

```powershell
# Windows
$env:RR_K8S_IMAGE_PULL_POLICY = 'Never'
.\engine.exe ./ai/eaas.py --host=127.0.0.1 --runtime=k8s
```

Set `RR_K8S_CONTEXT` to pin the cluster. If the engine is started with a model
server or a database at a loopback address of this host (`localhost`,
`127.0.0.1`), also set `RR_K8S_HOST_ALIAS` (on Docker Desktop,
`host.docker.internal`); without it such a task is refused.

### Give it something to run

The Python client's CLI is part of `dist/server`, so the engine's own Python
runs it. Save this pipeline, which needs no keys, as `hello.pipe`:

```json
{
	"project_id": "11111111-2222-3333-4444-555555555555",
	"version": 1,
	"components": [
		{ "id": "webhook_1", "provider": "webhook", "config": { "mode": "Source", "type": "webhook" } },
		{ "id": "parse_1", "provider": "parse", "config": {}, "input": [{ "lane": "tags", "from": "webhook_1" }] },
		{
			"id": "response_text_1",
			"provider": "response_text",
			"config": { "laneName": "text" },
			"input": [{ "lane": "text", "from": "parse_1" }]
		}
	]
}
```

In a second terminal, in `dist/server`, point the CLI at the server. The
engine binary keeps `--pipeline` for itself, so the pipeline file goes in a
variable. `MYAPIKEY` is the engine's built-in development key.

```bash
# Linux / macOS
export ROCKETRIDE_URI=http://127.0.0.1:5565 ROCKETRIDE_APIKEY=MYAPIKEY
export ROCKETRIDE_PIPELINE=/path/to/hello.pipe
rrcli() { ./engine -c "from rocketride.cli.main import main; main()" "$@"; }
```

```powershell
# Windows
$env:ROCKETRIDE_URI = 'http://127.0.0.1:5565'; $env:ROCKETRIDE_APIKEY = 'MYAPIKEY'
$env:ROCKETRIDE_PIPELINE = 'C:\path\to\hello.pipe'
function rrcli { .\engine.exe -c "from rocketride.cli.main import main; main()" @args }
```

```bash
rrcli start                                 # Pipeline started.  Token: tk_...
rrcli list                                  # Status: Webhook ready - system is ready to accept requests
rrcli upload ../../README.md --token tk_... # Uploaded 1 of 1 file(s)
rrcli stop --token tk_...                   # Task tk_... terminated.
```

Between `start` and `stop` the task is running: that is the time to look at
it.

## Watching a task

**Any runtime.** The server prints to its terminal. `--trace=debugOut` adds
the launcher's own lines, which start with `[docker]` or `[k8s]`: what the
daemon or cluster is, how a task is dialled, what was removed at startup. A
crashed task's minidump lands in `dist/data/logs/` under spawn and in
`dist/data/logs/<task id>~<hash>/` under docker; under k8s it is not fetched.
Its name carries the task's token and ends in `.dmp`, or `.mdmp` from a
Windows engine. [Crash Reporting](crash-reporting.md) explains how to read one.
The node test `task_crash/test_crash_dump.py` (`--pytest-pattern=crash_dump`)
crashes a task on purpose, and removes the dumps it made.

**spawn.** The task is a process whose parent is the server. Its command line
names a task file in the temp directory, created for you alone, and
`--data_host=127.0.0.1`: the task listens on loopback only.

```bash
# Linux / macOS
ps -ef | grep '[a]i/node.py'
```

```powershell
# Windows
Get-CimInstance Win32_Process -Filter "Name='engine.exe'" |
  Where-Object CommandLine -like '*node.py*' | Select-Object ProcessId, ParentProcessId, CommandLine
```

**docker.** Every task container carries two labels: `rocketride.task` (the
task id) and `rocketride.eas` (the engine instance).

```bash
docker ps --filter label=rocketride.task
docker top <container>            # tini, then ./engine ai/node.py /opt/data/task.json ...
docker stats --no-stream <container>
docker inspect <container> --format '{{.Config.User}} {{.HostConfig.CapDrop}} {{json .NetworkSettings.Ports}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
```

`docker inspect` shows the user the task runs as — the engine's own uid and
gid, or `rocketride`, the image's user, when the engine runs on Windows — and
`[ALL]` capabilities dropped. On Docker Desktop `docker ps` shows the data
port published on `127.0.0.1`, and the host's own process list shows nothing
of the task: the container lives in Docker Desktop's VM. On a local Linux
Docker Engine there is no published port, the engine dials the container's
IP, and `ps` on the host shows the task too. Both ways of reaching a task
deserve a run; a Linux engine inside a WSL distribution gives the second.
`docker logs` is empty unless the server was started with
`RR_DOCKER_LOG_DRIVER=json-file`.

**k8s.** A task is a Job named `rr-<task id>-<6 hex>` and its one pod. Both
carry the same two labels, cut to what a label allows; the Job's annotations
`rocketride.task-id` and `rocketride.eas-instance` hold the values as they
were.

```bash
kubectl -n rocketride-tasks get jobs,pods -l rocketride.task -L rocketride.task,rocketride.eas
kubectl -n rocketride-tasks get jobs -l rocketride.task -o jsonpath="{.items[*].metadata.annotations}"
kubectl -n rocketride-tasks logs <pod>
kubectl -n rocketride-tasks describe pod <pod>     # image, limits, events
```

The pod's spec holds no environment values. The server itself keeps
`kubectl` processes: one `get pods --watch` for all its tasks, and per task an
`attach` that carries its input and output. With `RR_K8S_REACH` at its
default, `auto`, a server outside the cluster adds a `port-forward` per task;
`forward` adds one wherever the server runs, and `pod` never does:

```bash
# Linux / macOS
pgrep -af kubectl
```

```powershell
# Windows
Get-CimInstance Win32_Process -Filter "Name='kubectl.exe'" | Select-Object ProcessId, CommandLine
```

## Cleaning up and common problems

The engine removes a task's container or Job when the task ends, and at
startup it removes what an earlier run of the **same instance** left
(`RR_DOCKER_INSTANCE`, `RR_K8S_INSTANCE`). A server that is killed removes
nothing, and a test run that fails stops before its cleanup. To look, and to
clear by hand:

```bash
docker ps -a --filter label=rocketride.task
docker rm -f <container>

kubectl -n rocketride-tasks get jobs,pods -l rocketride.task
kubectl -n rocketride-tasks delete jobs -l rocketride.task    # every engine's tasks in that namespace
```

A finished Job nobody removed is deleted by the cluster after `RR_K8S_TTL`
seconds. Of the `kubectl` processes a killed server leaves, the watch ends by
itself within five minutes; end a leftover `port-forward` yourself. Under
spawn a killed server leaves the files of the tasks it was running
(`task-*.json` in the temp directory); they hold a pipeline's resolved
settings, secrets included, so delete them.

| What you see                                                                              | Why, and what to do                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A task runs Python you have since changed                                                 | The image is stale: `./builder container:sync`.                                                                                                                                                                                                                                                                                                      |
| `... is not on this daemon`, or `Image ... not found; run ./builder container:build`      | The node image of this version is missing: see [Preparing](#docker).                                                                                                                                                                                                                                                                                 |
| `Image ... not found on the node`                                                         | Under k8s, the cluster's node does not have the image: see [Preparing](#k8s).                                                                                                                                                                                                                                                                        |
| `the kubectl context <name> is not a cluster on this machine`                             | The context rule: `kubectl config use-context docker-desktop`, or set `RR_K8S_CONTEXT` to a local one.                                                                                                                                                                                                                                               |
| `the namespace rocketride-tasks does not exist in <context>`                              | `kubectl --context <context> create namespace rocketride-tasks`.                                                                                                                                                                                                                                                                                     |
| `... names this host by a loopback address ...`                                           | Under k8s, a model server or database at a loopback address needs `RR_K8S_HOST_ALIAS`.                                                                                                                                                                                                                                                               |
| `tool_filesystem is not available under --runtime=...`                                    | The pipeline uses the store and the runtime cannot give it to the task. Under k8s that is always so with a filesystem store.                                                                                                                                                                                                                         |
| On Windows, a test run fails while installing, with access denied on a `.pyd` or a `.dll` | A running `engine.exe` holds the file. `Get-Process engine`, stop the one you started, and run again. If it still happens with no engine running, add `--pytest-parallel=off`.                                                                                                                                                                       |
| `git status` shows files you did not edit after a builder run                             | The builder regenerates some tracked files: `packages/client-typescript/src/client/constants.ts`, `packages/ai/src/ai/modules/mcp/credentials.json`, sometimes `pnpm-lock.yaml`. Check with `git diff <file>` that the change is the builder's alone, then `git checkout -- <file>`: it discards every unstaged change to that file, yours included. |

## Related

- [Tasks in Containers](../../public/product/operate/self-hosting/task-containers.md):
  the runtimes and their settings, for operators.
- [Image tasks](../../../docker/README.md#image-tasks): building and
  refreshing the node image.
- [Node Testing](../nodes/testing.md): writing node tests.
- [CI Gates](../ci-gates.md): what CI runs.
