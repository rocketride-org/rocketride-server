# Build Process Guide

This guide describes how to build user interfaces, clients, and other non-C++ components without building the full engine.

## Overview

While building the full engine will automatically handle all components, it takes an excessive amount of time. This guide provides faster alternatives for building specific components during development.

## Prerequisites

- Node.js and pnpm installed
- Access to the project directories

## Quick Build Commands

### Python Client SDK

To build the Python client SDK:

```bash
cd packages/client-python
pnpm build
```

### TypeScript User Interfaces

To build the TypeScript user chat and other user interfaces:

```bash
cd apps/chat-ui
pnpm build
```

## Build Process Summary

| Component | Directory | Command |
|-----------|-----------|---------|
| Python Client SDK | `packages/client-python` | `pnpm build` |
| TypeScript UIs (chat, etc.) | `apps/chat-ui` | `pnpm build` |
| Full Engine | Root | *See full engine documentation* |

## Development Workflow

For faster development cycles:

1. **UI Development**: Use `apps/chat-ui` directory with `pnpm build` for quick iterations on user interfaces
2. **Python SDK Development**: Use `packages/client-python` directory with `pnpm build` for client SDK changes
3. **Full Build**: Only run the complete engine build when necessary for integration testing

## Notes

- These individual build commands are significantly faster than building the entire engine
- The full engine build will automatically include all these components, but should be reserved for final builds or when C++ components are modified
- Make sure to run builds from the correct directories as specified above
