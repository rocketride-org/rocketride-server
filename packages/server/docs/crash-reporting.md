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
  `MiniDumpWriteDump` API. The handler is installed inside `engine.dll`, the
  shared module `engine.exe` loads and hands off to immediately -- so a crash
  during a run symbolizes against `engine.dll.pdb`, not `engine.exe.pdb`.

## Where dumps go

Because Crashpad writes the dump *after* the crashing process is gone, the dump
first lands in a private Crashpad database under the system temp dir, named
`rocketride-crashdb-<uid>-<exe-hash>`. It is moved into the configured crash-dump
location, and the monitor notified, on the **next task run** -- not at process
start. Recovery has to wait for the monitor to install its callback and for the
crash-dump location to be pointed at the task's log directory; both happen well
after the crash handler itself starts. So crash notification for Linux/macOS is
delivered one run later, not at crash time.

The database directory is created `0700` and re-checked on every start. If it
already exists but is a symlink, is owned by another user, or grants group or
other access, the engine logs an error and turns crash reporting off rather than
write minidumps -- which contain process memory -- somewhere another user can
read them.

The uid and the executable hash keep separate users and separate installs apart.
Two instances of the *same* install running as the *same* user still share one
database, and whichever starts first recovers both sets of dumps. Give each
instance its own `ROCKETRIDE_CRASHDB_DIR` in that setup.

| Variable | Purpose |
| --- | --- |
| `ROCKETRIDE_CRASHPAD_HANDLER` | Override the handler path (relocated installs, containers). |
| `ROCKETRIDE_CRASHDB_DIR` | Override the crash database directory. The same ownership and mode checks apply, so let the engine create it -- a directory you pre-create with the usual `0755` umask is rejected. `chmod 700` it if it must exist first. |

## Getting a dump by hand

The file in the database is already a complete minidump, so you do not have to
restart the engine to collect one. Restarting only moves and renames it.

```bash
# after the crash -- the glob avoids computing the exe hash yourself
ls -l /tmp/rocketride-crashdb-$(id -u)-*/pending/*.dmp
```

Read `pending/`, not `new/`: Crashpad writes into `new/` and moves the report to
`pending/` once it is complete.

If you do restart, the dump is no longer in the database. It has been moved to
the crash-dump location -- `<base>/logs/` when a task set it, otherwise the
system temp dir -- and renamed to
`<exe>.<version>.<build>.<host>.<UTC-timestamp>.<pid>.dmp`.

## Generating symbols

