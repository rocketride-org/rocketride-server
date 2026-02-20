# RocketRide Engine Architecture

This document provides an overview of the RocketRide Engine architecture.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Applications                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Chat UI    │  │ Dropper UI  │  │   Engine CLI        │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                       Clients                                │
│  ┌───────────┐  ┌──────────────┐  ┌─────────────────────┐   │
│  │  Python   │  │  TypeScript  │  │        MCP          │   │
│  └───────────┘  └──────────────┘  └─────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│                    Engine Library                            │
│  ┌───────────┐  ┌──────────────┐  ┌─────────────────────┐   │
│  │    AI     │  │    Nodes     │  │     Java/Tika       │   │
│  └───────────┘  └──────────────┘  └─────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│                      Core Library                            │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  async │ crypto │ file │ json │ memory │ string │ ... │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Components

### Core Library (apLib)

The foundational C++ library providing:

- **Async** - Threading primitives, work queues, synchronization
- **Crypto** - Encryption, hashing, key management
- **File** - Cross-platform file system operations
- **JSON** - High-performance JSON parsing/serialization
- **Memory** - Memory management, buffers, allocators
- **String** - Unicode-aware string operations
- **Time** - Time utilities and formatting
- **URL** - URL parsing and building

### Engine Library (engLib)

Engine-specific functionality built on the core:

- **Store** - Data storage layer with endpoints and filters
- **Pipeline** - Data processing pipeline execution
- **Index** - Full-text search indexing
- **Python** - Python runtime integration
- **Java** - Java/Tika integration
- **Network** - RPC and communication
- **Task** - Task execution and monitoring

### Nodes

Modular Python-based integrations:

- Cloud storage (OneDrive, SharePoint, Google Drive)
- Databases (MySQL, PostgreSQL)
- Vector databases (Chroma, Pinecone, Milvus)
- LLM providers (OpenAI, Anthropic, Gemini)
- Processing (OCR, transcription, embedding)

### AI Module

AI/ML capabilities:

- Chat interface
- Embedding generation
- Model serving
- Preprocessing

### Client Libraries

SDKs for integration:

- Python client
- TypeScript client
- MCP (Model Context Protocol) client

## Data Flow

### Pipeline Execution

```
┌──────────┐    ┌───────────┐    ┌────────────┐    ┌──────────┐
│  Source  │ -> │  Filters  │ -> │  AI/ML     │ -> │  Target  │
│ Endpoint │    │ (parse,   │    │ (classify, │    │ Endpoint │
│          │    │  hash)    │    │  embed)    │    │          │
└──────────┘    └───────────┘    └────────────┘    └──────────┘
```

### Message Protocol

Communication uses a JSON-based message protocol:

```json
{
  "type": "request",
  "id": "uuid",
  "method": "execute",
  "params": { ... }
}
```

## Threading Model

- Main thread handles coordination
- Worker pool for CPU-bound tasks
- Async I/O for network operations
- Python GIL management for Python nodes

## Configuration

### Pipeline Configuration

Pipelines are defined in JSON:

```json
{
  "source": {
    "type": "filesys",
    "path": "/data/input"
  },
  "filters": [
    { "type": "parse" },
    { "type": "hash" }
  ],
  "target": {
    "type": "filesys",
    "path": "/data/output"
  }
}
```

### Engine Configuration

Engine settings in `config.json`:

```json
{
  "dataPath": "/var/rocketride/data",
  "logPath": "/var/rocketride/logs",
  "workers": 4,
  "port": 8080
}
```

## Security

- TLS for network communication
- Encryption at rest support
- Key management via keystore
- Permission handling

## See Also

- [Setup Guide](../setup/README.md)
- [API Reference](../api/README.md)
- [Node Development](../nodes/README.md)

