---
title: Tasks in Containers
---

# Run Each Task in Its Own Container

By default an engine runs every pipeline as a child process on its own host:
the same filesystem, network and user as the engine, one shared
`site-packages`, one memory budget. Started with `--runtime=docker`, or with
`--saas` (see below), it runs each task in a container of its own instead,
through the local Docker daemon.

Each task container gets:

- its own filesystem and network namespace
- the engine's own user: the container runs with the engine's uid and gid, so
  files a task writes into the store belong to the user who runs the engine.
  Under a rootless daemon that user is the container's root; an engine that
  runs as root, or on Windows, runs tasks as the image's user (see
  [Files and storage](#files-and-storage))
- its own dependencies, installed into the container rather than shared
- a memory and CPU limit (`2g` and one CPU unless you change them)
- no Linux capabilities and no privilege escalation

Pipelines, their results and the protocol clients speak do not change.
`--runtime=spawn` keeps tasks as child processes. It is the default, except for an engine started
with `--saas`, where `docker` is.

## What the host needs

- The `docker` CLI on the engine's `PATH`, and a daemon it can reach as the
  engine's user (`docker info` works).
- The node image of the engine's own version, `rocketride/node:<version>`.
  The engine never pulls it while a task starts; a missing image fails the
  start with a message naming the task that builds it. Build it from a Linux
  checkout with `./builder container:build`, or point `RR_DOCKER_IMAGE` at the
  published image of the same version
  (`ghcr.io/rocketride-org/rocketride-node:<version>`) after pulling it.

## Turn it on

```bash
./engine ai/eaas.py --runtime=docker
```

An engine started with `--saas` runs tasks in containers without the flag; give it
`--runtime=spawn` to keep child processes.

Everything else is set in the engine's environment or its `.env` file:

| Variable                | Default                     | Effect                                                                                                                                                                                                                    |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RR_DOCKER_IMAGE`       | `rocketride/node:<version>` | The node image. Never `latest`: a task protocol of another version is not compatible.                                                                                                                                     |
| `RR_DOCKER_PUBLISH`     | `auto`                      | `true` dials a port published on `127.0.0.1`, `false` dials the container's IP; `auto` decides from the daemon (below).                                                                                                   |
| `RR_DOCKER_MEMORY`      | `2g`                        | Memory limit per task.                                                                                                                                                                                                    |
| `RR_DOCKER_CPUS`        | `1`                         | CPU limit per task.                                                                                                                                                                                                       |
| `RR_DOCKER_PIDS_LIMIT`  | `4096`                      | Processes and threads per task, so that one task cannot use up the host's process table and stop the others.                                                                                                              |
| `RR_DOCKER_NETWORK`     | `bridge`                    | The Docker network tasks join. `host`, `none` and `container:<name>` are refused: each task needs a network of its own.                                                                                                   |
| `RR_DOCKER_MODELS`      | none                        | A host directory of model files, mounted read-only at `/models`, with `HF_HOME` pointing there.                                                                                                                           |
| `RR_DOCKER_MOUNTS`      | none                        | Comma-separated names of variables that name host directories a task needs; each is mounted read-only at `/opt/mounts/<name>`, and the variable points there inside the container. The node tests use it for their mocks. |
| `RR_DOCKER_LOG_DRIVER`  | `none`                      | The containers' log driver. Task output always reaches the engine; `json-file` also makes `docker logs` work while a task runs.                                                                                           |
| `RR_DOCKER_INSTANCE`    | `<hostname>:<engine port>`  | Labels the engine's containers. It must stay the same across restarts so the engine can remove containers an earlier run left behind.                                                                                     |
| `RR_DOCKER_CRASH_DUMPS` | `true`                      | `false` leaves the minidump of a crashed task in its container, which is then removed with it (see [Crash dumps](#crash-dumps)).                                                                                          |

## How the engine reaches a task

Inside every container the task listens on port 5570. With
`RR_DOCKER_PUBLISH=auto`, an engine on the Linux host of a rootful Docker
Engine dials the container's IP. Elsewhere it publishes that port on
`127.0.0.1` and dials the published port: on Docker Desktop, whose containers
live in a VM, under a rootless daemon, whose containers live in a network
namespace of their own, and from macOS or Windows. `true` and `false` choose
one way or the other wherever the engine runs. The task authenticates the
engine with a per-run token either way.

The daemon must run on the engine's own host. The engine refuses one that
`DOCKER_HOST` or the current docker context places on another host: a port
published there is out of its reach, and a mount would name that host's files.

## Services on the host

Inside a container, `127.0.0.1` is the container itself. A loopback address in
`--modelserver` or in a RocketRide database DSN is therefore rewritten to
`host.docker.internal`, which every task container can resolve.

- On Docker Desktop that name reaches services listening on the host's
  loopback.
- On a local Linux Engine it is the bridge gateway, so a model server or
  PostgreSQL listening only on `127.0.0.1` is unreachable from a task. Make it
  listen on the bridge address as well, and for PostgreSQL allow the bridge
  subnet in `pg_hba.conf`.

## Environment

A task container gets the variables a child process would get (see
[Security](/operate/security)), except the ones that describe the engine's
host: `PATH`, `HOME`, temporary and certificate paths, `XDG_*`, `UV_CACHE_DIR`
and similar. Values reach the container by name, never on a command line.

Everything a task gets is visible to anyone who can run `docker inspect` on
its container. Treat access to the Docker daemon as access to those values.

## Files and storage

The task file is streamed into the container and goes with it; the engine
writes no copy to disk.

Pipelines that use the file-system tool (`tool_filesystem`) work on a
filesystem store whatever user runs the engine: the engine mounts only that
run's part of the store into the container, and the task writes there as the
engine's user. Under a rootless daemon the container's root is that user, and
the engine runs tasks as root inside the container for that reason. An engine
that runs as root runs its tasks as the image's user instead, never as root,
and gives that user the directories they write into.

While a task runs, the engine refuses another whose storage root lies inside
or around that task's root: one task could otherwise swap a path under the
other's mount. Tasks on the same root, or on roots apart, run side by side.

The engine checks, with a short probe container run as a task runs, that the
container finds a marker the engine writes into the store, at the engine's own
path, and that a file a task writes there comes back as the engine's own. The
first check fails when the daemon sees other files than the engine: a
Docker-in-Docker daemon, or the host's daemon driven by an engine that runs in
a container through its socket, unless the store is at the same path on both
sides. A daemon that remaps users (`userns-remap`) fails the second.
Then, or when the store is S3 authenticated through a web-identity token file,
the engine refuses such a pipeline before it starts rather than let it write
into the container and lose the files. S3 with a key in the engine's
environment works as it does for a child process.

The answer holds until the engine restarts. A probe that Docker itself could
not run, before the image is built for one, says nothing about the store: the
next pipeline that needs the store probes again.

The directories `RR_DOCKER_MOUNTS` names are not probed: the daemon must find
them at the same paths, as it does when the engine runs on the daemon's host,
which is how the node tests use them for their mocks.

## Logs and cleanup

Task output always reaches the engine and its clients as it does today. With
the default log driver, `docker logs` shows nothing.

The engine removes each container when its task ends. If the engine stops
first, its tasks end on their own and their containers stay on the daemon,
stopped. When the engine starts again, it removes the containers labelled with
its `RR_DOCKER_INSTANCE` that an earlier run left behind.

## Crash dumps

A task whose process crashes writes a minidump, as a child process does. In a
container the dump is written inside it, so the engine copies the dump out
before it removes the container of a crashed task: into
`data/logs/<task id>~<hash>/` beside the engine's own directory, next to the
dumps of child processes, one directory per task. The hash keeps apart two ids
that the directory name would otherwise make alike. A container left by an
engine that stopped first is treated the same way when the engine starts again.

The copy comes through the Docker daemon as a stream, so it works with a
daemon that does not see the engine's files too. Only minidumps are taken
from the container's own files; what a task writes into a store mount is on
the host already (see [Files and storage](#files-and-storage)). The
container's files are the task's own doing, so a copy is given up past 60
seconds or 1 GiB, and dumps stop being kept once those under `data/logs`
reach 4 GiB in all: delete old ones to make room.

A dump is taken whatever the host's `fs.suid_dumpable` is, `2` on Ubuntu
included: as it starts, before Crashpad registers, the engine sets its own
dumpable flag to 0 with `prctl(PR_SET_DUMPABLE, 0)`, the one value from which
Crashpad can take a dump. `RR_ENABLE_DEBUGGER_CONNECTION` keeps a flag of 1 as
the kernel gave it instead, and a dump is taken from there too (see
[Security](/operate/security)).

A dump holds part of the task's memory at the moment it crashed, which can
include the data and the keys it was working with. On Linux and macOS the
files are readable by the engine's user alone; on Windows they take the
permissions of the directory. Treat that directory accordingly. The engine
never deletes a dump: once those it keeps reach 4 GiB, it stops copying new
ones out of containers, so removing old ones is up to you.
`RR_DOCKER_CRASH_DUMPS=false` turns the copying off.

## Known limits

- No GPU reaches a task container, so a node that would compute on a local GPU
  runs on the CPU. Use a model server for GPU work.
- Nodes that work on the engine host's own files see only the container's.
- Workspace nodes from `--node_path` are not available: tasks run the nodes in
  the image.
- Task containers can reach whatever the Docker network allows. Restrict
  egress on the host if tasks must not reach your internal network. On Docker
  Desktop they can also reach services on the host's loopback, the engine's
  own port included.

## Related

- [Self-hosting](/operate/self-hosting): install and start the engine.
- [Docker](/operate/self-hosting/docker): run the engine itself in a container.
- [Security](/operate/security): what a task can see.
