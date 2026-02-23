# How to Run apaext_store Test Scripts

## Quick Reference

| Script | Platform | When to Use |
|--------|----------|-------------|
| `store_quick_test.ps1` | Windows | Quick smoke test with inline JSON (PowerShell) |
| `store_quick_test.sh` | Linux/Mac | Quick smoke test with inline JSON (Bash) |
| `demo_store.py` | All | Full integration test with file-based JSON |
| `store_example_json.py` | All | Example of using inline JSON in Python |

---

## Prerequisites (MUST READ!)

### 1. Server Must Be Running

The EaaS (Engine as a Service) server must be running **before** you run any tests.

**Check if server is running:**
```bash
# Windows PowerShell
Invoke-WebRequest -Uri http://localhost:5565/health

# Linux/Mac
curl http://localhost:5565/health
```

**If not running, start the server:**
```bash
# From engine-new root directory
.\builder server:build
# Then run the server (see project documentation)
```

### 2. Valid API Key Required

You need a valid API key for authentication. Get this from your RocketRide administrator or create one through the admin interface.

### 3. Correct Working Directory

Scripts should be run from the `examples` directory:

```
packages/client-python/examples/
```

---

## Running Test Scripts (Windows)

### PowerShell Script

## Running `store_quick_test.ps1` (PowerShell)

### Step 1: Open PowerShell

```powershell
# Navigate to examples directory
cd packages\client-python\examples
```

### Step 2: Verify Prerequisites

```powershell
# Check if server is running
Invoke-WebRequest -Uri http://localhost:5565/health

# Check if Python is available
python --version
```

### Step 3: Run the Script

