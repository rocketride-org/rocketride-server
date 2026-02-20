# @rocketride/engine-lib

RocketRide Engine Library - Engine-specific C++ functionality built on top of the core library.

## Overview

The engine library (`engLib`) provides engine-specific functionality:

- **Config** - Configuration management
- **Index** - Full-text indexing and search
- **Java** - Java/Tika integration
- **Keystore** - Key management and encryption
- **Monitor** - Task monitoring and metrics
- **Net** - Network communication and RPC
- **Perms** - Permission handling
- **Pipeline** - Data processing pipelines
- **Python** - Python integration
- **Store** - Data storage endpoints and filters
- **Stream** - Data streaming
- **Task** - Task execution

## Building

The engine library is built as part of the main RocketRide Engine build:

```bash
# From the repository root
pnpm run configure
pnpm run build:engine-lib
```

## Directory Structure

```
packages/server/engine-lib/
├── include/engLib/    # Public headers
│   ├── config/        # Configuration
│   ├── index/         # Indexing and search
│   ├── java/          # Java integration
│   ├── keystore/      # Key management
│   ├── monitor/       # Monitoring
│   ├── net/           # Networking
│   ├── perms/         # Permissions
│   ├── python/        # Python integration
│   ├── store/         # Storage layer
│   ├── stream/        # Streaming
│   └── task/          # Task management
├── rocketride-python/    # Python runtime files
├── cmake/             # CMake modules
├── test/              # Unit tests
├── CMakeLists.txt     # CMake build configuration
└── engDeps.json       # vcpkg dependencies
```

## License

MIT License - see [LICENSE](../../LICENSE)

