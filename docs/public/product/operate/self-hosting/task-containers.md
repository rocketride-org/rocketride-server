---
title: Tasks in Containers
---

# Run Each Task in Its Own Container

By default the engine runs every pipeline as a child process on its own host:
the same filesystem, network and user as the engine, one shared
`site-packages`, one memory budget. Started with `--runtime=docker`, it runs
each task in a container of its own instead, through the local Docker daemon.

Each task container gets:

- its own filesystem and network namespace
- the engine's own user: the container runs with the engine's uid and gid, so
  files a task writes into the store belong to the user who runs the engine
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

| Variable               | Default                     | Effect                                                                                                                                                                                                                    |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RR_DOCKER_IMAGE`      | `rocketride/node:<version>` | The node image. Never `latest`: a task protocol of another version is not compatible.                                                                                                                                     |
| `RR_DOCKER_PUBLISH`    | `auto`                      | `true` dials a port published on `127.0.0.1`, `false` dials the container's IP; `auto` decides from the daemon (below).                                                                                                   |
| `RR_DOCKER_MEMORY`     | `2g`                        | Memory limit per task.                                                                                                                                                                                                    |
| `RR_DOCKER_CPUS`       | `1`                         | CPU limit per task.                                                                                                                                                                                                       |
| `RR_DOCKER_NETWORK`    | `bridge`                    | The Docker network tasks join.                                                                                                                                                                                            |
| `RR_DOCKER_MODELS`     | none                        | A host directory of model files, mounted read-only at `/models`, with `HF_HOME` pointing there.                                                                                                                           |
| `RR_DOCKER_MOUNTS`     | none                        | Comma-separated names of variables that name host directories a task needs; each is mounted read-only at `/opt/mounts/<name>`, and the variable points there inside the container. The node tests use it for their mocks. |
| `RR_DOCKER_LOG_DRIVER` | `none`                      | The containers' log driver. Task output always reaches the engine; `json-file` also makes `docker logs` work while a task runs.                                                                                           |
| `RR_DOCKER_INSTANCE`   | `<hostname>:<engine port>`  | Labels the engine's containers. It must stay the same across restarts so the engine can remove containers an earlier run left behind.                                                                                     |

## How the engine reaches a task

Inside every container the task listens on port 5570. On a local Linux Docker
Engine the engine dials the container's IP. On Docker Desktop, whose containers
live in a VM, and with a remote daemon, it publishes that port on `127.0.0.1`
and dials the published port. The task authenticates the engine with a
per-run token either way.

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
the engine runs tasks as root inside the container for that reason.

The engine checks once, with a short probe container run as a task runs, that
the daemon sees its files and that a file a task writes there comes back as
the engine's own. A remote daemon fails the first check; a daemon that remaps
users (`userns-remap`) fails the second. Then, or when the store is S3
authenticated through a web-identity token file, the engine refuses such a
pipeline before it starts rather than let it write into the container and
lose the files. S3 with a key in the engine's environment works as it does
for a child process.

## Logs and cleanup

Task output always reaches the engine and its clients as it does today. With
the default log driver, `docker logs` shows nothing.

Each container is removed when its task ends. When the engine starts, it
removes containers labelled with its `RR_DOCKER_INSTANCE` that an earlier run
left behind.

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