**Basic usage (default URI: http://localhost:5565):**
```powershell
.\store_quick_test.ps1 YOUR_API_KEY
```

**With custom server URI:**
```powershell
.\store_quick_test.ps1 YOUR_API_KEY http://localhost:5565
```

**Keep test project (don't delete):**
```powershell
.\store_quick_test.ps1 YOUR_API_KEY -NoDelete

# Bash-style also works!
.\store_quick_test.ps1 YOUR_API_KEY --nodelete
```

**Full examples:**
```powershell
# Run test and delete project (default)
.\store_quick_test.ps1 abc123def456

# Run test with custom URI
.\store_quick_test.ps1 abc123def456 http://localhost:5565

# Keep project (PowerShell-style)
.\store_quick_test.ps1 abc123def456 -NoDelete

# All together
.\store_quick_test.ps1 abc123def456 http://localhost:5565 -NoDelete
```

### Expected Output

```
=========================================
Testing apaext_store with inline JSON
=========================================
Project ID: test-proj-12345
Server URI: http://localhost:5565

Step 1: Save NEW project with --project-json
---------------------------------------------
{
  "success": true,
  "version": "abc123...",
  "message": "Project saved successfully"
}

Step 2: Get the saved project
------------------------------
{
  "success": true,
  "pipeline": {...}
}

...

=========================================
Test completed successfully!
=========================================
```

### Common Errors and Solutions

#### Error: "Server is not connected"

**Cause:** EaaS server is not running

**Fix:**
```cmd
# Check if server is running
curl http://localhost:5565/health

# If not running, start it (see your server startup documentation)
```

---

#### Error: "API key is required"

**Cause:** Didn't provide API key as argument

**Fix:**
```powershell
# Provide API key as first argument
.\store_quick_test.ps1 YOUR_ACTUAL_KEY
```

---

#### Error: "'python' is not recognized"

**Cause:** Python is not installed or not in PATH

**Fix:**
```cmd
# Install Python 3.7+ from python.org
# Or add Python to your PATH

# Verify Python installation
python --version

# Should show: Python 3.x.x
```

---

## Running `store_quick_test.sh` (Linux/Mac)

### Step 1: Open Terminal

```bash
# Navigate to examples directory
cd packages/client-python/examples
```

### Step 2: Make Script Executable

```bash
chmod +x store_quick_test.sh
```

### Step 3: Run the Script

```bash
# Basic usage
./store_quick_test.sh YOUR_API_KEY

# With custom URI
./store_quick_test.sh YOUR_API_KEY http://localhost:5565
```

---

## Running `demo_store.py` (Full Integration Test)

### Step 1: Navigate to Examples Directory

```bash
cd packages/client-python/examples
```

### Step 2: Set Environment Variables (Optional but Recommended)

**Windows PowerShell:**
```powershell
$env:APARAVI_APIKEY = "YOUR_API_KEY"
$env:APARAVI_URI = "http://localhost:5565"
```

**Linux/Mac:**
```bash
export APARAVI_APIKEY=YOUR_API_KEY
export APARAVI_URI=http://localhost:5565
```

### Step 3: Run the Demo

```bash
# Using environment variables
python demo_store.py

# Or with command line arguments
python demo_store.py --apikey YOUR_KEY --uri http://localhost:5565
```

---

## Running `store_example_json.py` (Inline JSON Example)

```bash
cd packages/client-python/examples

# Edit the file to add your API key first, then run:
python store_example_json.py
```

---

## Alternative: Using Environment Variables

Instead of passing API key and URI on every command, set them once:

### Windows PowerShell Setup

```powershell
$env:APARAVI_APIKEY = "YOUR_API_KEY_HERE"
$env:APARAVI_URI = "http://localhost:5565"

# Now run tests
.\store_quick_test.ps1 $env:APARAVI_APIKEY
```

### Linux/Mac Setup

```bash
export APARAVI_APIKEY=YOUR_API_KEY_HERE
export APARAVI_URI=http://localhost:5565

# Now run tests
./store_quick_test.sh $APARAVI_APIKEY
```

---

## Troubleshooting Checklist

Before running any test, verify:

- [ ] **In examples directory?**
  ```cmd
  cd packages/client-python/examples
  ```

- [ ] **Server running?**
  ```cmd
  curl http://localhost:5565/health
  ```

- [ ] **Python installed?**
  ```cmd
  python --version
  # Should show Python 3.x.x
  ```

- [ ] **Have valid API key?**

- [ ] **CLI accessible?**
  ```cmd
  python run_cli.py --help
  # Should show CLI help
  ```

---

## Testing Individual Commands

You can also test individual `apaext_store` commands manually:

### Save Project (Create New)

```cmd
python run_cli.py apaext_store save_project ^
  --project-id my-test-project ^
  --project-json "{\"name\":\"Test\",\"source\":\"s1\",\"components\":[]}" ^
  --apikey YOUR_KEY ^
  --uri http://localhost:5565
```

### Get Project

```cmd
python run_cli.py apaext_store get_project ^
  --project-id my-test-project ^
  --apikey YOUR_KEY ^
  --uri http://localhost:5565
```

### Get All Projects

```cmd
python run_cli.py apaext_store get_all_projects ^
  --apikey YOUR_KEY ^
  --uri http://localhost:5565
```

### Delete Project

```cmd
python run_cli.py apaext_store delete_project ^
  --project-id my-test-project ^
  --apikey YOUR_KEY ^
  --uri http://localhost:5565
```

---

## Quick Start Checklist

**Complete these steps in order:**

1. ✅ Open terminal in examples directory: `packages/client-python/examples`
2. ✅ Verify server is running: `curl http://localhost:5565/health`
3. ✅ Get your API key from admin or set `APARAVI_APIKEY` environment variable
4. ✅ Run the test script:
   ```powershell
   .\store_quick_test.ps1 YOUR_API_KEY
   ```
5. ✅ Check output for "Test completed successfully!"

---

## Summary

### Correct Way to Run

```powershell
# 1. Navigate to examples directory
cd packages\client-python\examples

# 2. Run the PowerShell script with API key (default: deletes project after test)
.\store_quick_test.ps1 YOUR_API_KEY

# Or keep the project for inspection
.\store_quick_test.ps1 YOUR_API_KEY --nodelete

# That's it!
```

### What the Script Does

1. **Creates** a new project with inline JSON
2. **Fetches** the project to verify it was saved
3. **Lists** all projects (should include new project)
4. **Updates** the project with modified JSON
5. **Fetches** updated project to verify changes
6. **Lists** all projects again
7. **Deletes** the project - **UNLESS --nodelete specified**
8. **Verifies** deletion (if project was deleted)

All operations are **safe** and **atomic** thanks to the version control system!

### Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `YOUR_API_KEY` | ✅ Yes | - | API key for authentication |
| `SERVER_URI` | ❌ No | `http://localhost:5565` | Server URI |
| `--nodelete` | ❌ No | (deletes) | Keep test project instead of deleting |
