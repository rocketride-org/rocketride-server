# Clients Module

This module provides HTTP endpoints to download the Python and TypeScript client SDKs.

## Endpoints

### Python Client
- **URL**: `/client/python`
- **Method**: GET
- **Description**: Downloads the latest Python client wheel package
- **Response**: `rocketride-{version}-py3-none-any.whl`

### TypeScript Client
- **URL**: `/client/typescript`
- **Method**: GET
- **Description**: Downloads the latest TypeScript client package
- **Response**: `rocketride-client-typescript-{version}.tgz`

### VSCode Extension
- **URL**: `/client/vscode`
- **Method**: GET
- **Description**: Downloads the latest VSCode extension package
- **Response**: `rocketride-{version}.vsix`

## Files Served

The module serves files from `./clients/` (relative to the engine's working directory at `build/Engine`):
- `rocketride-*.whl` - Python client wheel package
- `rocketride-client-typescript-*.tgz` - TypeScript client package
- `rocketride-*.vsix` - VSCode extension package

## Testing

Once the server is running, you can test the endpoints:

### Using curl
```bash
# Download Python client
curl -O http://localhost:5565/client/python

# Download TypeScript client
curl -O http://localhost:5565/client/typescript

# Download VSCode extension
curl -O http://localhost:5565/client/vscode
```

### Using wget
```bash
# Download Python client
wget http://localhost:5565/client/python

# Download TypeScript client
wget http://localhost:5565/client/typescript

# Download VSCode extension
wget http://localhost:5565/client/vscode
```

### Using a browser
Simply navigate to:
- `http://localhost:5565/client/python`
- `http://localhost:5565/client/typescript`
- `http://localhost:5565/client/vscode`

## Installation

### Python Client
```bash
pip install rocketride-1.1.0-py3-none-any.whl
```

### TypeScript Client
```bash
npm install rocketride-client-typescript-1.0.0.tgz
```

### VSCode Extension
```bash
code --install-extension rocketride-1.0.0.vsix
```

## Module Structure

```
clients/
├── __init__.py       # Module initialization and route registration
├── clients.py        # Request handlers for serving client packages
└── README.md         # This file
```

## Implementation Details

- The module automatically finds the latest version of each client package
- Files are served with appropriate MIME types:
  - Python wheel: `application/octet-stream`
  - TypeScript package: `application/gzip`
  - VSCode extension: `application/octet-stream`
- All endpoints are public (no authentication required)
- Returns 404 with JSON error if packages are not found