A minidump on its own is not human-readable -- you need Breakpad-format `.sym`
files that match the exact crashed build. Release/Sanitize builds generate them
automatically with modern [Mozilla `dump_syms`](https://github.com/mozilla/dump_syms)
(DWARF-5 capable) into a `symbols/` store next to the engine, keyed by debug-ID:

```
symbols/<module>/<debug-id>/<module>.sym
```

The build setup (`server:setup-tools`) fetches a prebuilt `dump_syms` and puts it on
the build `PATH` automatically, so symbols are generated out of the box. If it's
still missing the build prints `WARNING: dump_syms not found` and the step is
skipped (you can also install it manually with `cargo install dump_syms`, or
override with `-DROCKETRIDE_DUMP_SYMS=/path`). The `symbols/` store is retained in
the release artifact. See the compiler-toolchain section in the builder docs.

## Investigating a dump

`lldb`, `minidump-stackwalk`, and `minidump-2-core` are expected on your `PATH` (see
Installing below). Use the exact binary that crashed (`dist/server/engine`,
`build/engine-core/test/aptest`, ...); its symbols come from the shipped `symbols/`
store or the separated `.debug` next to it (via `.gnu_debuglink`).

### Installing the readers (one time)

`dump_syms` (symbol generation) is installed by `server:setup-tools`; the dump
readers are not. Build/fetch them and put them on your `PATH` (`/usr/local/bin`
below; anywhere on `PATH` works). `lldb` and `gdb` come from your distro or LLVM.

```
# minidump-stackwalk -- prebuilt from rust-minidump
url=$(curl -fsSL https://api.github.com/repos/rust-minidump/rust-minidump/releases/latest \
  | grep -oE '"browser_download_url": *"[^"]+"' | cut -d'"' -f4 \
  | grep 'minidump-stackwalk-x86_64-unknown-linux-gnu\.tar\.xz$')
curl -fsSL "$url" | tar -xJ -C /tmp
sudo install -m755 /tmp/minidump-stackwalk-*/minidump-stackwalk /usr/local/bin/

# minidump-2-core -- built from breakpad (needs g++)
git clone --depth 1 https://chromium.googlesource.com/breakpad/breakpad /tmp/breakpad
git clone --depth 1 https://chromium.googlesource.com/linux-syscall-support /tmp/breakpad/src/third_party/lss
g++ -std=c++17 -I/tmp/breakpad/src -o /tmp/minidump-2-core \
  /tmp/breakpad/src/tools/linux/md2core/minidump-2-core.cc \
  /tmp/breakpad/src/common/path_helper.cc \
  /tmp/breakpad/src/common/linux/memory_mapped_file.cc \
  /tmp/breakpad/src/common/linux/safe_readlink.cc
sudo install -m755 /tmp/minidump-2-core /usr/local/bin/

# gdb:  Fedora -> sudo dnf install -y gdb   |   Debian/Ubuntu -> sudo apt install -y gdb
```

### minidump-stackwalk + the `.sym` store (field workflow, no binary needed)

```
minidump-stackwalk --human --symbols-path dist/server/symbols crash.dmp
```

Frames showing `module + offset` with no names mean the build lacks a GNU build-id
or the symbols don't match it (debug-ID mismatch).

### LLDB -- reads the minidump directly (recommended when you have the binary)

```
DEBUGINFOD_URLS= lldb --batch \
  -o "settings set symbols.enable-external-lookup false" \
  -o "target create <binary> --core crash.dmp" \
  -o "bt" -o quit
```

LLDB relocates the PIE automatically from the minidump's module base -- clean
symbolized backtrace, no core conversion.

Clear `DEBUGINFOD_URLS` and disable external lookup, or LLDB appears to hang.
Ubuntu ships with `DEBUGINFOD_URLS=https://debuginfod.ubuntu.com`, so LLDB blocks
on a network symbol fetch for every module in the dump. Both switches only drop
symbols for system libraries you already don't have locally -- the target
binary's own DWARF is inline, so its frames still symbolize. On a large,
statically-linked binary the first `target create` may still take a few seconds
to index that DWARF; that is work, not a hang.

### GDB -- via a converted core

Crashpad minidumps carry no auxiliary vector, so a converted core has no PIE load
bias for GDB to auto-apply -- pass the module base explicitly (read it from the dump):

```
minidump-2-core crash.dmp > crash.core
base=$(minidump-stackwalk --json crash.dmp | python3 -c \
  'import json,sys;b="<binary-basename>";print(next(m["base_addr"] for m in json.load(sys.stdin)["modules"] if b in (m["filename"] or "")))')
gdb --core crash.core -ex "add-symbol-file <binary> -o $base" -ex "bt 7"
```

Do **not** pass the binary as GDB's first argument (that loads it at 0);
`add-symbol-file ... -o <base>` places the symbols at the real address. Frames past
`main` are stack-scan noise (no libc CFI) -- `bt 7` shows the meaningful ones, or
`dnf debuginfo-install glibc` for a clean libc unwind.

Wrap it in a shell function (convert -> read base -> launch GDB):

```
gdbdump() {  # gdbdump <binary> <dump.dmp>
  local bin="$1" dmp="$2" core="/tmp/$(basename "$dmp").core"
  minidump-2-core "$dmp" > "$core" || return 1
  local base; base=$(minidump-stackwalk --json "$dmp" 2>/dev/null | python3 -c \
    "import json,sys,os;b=os.path.basename('$bin');print(next(m['base_addr'] for m in json.load(sys.stdin)['modules'] if b in (m['filename'] or '')))")
  gdb --core "$core" -ex "add-symbol-file $bin -o $base" -ex "bt 7"
}
# gdbdump dist/server/engine /tmp/<dump>.dmp
```

**Windows** -- open the `.dmp` directly in **WinDbg** or Visual Studio with
`engine.dll.pdb` and `engine.exe.pdb` available (both ship in the release's
`*.symbols.zip`).

## Memory capture

Crashpad captures a targeted snapshot (thread stacks and register/exception
memory), not the full heap, and has no full-memory flag. To capture more,
nominate specific ranges at runtime via `CrashpadInfo::set_extra_memory_ranges()`
-- mirroring the Windows path, which widens the dump when the `Heap` log channel
is enabled or in debug builds.
