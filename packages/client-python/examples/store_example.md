# RocketRide Store Command Examples

The `apaext_store` command provides atomic project storage operations using the configured storage backend (filesystem, S3, Azure Blob, etc.).

## Quick Start with --project-json

Here's a simple example using inline JSON:

```bash
# 1. Save a project with inline JSON
python run_cli.py apaext_store save_project \
  --apikey YOUR_KEY \
  --project-id my-proj \
  --project-json '{
    "name": "My Pipeline",
    "source": "source_1",
    "components": [
      {
        "id": "source_1",
        "provider": "filesystem",
        "config": {
          "mode": "Source",
          "name": "Local Files",
          "path": "/data"
        }
      }
    ]
  }'

# 2. Get the project
python run_cli.py apaext_store get_project \
  --apikey YOUR_KEY \
  --project-id my-proj

# 3. Delete the project
python run_cli.py apaext_store delete_project \
  --apikey YOUR_KEY \
  --project-id my-proj
```

**See also:**
- `store_example_json.py` - Python script with inline JSON examples
- `store_quick_test.sh` - Bash script for testing (Linux/Mac)
- `store_quick_test.ps1` - PowerShell script for testing (Windows)

## Configuration

The storage backend is configured via environment variables:

```bash
# Filesystem (default)
export STORE_URL="filesystem:///path/to/storage"

# AWS S3
export STORE_URL="s3://my-bucket/prefix"
export STORE_SECRET_KEY='{"access_key_id":"...","secret_access_key":"...","region":"us-east-1"}'

# Azure Blob Storage
export STORE_URL="azureblob://my-container/prefix"
export STORE_SECRET_KEY='{"connection_string":"..."}'
```

## Commands

### Save Project

Save a project to storage with atomic write operations:

```bash
# From a JSON file (auto-fetch current version for atomic update)
python run_cli.py apaext_store save_project \
  --apikey YOUR_KEY \
  --project-id project-123 \
  --project-file pipeline.json

# From inline JSON string (compact)
python run_cli.py apaext_store save_project \
  --apikey YOUR_KEY \
  --project-id proj1 \
  --project-json '{"name":"My Project","source":"source_1","components":[]}'

# With explicit version for atomic update
python run_cli.py apaext_store save_project \
  --apikey YOUR_KEY \
  --project-id project-123 \
  --expected-version abc123def456 \
  --project-file pipeline.json
```

**Pipeline JSON Format:**
```json
{
  "name": "My Project",
  "description": "Optional description",
  "source": "source_1",
  "components": [
    {
      "id": "source_1",
      "provider": "filesystem",
      "config": {
        "mode": "Source",
        "name": "Filesystem Source",
        "path": "/data"
      }
    }
  ]
}
```

**Success Response:**
```json
{
  "success": true,
  "message": "Project saved successfully",
  "project_id": "project-123",
  "version": "abc123def456..."
}
```

### Get Project

Retrieve a project by ID:

```bash
python run_cli.py apaext_store get_project --apikey YOUR_KEY --project-id project-123
```

**Success Response:**
```json
{
  "success": true,
  "pipeline": {
    "name": "My Project",
    "source": "source_1",
    "components": [...]
  },
  "version": "abc123def456..."
}
```

### Delete Project

Delete a project by ID:

```bash
# Simple delete
python run_cli.py apaext_store delete_project --apikey YOUR_KEY --project-id project-123

# Atomic delete with version check
python run_cli.py apaext_store delete_project --apikey YOUR_KEY --project-id project-123 --expected-version abc123def456
```

### Get All Projects

List all projects for authenticated user:

```bash
python run_cli.py apaext_store get_all_projects --apikey YOUR_KEY
```

**Success Response:**
```json
{
  "success": true,
  "projects": [
    {
      "id": "project-123",
      "name": "My Project",
      "sources": [
        {
          "id": "source_1",
          "provider": "filesystem",
          "name": "Filesystem Source"
        }
      ],
      "totalComponents": 3
    }
  ],
  "count": 1
}
```

## Log Commands

Logs are per-project files that store status update events for historical tracking.

### Save Log

```bash
python run_cli.py apaext_store save_log \
  --apikey YOUR_KEY \
  --project-id project-123 \
  --source source_1 \
  --contents-json '{
    "type": "event",
    "event": "apaevt_status_update",
    "body": {
      "source": "source_1",
      "startTime": 1764337626.6564875,
      "status": "Completed"
    }
  }'
```

### Get Log

```bash
python run_cli.py apaext_store get_log \
  --apikey YOUR_KEY \
  --project-id project-123 \
  --source source_1 \
  --start-time 1764337626.6564875
```

### List Logs

```bash
# List all logs
python run_cli.py apaext_store list_logs \
  --apikey YOUR_KEY \
  --project-id project-123

# Filter by source
python run_cli.py apaext_store list_logs \
  --apikey YOUR_KEY \
  --project-id project-123 \
  --source source_1
```

## Error Codes

| Error Code | Description |
|------------|-------------|
| `CONFLICT` | Version mismatch - project was modified by another process |
| `NOT_FOUND` | Project does not exist |
| `STORAGE_ERROR` | Storage backend error (permissions, network, etc.) |
| `UNKNOWN_ERROR` | Unexpected error |

## Notes

- All operations return JSON responses for easy parsing
- The `--apikey` flag is **required** for all store commands (operations are server-side)
- User identity is derived from the authenticated API key
- The `project-id` is passed as a **separate argument**, not inside the pipeline JSON
- Sources are components where `config.mode == "Source"`
