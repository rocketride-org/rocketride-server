# RocketRide Engine

The RocketRide Engine is a high-performance, modular data processing engine built in C++17. It executes JSON/manifest-based tasks through a plugin architecture, supporting data pipelines, multi-source data access, metadata indexing, file classification, and network communication.

---

## Building

From the repository root, use the unified builder:

```bash
./builder server:build
```

This downloads a pre-built engine when available (preferred), or compiles from source otherwise. For a full project build:

```bash
./builder build
```

### Build Options (CMake)

| Option                        | Default | Description                 |
| ----------------------------- | ------- | --------------------------- |
| `BUILD_TESTS`                 | `ON`    | Build test suites           |
| `BUILD_DOCS`                  | `OFF`   | Generate documentation      |
| `ENABLE_PYTHON`               | `ON`    | Enable Python integration   |
| `SHOW_BUILD_TIME`             | `ON`    | Show build time measurement |
| `ROCKETRIDE_UNITY_BATCH_SIZE` | -       | Unity build batch size      |

---

## Usage

```bash
rocketride [options] [task-files...]
```

Task files can be:

- `.json` files -- parsed and executed as task configurations
- `.task` files -- parsed as manifest format
- `.py` files -- delegated to the Python subsystem
- Directories -- all task files within are recursively discovered and executed
- Wildcards -- e.g. `*.json`, `?.task`

### Streaming Mode

```bash
rocketride --stream
```

Reads JSON task configuration from stdin for interactive or debugger-driven execution.

---

## Command-Line Options

### Core Control

| Option       | Description                                  |
| ------------ | -------------------------------------------- |
| `--stream`   | Read streaming task configuration from stdin |
| `--autoterm` | Auto-terminate engine when stdin closes      |
| `--verify`   | Verification mode (CI/CD support)            |
| `--args`     | Output command-line arguments for debugging  |
| `--break`    | Debug break on start                         |
| `--diag`     | Enable diagnostic mode                       |
| `--testArgs` | Enable test argument mode                    |

### Path Configuration

| Option                 | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `--paths.base PATH`    | Base directory for all paths (sets data, control, cache, logs) |
| `--paths.data PATH`    | Data directory (storage for processed data)                    |
| `--paths.control PATH` | Control directory (task coordination files)                    |
| `--paths.cache PATH`   | Cache directory (temporary processing data)                    |
| `--paths.log PATH`     | Log directory (engine and task logs)                           |

Path resolution supports `~` for the user home directory on both Unix and Windows.

### Engine Options

| Option                  | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `--monitor TYPE`        | Monitor type: `Console`, `App`, or `TestConsole` |
| `--pipeline CONFIG`     | Pipeline configuration override                  |
| `--nodeId ID`           | Set engine node identifier                       |
| `--java`                | Enable Java/Tika support                         |
| `--python`              | Enable Python integration                        |
| `--tika`                | External Tika service support                    |
| `--serviceCategory CAT` | Service category filter                          |
| `--serviceName NAME`    | Service name filter                              |
| `--url.keystorenet URL` | Remote keystore URL                              |

### Logging Options

| Option                    | Description                                         |
| ------------------------- | --------------------------------------------------- |
| `--trace LEVELS`          | Enable trace logging (e.g. `Job`, `Service`, `All`) |
| `--log.file PATH`         | Log to file instead of stdout                       |
| `--log.dateTimeFormat`    | Include datetime in log output                      |
| `--log.includeDateTime`   | Include date/time in log lines                      |
| `--log.includeThreadId`   | Include thread ID in log lines                      |
| `--log.includeThreadName` | Include thread name in log lines                    |
| `--log.includeFile`       | Include source file info in log lines               |
| `--log.includeFunction`   | Include function name in log lines                  |
| `--log.includeMemory`     | Include memory usage metrics                        |
| `--log.includeDiskLoad`   | Include disk load metrics                           |
| `--log.isAtty`            | Terminal output formatting                          |
| `--log.forceDecoration`   | Force decorated output                              |
| `--log.disableAllColors`  | Disable colored output                              |
| `--log.truncate`          | Truncate log files on start                         |
| `--icu.text`              | ICU text processing configuration                   |

