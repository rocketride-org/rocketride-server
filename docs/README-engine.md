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
# Run a pipeline
./Engine --pipeline /path/to/pipeline.json

# Interactive mode
./Engine --interactive

# Service mode
./Engine --service --port 8080
```

---

## Command-Line Options

| Option | Description |
| ------ | ----------- |
| `--pipeline <path>` | Pipeline file to execute |
| `--interactive` | Run in interactive mode |
| `--service` | Run as a service |
| `--port <port>` | Service port (default: 8080) |
| `--config <path>` | Configuration file |
| `--log-level <level>` | Log level (debug, info, warn, error) |
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
