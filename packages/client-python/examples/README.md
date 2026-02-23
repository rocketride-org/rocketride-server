# RocketRide Store Examples

This directory contains examples and test scripts for the `apaext_store` command.

## Files

### Documentation
- **`store_example.md`** - Comprehensive usage guide with all command examples
- **`COMMAND_EXAMPLES.md`** - Command reference with troubleshooting
- **`HOW_TO_RUN_TESTS.md`** - Step-by-step guide for running tests

### Python Examples
- **`run_cli.py`** - CLI entry point for development
- **`demo_store.py`** - Full integration demo showing all store operations
- **`store_example_json.py`** - Simple example using `--project-json` parameter

### Quick Test Scripts
- **`store_quick_test.ps1`** - **PowerShell script (Windows)**
- **`store_quick_test.sh`** - Bash script (Linux/Mac)

## Quick Start

> **📖 NEW USERS: Read [HOW_TO_RUN_TESTS.md](HOW_TO_RUN_TESTS.md) first!**
> 
> Complete guide with prerequisites, troubleshooting, and step-by-step instructions.

### Quick Script Selection

| Your Shell | Use This Script | Notes |
|------------|----------------|-------|
| **PowerShell (Windows)** | `store_quick_test.ps1` ✅ | Supports both `-NoDelete` and `--nodelete` |
| **Bash (Linux/Mac)** | `store_quick_test.sh` | Unix/Linux/Mac |

### Using --project-json (Inline JSON)

The simplest way to test is with inline JSON:

```bash
# Save a project
python run_cli.py apaext_store save_project \
  --apikey YOUR_KEY \
  --project-id test-proj \
  --project-json '{
    "name": "Test Pipeline",
    "source": "source_1",
    "components": [
      {
        "id": "source_1",
        "provider": "filesystem",
        "config": {
          "mode": "Source",
          "name": "Test Source",
          "path": "/tmp/data"
        }
      }
    ]
  }'

# Get the project
python run_cli.py apaext_store get_project \
  --apikey YOUR_KEY \
  --project-id test-proj
```

### Using --project-file (JSON File)

For more complex pipelines, use a JSON file:

**pipeline.json:**
```json
{
  "name": "My Pipeline",
  "description": "A more complex example",
  "source": "source_1",
  "components": [
    {
      "id": "source_1",
      "provider": "filesystem",
      "config": {
        "mode": "Source",
        "name": "Local Files",
        "path": "/data/input"
      }
    },
    {
      "id": "processor_1",
      "provider": "ai_chat",
      "config": {
        "model": "gpt-4",
        "system_prompt": "You are a helpful assistant"
      },
      "input": [
        {
          "lane": "output",
          "from": "source_1"
        }
      ]
    }
  ]
}
```

**Command:**
```bash
python run_cli.py apaext_store save_project \
  --apikey YOUR_KEY \
  --project-id my-pipeline \
  --project-file pipeline.json
```

## Running Examples

### Python Scripts

**demo_store.py** - Full integration demo:
```bash
cd packages/client-python/examples
python demo_store.py --apikey YOUR_KEY --uri http://localhost:5565
```

**store_example_json.py** - Simple inline JSON example:
```bash
cd packages/client-python/examples
# Edit the file to add your API key first
python store_example_json.py
```

### Shell Scripts

**Linux/Mac:**
```bash
cd packages/client-python/examples
chmod +x store_quick_test.sh
./store_quick_test.sh YOUR_API_KEY
```

**Windows (PowerShell):**
```powershell
cd packages\client-python\examples
.\store_quick_test.ps1 YOUR_API_KEY
```

## Pipeline Structure

Projects must follow the RocketRide pipeline structure:

```json
{
  "name": "Pipeline Name",
  "description": "Optional description",
  "source": "source_component_id",
  "components": [
    {
      "id": "unique_id",
      "provider": "component_type",
      "config": {
        "mode": "Source",
        "name": "Component Name"
      },
      "input": [
        {
          "lane": "output_lane_name",
          "from": "source_component_id"
        }
      ]
    }
  ]
}
```

**Important:**
- `project_id` is passed as `--project-id` CLI argument (NOT in pipeline JSON)
- Pipeline JSON contains only the pipeline configuration
- The filename will be `<project-id>.json`

## All Available Commands

```bash
# Save/update project
python run_cli.py apaext_store save_project --apikey KEY --project-id ID --project-file pipeline.json
python run_cli.py apaext_store save_project --apikey KEY --project-id ID --project-json '...'

# Get project
python run_cli.py apaext_store get_project --apikey KEY --project-id ID

# Delete project
python run_cli.py apaext_store delete_project --apikey KEY --project-id ID
python run_cli.py apaext_store delete_project --apikey KEY --project-id ID --expected-version VERSION

# List all projects
python run_cli.py apaext_store get_all_projects --apikey KEY

# Save/get logs
python run_cli.py apaext_store save_log --apikey KEY --project-id ID --source SOURCE --contents-json '...'
python run_cli.py apaext_store get_log --apikey KEY --project-id ID --source SOURCE --start-time TIME
python run_cli.py apaext_store list_logs --apikey KEY --project-id ID
```

## Troubleshooting

### Error: "Project ID is required"
Make sure you provide `--project-id`:
```bash
python run_cli.py apaext_store save_project --project-id my-proj --project-file pipeline.json
```

### Error: "Either --project-file or --project-json is required"
Provide one of these:
```bash
# Option 1: File
--project-file pipeline.json

# Option 2: Inline JSON
--project-json '{"name":"My Pipeline","source":"source_1",...}'
```

### Error: "API key is required"
All store commands require authentication:
```bash
# Provide via flag
--apikey YOUR_KEY

# Or via environment variable
export APARAVI_APIKEY=YOUR_KEY
python run_cli.py apaext_store save_project ...
```

## Notes

- All operations return JSON output for easy parsing
- User identity (clientid) is derived from the API key automatically
- Storage backend is configured server-side
- Version checking prevents concurrent modification conflicts
- Commands work identically with `--project-file` or `--project-json`

## See Also

- `store_example.md` - Detailed command reference
- `demo_store.py` - Full workflow demonstration
- `store_example_json.py` - Focused --project-json examples