---

## Task Types

The engine uses a factory-based task system. Tasks are defined in JSON and dispatched by type:

### Data Processing

| Task            | Description                   |
| --------------- | ----------------------------- |
| `ClassifyFiles` | ML-based file classification  |
| `Transform`     | Data transformation pipelines |
| `Tokenize`      | Text tokenization             |
| `SearchBatch`   | Batch search operations       |
| `CommitScan`    | Finalize scan operations      |
| `ScanCatalog`   | Catalog-based scanning        |
| `ScanConsole`   | Interactive console scanning  |

### Pipeline Actions

| Task            | Description                     |
| --------------- | ------------------------------- |
| `Copy`          | Data copying operations         |
| `Export`        | Data export to external formats |
| `Remove`        | Data deletion                   |
| `Verify`        | Integrity verification          |
| `Stat`          | File statistics                 |
| `Classify`      | Content classification          |
| `Permissions`   | ACL management                  |
| `UpdateObjects` | Metadata updates                |

### Service Management

| Task               | Description                       |
| ------------------ | --------------------------------- |
| `ConfigureService` | Configure data sources/endpoints  |
| `Services`         | Service enumeration and control   |
| `Exec`             | Execute external commands/scripts |

### Utilities

| Task            | Description                  |
| --------------- | ---------------------------- |
| `Sysinfo`       | System information gathering |
| `GenerateKey`   | Cryptographic key generation |
| `ValidateRegex` | Regex pattern validation     |
| `MonitorTest`   | Monitor health testing       |

---

## Configuration

### user.json

The engine loads a `user.json` from the current working directory or the executable directory:

```json
{
	"variables": {
		"key1": "value1",
		"key2": "value2"
	}
}
```

Variables defined here can be referenced in task configurations using `%key1%` syntax.

### Built-in Variables

| Variable     | Description               |
| ------------ | ------------------------- |
| `%testdata%` | Test data directory       |
| `%execPath%` | Engine executable path    |
| `%cwd%`      | Current working directory |
| `%NodeId%`   | Node identifier           |
| `%plat%`     | Platform identifier       |

### Configuration Precedence

1. Command-line arguments (`--option=value`)
2. `user.json`
3. Environment variables
4. Task manifest defaults

---

## Data Sources

The engine supports multiple data source endpoints through its store/pipeline system:

- **Filesystem** -- local file access
- **SMB** -- Windows/Samba network shares
- **Azure** -- Azure Blob Storage
- **S3** -- Amazon S3
- **ZIP** -- ZIP archive access
- **Python** -- Python-based data sources

---

## Monitor Types

| Type          | Description                             |
| ------------- | --------------------------------------- |
| `Console`     | Human-readable output (default)         |
| `App`         | Machine-parseable JSON telemetry output |
| `TestConsole` | Test harness output                     |

Set with `--monitor TYPE`.

---

## Directory Structure

```text
apps/engine/
├── src/
│   ├── main.cpp                    # Entry point
│   ├── CMakeLists.txt              # Build config
│   └── res/                        # Resources (version info)

packages/server/
├── engine-core/apLib/              # Core utilities library
│   ├── application/                # CmdLine parsing, options
│   ├── async/                      # Threading primitives
│   ├── compress/                   # FastPFor, LZ4
│   ├── crypto/                     # OpenSSL-based cryptography
│   ├── error/                      # Error handling
│   ├── factory/                    # Object factories
│   ├── file/                       # File I/O and scanning
│   ├── json/                       # JSON processing
│   ├── log/                        # Logging system
│   ├── match/                      # Pattern matching
│   ├── memory/                     # Memory management
│   ├── plat/                       # Platform abstractions
│   ├── string/                     # String utilities
│   ├── time/                       # Time utilities
│   ├── url/                        # URL handling
│   ├── util/                       # General utilities
│   └── xml/                        # XML processing
├── engine-lib/engLib/              # Main engine library
│   ├── config/                     # Configuration management
│   ├── core/                       # Init/deinit, global config
│   ├── headers/                    # Shared headers
│   ├── index/                      # Inverted index, search
│   ├── java/                       # Java/Tika integration
│   ├── keystore/                   # Key storage
│   ├── monitor/                    # Monitoring system
│   ├── net/                        # RPC, TLS networking
│   ├── perms/                      # ACL handling
│   ├── plat/                       # Platform-specific code
│   ├── python/                     # Python integration
│   ├── store/                      # Store/pipeline, endpoints
│   ├── stream/                     # Stream providers
│   ├── sysinfo/                    # System information
│   ├── tag/                        # Tag system
│   └── task/                       # Task system and execution
└── CMakeLists.txt                  # Build orchestration
```

