# RocketRide

Python SDK for the RocketRide Engine - build, run, and manage AI pipelines from Python.

## Quick Start

```bash
pip install rocketride
```

```python
from rocketride import RocketRideClient

async with RocketRideClient(uri="https://cloud.rocketride.ai", auth="your-api-key") as client:
    result = await client.use(filepath="./pipeline.pipe")
    token = result["token"]
    response = await client.send(token, "Hello, pipeline!", {"name": "input.txt"}, "text/plain")
    print(response)
    await client.terminate(token)
```

Don't have a pipeline yet? Visit [RocketRide on GitHub](https://github.com/rocketride-org/rocketride-server) or download the extension directly in your IDE.

<p align="center">
  <img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/develop/images/install.png" alt="Install RocketRide extension" width="600">
</p>

## What is RocketRide?

[RocketRide](https://rocketride.org) is an open-source, developer-native AI pipeline platform.
It lets you build, debug, and deploy production AI workflows without leaving your IDE -
using a visual drag-and-drop canvas or code-first with TypeScript and Python SDKs.

- **50+ ready-to-use nodes** - 13 LLM providers, 8 vector databases, OCR, NER, PII anonymization, and more
- **High-performance C++ engine** - production-grade speed and reliability
- **Deploy anywhere** - locally, on-premises, or self-hosted with Docker
- **MIT licensed** - fully open-source, OSI-compliant

You build your `.pipe` - and you run it against the fastest AI runtime available.

<img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/develop/docs/images/canvas.png" alt="RocketRide visual canvas builder" width="800">

## Features

- **Pipeline execution** - Start with `use()`, send data via `send()`, `send_files()`, or `pipe()`
- **Chat / AI** - Conversational AI via `chat()` and `Question`
- **File upload** - `send_files()` with parallel transfers; streaming with `pipe()`
- **Event streaming** - Real-time events via `on_event` and `set_events()`
- **Project storage** - Save, retrieve, and version-control pipelines on the server
- **Async-first** - Built on `asyncio` and `websockets`; supports `async with` context manager
- **CLI included** - Manage pipelines from the command line

## API Overview

### Connection

| Method                               | Description                                  |
| ------------------------------------ | -------------------------------------------- |
| `connect(uri?, auth?, timeout?)`     | Open a WebSocket connection and authenticate |
| `disconnect()`                       | Close the connection                         |
| `set_connection_params(uri?, auth?)` | Update server URI and/or auth at runtime     |
| `get_connection_info()`              | Current connection state, transport, and URI |

### Pipeline Execution

| Method                                                   | Description                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `use(filepath?, pipeline?, token?, threads?, ttl?, ...)` | Start a pipeline; returns `{"token": ...}`                            |
| `terminate(token)`                                       | Stop a running pipeline and free resources                            |
| `get_task_status(token)`                                 | Poll task progress (`completed`, `completedCount`, `totalCount`, ...) |
| `validate(pipeline, source?)`                            | Validate a pipeline configuration without starting it                 |

### Data

| Method                                   | Description                                      |
| ---------------------------------------- | ------------------------------------------------ |
| `send(token, data, objinfo?, mimetype?)` | Send data in one shot                            |
| `send_files(files, token)`               | Upload multiple files with parallel transfers    |
| `pipe(token, objinfo?, mime_type?)`      | Create a streaming `DataPipe` (open/write/close) |

### Chat

| Method                  | Description                                           |
| ----------------------- | ----------------------------------------------------- |
| `chat(token, question)` | Send a `Question` to the AI and get a pipeline result |

### Events

| Method                           | Description                                            |
| -------------------------------- | ------------------------------------------------------ |
| `set_events(token, event_types)` | Subscribe to event types (e.g. `apaevt_status_upload`) |

### Services and Ping

| Method                 | Description                             |
| ---------------------- | --------------------------------------- |
| `get_services()`       | List all service/connector definitions  |
| `get_service(service)` | Get a single service definition by name |
| `ping(token?)`         | Lightweight liveness check              |

### Project Storage

| Method                                                  | Description                                |
| ------------------------------------------------------- | ------------------------------------------ |
| `save_project(project_id, pipeline, expected_version?)` | Save a project with optional version check |
| `get_project(project_id)`                               | Retrieve a project                         |
| `delete_project(project_id, expected_version?)`         | Delete a project                           |
| `get_all_projects()`                                    | List all projects                          |

## CLI

The `rocketride` command is installed automatically with the package.

```bash
rocketride start pipeline.json              # Start a pipeline
rocketride upload *.pdf --token <token>      # Upload files to a running pipeline
rocketride status --token <token>            # Monitor task progress
rocketride stop --token <token>              # Terminate a running task
rocketride list                              # List all active tasks
rocketride events ALL --token <token>        # Stream task events
rocketride rrext_store get_all_projects      # List stored projects
```

All commands accept `--uri` and `--apikey` flags, or read from environment variables.

## Configuration

| Variable            | Description                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| `ROCKETRIDE_URI`    | Server URI (e.g. `wss://cloud.rocketride.ai` or `ws://localhost:5565`) |
| `ROCKETRIDE_APIKEY` | API key for authentication                                             |

## Links

- [Documentation](https://docs.rocketride.org/)
- [GitHub](https://github.com/rocketride-org/rocketride-server)
- [Discord](https://discord.gg/9hr3tdZmEG)
- [Contributing](https://github.com/rocketride-org/rocketride-server/blob/develop/CONTRIBUTING.md)

## License

MIT - see [LICENSE](https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE).
