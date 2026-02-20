# @rocketride/core

RocketRide Core Library - High-performance C++ foundational library providing essential utilities and abstractions.

## Overview

The core library (`apLib`) provides the foundational C++ components used throughout the RocketRide Engine:

- **Async** - Threading, synchronization, and work queues
- **Crypto** - Encryption, hashing, and key management
- **File** - Cross-platform file system operations
- **JSON** - JSON parsing and serialization
- **Memory** - Memory management and data buffers
- **String** - Unicode-aware string operations
- **Time** - Time utilities and formatting
- **URL** - URL parsing and building

## Building

The core library is built as part of the main RocketRide Engine build:

```bash
# From the repository root
pnpm run configure
pnpm run build:core
```

## Directory Structure

```
packages/server/engine-core/
├── include/apLib/     # Public headers
│   ├── async/         # Async primitives
│   ├── crypto/        # Cryptographic functions
│   ├── file/          # File system operations
│   ├── json/          # JSON handling
│   ├── memory/        # Memory management
│   ├── string/        # String operations
│   └── ...            # Other modules
├── cmake/             # CMake modules and triplets
├── 3rdparty/          # Third-party dependencies
├── test/              # Unit tests
├── CMakeLists.txt     # CMake build configuration
└── apDeps.json        # vcpkg dependencies
```

## License

MIT License - see [LICENSE](../../LICENSE)