---

## Python Integration

When extending the engine with Python (custom nodes, filter callbacks), Pydantic models (`Question`, `Answer`, `IInvokeLLM`, `IInvokeTool`, etc.) must be converted to plain dicts via `.model_dump()` before passing to C++ JSON utilities, passing raw `BaseModel` instances causes crashes. See `ROCKETRIDE_COMMON_MISTAKES.md` (Mistake 19) for details.

---

## Dependencies

- **Boost** -- filesystem, threading
- **OpenSSL** -- cryptography
- **Python 3.10** -- optional, for Python integration
- **Java** -- optional, for Tika document processing
- **vcpkg packages** -- replxx, tinyxml2, breakpad, etc.

### Tika Media Parsing: External Tool Requirements

Media files work out of the box: the engine's built-in Java parsers (`Mp4Parser`/`Mp3Parser`/`AudioParser`) extract basic metadata (duration, codec, sample rate, dimensions) and deliver the media stream, with **no external tools required**.

For **extended** metadata, Tika can additionally use external command-line tools via `CompositeExternalParser`. These are **optional** — install all three (and ensure `env` is on `PATH`, non-Windows) to enable them:

| Tool         | Provides extended metadata for                            |
| ------------ | --------------------------------------------------------- |
| **ffmpeg**   | `video/avi`, `video/mpeg`, `video/x-msvideo`              |
| **exiftool** | `video/mp4`, `video/avi`, `video/mpeg`, `video/x-msvideo` |
| **sox**      | `audio/*` (mp3, wav, ogg, and others)                     |

The external parsers shell out via the Unix `env` shim; if `env` or a required tool is missing, the process fails to launch and Tika raises a `TikaException`. Historically that aborted the entire extraction — **including media stream delivery**, so a standalone video/audio file produced no frames at all (the exception was caught and only logged).

**This is now handled automatically — no configuration required.** The engine's Tika layer does two things:

1. **Auto-detect + fallback (`ConfigBuilder.getConfig`).** At config-build time the engine probes for the external tools. It keeps the external parsers **only when the full toolchain is present** — `env` **and** `ffmpeg` **and** `exiftool` **and** `sox`; if **any** is missing it excludes `ExternalParser`/`CompositeExternalParser` and falls back to the built-in parsers for everything. This all-or-nothing rule avoids a mixed state where a kept external parser throws for a file whose specific tool is absent. The tools launch via the Unix `env` shim on **every** platform, so `env` is probed everywhere (not just Windows); on Windows `env` is absent, so the built-in parsers are always used there.
2. **Decoupled streaming (`TikaApi.extractInformation`).** Metadata extraction for a standalone media file runs in its own `try/catch`, so even if a parser throws, the media bytes are still streamed. Media delivery no longer depends on metadata-parse success.

**To get extended file metadata:** install `ffmpeg`, `exiftool`, and `sox` (all three) on `PATH`, on a non-Windows host (so `env` resolves). Otherwise the built-in parsers are used, which still provide solid basic metadata and always deliver the media stream.

**Manual override** is still honored: an explicit `<parser-exclude>` in `tika-config.xml` is respected as-is (the auto-detect skips its probe for any parser already excluded):

```xml
<properties>
  <parsers>
    <parser class="org.apache.tika.parser.DefaultParser">
      <parser-exclude class="org.apache.tika.parser.external.ExternalParser"/>
      <parser-exclude class="org.apache.tika.parser.external.CompositeExternalParser"/>
    </parser>
  </parsers>
</properties>
```

---

## License

MIT License -- see [LICENSE](../LICENSE).
