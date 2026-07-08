---
title: Crash reporting
---

# Crash reporting

When the engine crashes it writes a **minidump** -- a compact snapshot of the
process state at the moment of the fault. Minidumps use the same format on every
platform, so one symbolication workflow covers all of them.

- **Linux & macOS:** [Crashpad](https://chromium.googlesource.com/crashpad/crashpad/)
  runs its handler (`crashpad_handler`) out-of-process. It ships next to the
  engine binary and is started automatically at engine startup.
- **Windows:** the engine writes the dump in-process via the native DbgHelp
  `MiniDumpWriteDump` API.

## Where dumps go

Because Crashpad writes the dump *after* the crashing process is gone, the dump
first lands in a private Crashpad database (a subdirectory of the system temp
dir). On the **next engine startup** it is moved into the configured crash-dump
location and the monitor is notified. So crash notification for Linux/macOS is
delivered one run later, not at crash time.

Set `ROCKETRIDE_CRASHPAD_HANDLER` to override the handler path (relocated
installs, containers).

## Generating symbols

A minidump on its own is not human-readable -- you need Breakpad-format `.sym`
files that match the exact crashed build. Release/Sanitize builds generate them
automatically with modern [Mozilla `dump_syms`](https://github.com/mozilla/dump_syms)
(DWARF-5 capable) into a `symbols/` store next to the engine, keyed by debug-ID:

```
symbols/<module>/<debug-id>/<module>.sym
```

The step is skipped with a warning if `dump_syms` is not on `PATH` (install with
`cargo install dump_syms`, or override with `-DROCKETRIDE_DUMP_SYMS=/path`). The
`symbols/` store is retained in the release artifact.

## Investigating a dump

**Linux / macOS** -- symbolize to a stack trace with rust-minidump's
`minidump-stackwalk`:

```
minidump-stackwalk --symbols-path ./symbols crash.dmp
```

If frames show `module + offset` with no function names, the symbols don't match
the crashed build (debug-ID mismatch). To use a live debugger instead, convert
the dump to a core: `minidump-2-core crash.dmp > core && gdb <binary> core`
(limited memory -- see below).

**Windows** -- open the `.dmp` directly in **WinDbg** or Visual Studio with the
matching PDBs.

## Memory capture

Crashpad captures a targeted snapshot (thread stacks and register/exception
memory), not the full heap, and has no full-memory flag. To capture more,
nominate specific ranges at runtime via `CrashpadInfo::set_extra_memory_ranges()`
-- mirroring the Windows path, which widens the dump when the `Heap` log channel
is enabled or in debug builds.
