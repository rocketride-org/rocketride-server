---
title: C++ Example
date: 2026-08-10
sidebar_position: 1
---

<head>
  <title>C++ Example - RocketRide Documentation</title>
</head>

## What it does

A minimal node written in C++ instead of python. It counts the tags of every
object that passes through it and reports the total when the object closes,
forwarding everything downstream untouched — so it can sit anywhere in a
pipeline without changing the result.

It exists as the reference for the C++ node contract. Copy this directory to
start a new one.

| Lane in | Lane out | Description |
| --- | --- | --- |
| `tags` | `tags` | Counts tags and passes them through unchanged |

There is nothing to configure.

## Anatomy of a C++ node

A C++ node is a shared library the engine loads at startup. Unlike a python
node — where the engine registers generic python factories that call into your
module — a C++ node registers its own factories and is then instantiated
exactly like a built-in filter, with no proxy layer in between.

```
nodes/src/nodes/cpp-example/
├── CMakeLists.txt              # include the shared cmake, call rocketride_add_node
├── services.cpp_example.json   # the node declaration the engine reads
├── doc.md
└── src/
    ├── cppExample.hpp          # IFilterGlobal + IFilterInstance
    ├── cppExample.cpp          # the filter implementation
    ├── node.cpp                # initializeNode / deinitializeNode
    └── threadLocal.cpp         # required boilerplate, see below
```

### The declaration

Two fields make a services.json a C++ node:

| Field | Meaning |
| --- | --- |
| `"node": "cpp"` | The physical type. Tells the engine to load a shared library rather than register python factories. |
| `"path": "cppExample"` | The library base name, without platform prefix or extension. |

`protocol` carries the name a pipeline uses to reference the node
(`cpp_example://` here, so `"provider": "cpp_example"` in a pipeline). **That
name must match the `Type` the node registers its factories under** — the
engine resolves a pipeline component to a factory by protocol name, so a
mismatch surfaces only when a pipeline runs and cannot find the factory.

### The build

`CMakeLists.txt` is two lines of intent:

```cmake
include(${ROCKETRIDE_PACKAGES_DIR}/server/cmake/rocketride-node.cmake)
rocketride_add_node(cppExample)
```

`rocketride_add_node` builds `src/*.cpp` into a shared library, points it at the
engine headers, links it against `engineMod` in import mode, and copies the
result to `dist/server/nodes/<node-directory>/`. The target name is the library
base name, and must match the `path` field above.

### The entry points

The engine resolves two C symbols by name after loading the library:

| Symbol | When | Purpose |
| --- | --- | --- |
| `initializeNode()` | Startup, while reading service definitions | Register the node's global and instance factories. Return `false` to fail the load. |
| `deinitializeNode()` | Shutdown | Unregister them again |

Registration is explicit rather than done from a static initializer, because a
factory that outlives the module it points into is a crash waiting for
shutdown.

### Where a node runs

The node imports the engine ABI from `engineMod`; it must never link `engLib`
itself. Linking the static archive again would give the node its own
disconnected copy of every registry — the factory set, the url mappers, the
enabled trace levels — and its factories would be invisible to the engine.

`thread_local` storage cannot cross a shared library boundary on Windows, so
the thread context slot lives behind exported accessors on
`ap::async::ThreadApi` rather than in the header. A node shares the engine's
context for the thread it runs on.

Only a host built on the shared engine module can load a
node — `engine.exe` can, and the statically linked test binaries (`engtest`,
`aptest`) cannot. They read the same service definitions but skip the library,
since loading it would pull a second, independent engine into the process.

## Trying it

`pipelines/cpp_node.json` runs a filesystem source into this node alongside the
built-in `hash` filter:

```
./dist/server/engine.exe ./pipelines/cpp_node.json --trace=ServicePipe
```

The node traces on `ServicePipe`, so that one flag shows its construction, its
per-object `open`/`writeTag`/`close`, and its tag counts interleaved with the
pipe lifecycle driving them.
