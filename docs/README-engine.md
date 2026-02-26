# RocketRide Engine

RocketRide Engine -- The main engine executable.

---

## Overview

The engine executable is the main entry point for the RocketRide data processing engine. It provides:

- Command-line interface
- Pipeline execution
- Data source scanning
- AI/ML processing
- Network communication

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

---

## Usage

```bash
# From repo root, run the local EAAS service on port 5565
./dist/server/Engine ./dist/server/ai/eaas.py --port=5565

# Equivalent from dist/server/
cd dist/server
./Engine ./ai/eaas.py --port=5565

# Execute a task file directly
./Engine /path/to/task.json
```

---

## How CLI Arguments Work

The engine processes non-option positional arguments as files/scripts to execute.
Options by themselves do not start a long-running service.

For example:

- `./Engine --service --port=5565` may exit immediately without doing work
- `./Engine ./ai/eaas.py --port=5565` starts the EAAS server
- `./Engine /path/to/task.json` executes a task config

## Commonly Used Options

| Option | Description |
| ------ | ----------- |
| `--port=<port>` | Port passed to scripts that accept `--port` (for example `ai/eaas.py`) |
| `--base_port=<port>` | Base port range used by task services (for example `ai/eaas.py`) |
| `--verbose` / `-v` | Enable verbose logging (script-dependent) |
| `--verify` | Verify installation and exit |

---

## Configuration

Create a `config.json` file:

```json
{
  "dataPath": "/var/rocketride/data",
  "logPath": "/var/rocketride/logs",
  "port": 8080,
  "workers": 4
}
```

---

## Directory Structure

```text
apps/engine/
├── src/               # Source files
│   ├── main.cpp       # Entry point
│   ├── CMakeLists.txt # CMake config
│   └── res/           # Resources
└── README.md          # This file
```

---

## License

MIT License -- see [LICENSE](../LICENSE).
