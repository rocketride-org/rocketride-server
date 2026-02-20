# apaext_store Command Examples

## Quick Reference

### Correct Command Syntax

```bash
# Using run_cli.py (from examples directory)
python run_cli.py apaext_store SUBCOMMAND [OPTIONS]

# Using python module directly (if rocketride-client-python is installed)
python -m rocketride.cli.main apaext_store SUBCOMMAND [OPTIONS]

# After installation
rocketride apaext_store SUBCOMMAND [OPTIONS]
```

## Save Project Examples

### Using --project-file

**Correct:**
```bash
python run_cli.py apaext_store save_project \
  --project-id project-1 \
  --project-file path/to/pipeline.json \
  --apikey MYAPIKEY \
  --uri http://localhost:5565
```

**Note:** Common args (`--apikey`, `--uri`, `--token`) can appear **before or after** the subcommand!

### Using --project-json (Inline)

**Compact (no spaces in values):**
```bash
python run_cli.py apaext_store save_project \
  --project-id project-1 \
  --project-json "{\"source\":\"source_1\",\"pipeline\":{\"name\":\"TestPipeline\",\"components\":[{\"id\":\"source_1\",\"provider\":\"filesystem\",\"config\":{\"mode\":\"Source\",\"path\":\"/tmp\"}}]}}" \
  --apikey MYAPIKEY \
  --uri http://localhost:5565
```

**From PowerShell:**
```powershell
$pipeline = '{"source":"source_1","pipeline":{"name":"TestPipeline","components":[{"id":"source_1","provider":"filesystem","config":{"mode":"Source","path":"/tmp"}}]}}'

python run_cli.py apaext_store save_project `
  --project-id project-1 `
  --project-json $pipeline `
  --apikey MYAPIKEY `
  --uri http://localhost:5565
```

### Using Environment Variables

**Set once:**
```cmd
set APARAVI_APIKEY=MYAPIKEY
set APARAVI_URI=http://localhost:5565
```

**Then run without flags:**
```bash
python run_cli.py apaext_store save_project \
  --project-id project-1 \
  --project-file pipeline.json
```

## Get Project

```bash
python run_cli.py apaext_store get_project \
  --project-id project-1 \
  --apikey MYAPIKEY \
  --uri http://localhost:5565
```

## Delete Project

```bash
# Simple delete
python run_cli.py apaext_store delete_project \
  --project-id project-1 \
  --apikey MYAPIKEY \
  --uri http://localhost:5565

# With version check
python run_cli.py apaext_store delete_project \
  --project-id project-1 \
  --expected-version abc123def456 \
  --apikey MYAPIKEY \
  --uri http://localhost:5565
```

## Get All Projects

```bash
python run_cli.py apaext_store get_all_projects \
  --apikey MYAPIKEY \
  --uri http://localhost:5565
```

## Log Commands

### Save Log

```bash
python run_cli.py apaext_store save_log \
  --project-id project-1 \
  --source source_1 \
  --contents-json '{"type":"event","body":{"startTime":1234567890,"status":"Completed"}}' \
  --apikey MYAPIKEY \
  --uri http://localhost:5565
```

### Get Log

```bash
python run_cli.py apaext_store get_log \
  --project-id project-1 \
  --source source_1 \
  --start-time 1234567890 \
  --apikey MYAPIKEY \
  --uri http://localhost:5565
```

### List Logs

```bash
python run_cli.py apaext_store list_logs \
  --project-id project-1 \
  --apikey MYAPIKEY \
  --uri http://localhost:5565

# Filter by source
python run_cli.py apaext_store list_logs \
  --project-id project-1 \
  --source source_1 \
  --apikey MYAPIKEY \
  --uri http://localhost:5565
```

## Common Errors

### Error: "Expecting value: line 1 column 1 (char 0)"

**Causes:**
1. Pipeline file is empty
2. Pipeline JSON string is empty
3. Server returned empty response
4. File path is incorrect

**Solutions:**
```bash
# Check file exists and has content
cat pipeline.json

# Validate JSON
python -m json.tool < pipeline.json
```

### Error: "unrecognized arguments: --apikey"

**Cause:** Arguments appear in wrong order for subparser

**Solution:** Put common args (--apikey, --uri, --token) anywhere:
```bash
# Option 1: Before subcommand
apaext_store --apikey KEY save_project --project-id proj-1 --project-file x.json

# Option 2: After subcommand (more natural)
apaext_store save_project --project-id proj-1 --project-file x.json --apikey KEY
```

### Error: "Either --project-file or --project-json is required"

**Cause:** Neither argument provided

**Solution:**
```bash
# Provide one:
--project-file pipeline.json
# OR
--project-json '{"source":"s1","pipeline":{"name":"Test","components":[...]}}'
```

### Error: "Pipeline data cannot be empty"

**Cause:** File contains `{}` or `[]` or is empty

**Solution:** Ensure valid pipeline structure:
```json
{
  "source": "source_1",
  "pipeline": {
    "name": "Pipeline Name",
    "components": [
      {
        "id": "source_1",
        "provider": "filesystem",
        "config": {
          "mode": "Source",
          "path": "/data"
        }
      }
    ]
  }
}
```

### Error: "Server is not connected"

**Cause:** Server is not running or unreachable

**Solution:** Start the server first:
```bash
# Check server health
curl http://localhost:5565/health
```

## Testing Commands

### Test with Minimal Pipeline

```bash
# Create minimal test file
echo '{"source":"s1","pipeline":{"name":"MinimalTest","components":[{"id":"s1","provider":"filesystem","config":{"mode":"Source","path":"/tmp"}}]}}' > test-min.json

# Save it
python run_cli.py apaext_store save_project --project-id test-min --project-file test-min.json --apikey MYAPIKEY --uri http://localhost:5565
```

### Test with Environment Variables

```cmd
REM Set environment
set APARAVI_APIKEY=MYAPIKEY
set APARAVI_URI=http://localhost:5565

REM Run command (cleaner!)
python run_cli.py apaext_store save_project ^
  --project-id project-1 ^
  --project-file pipeline.json
```

## Debug Tips

1. **Validate your JSON file:**
   ```bash
   python -m json.tool < pipeline.json
   ```

2. **Check file exists:**
   ```bash
   ls -la pipeline.json
   ```

3. **Test with simple inline JSON:**
   ```bash
   --project-json '{"source":"s1","pipeline":{"name":"Test","components":[]}}'
   ```

4. **Verify server is running:**
   ```bash
   curl http://localhost:5565/health
   ```

## Summary

- ✅ Common args can be anywhere in the command
- ✅ Better error messages show exactly what failed
- ✅ Validates file/JSON before sending to server
- ✅ Auto-connects to server if not connected
- ✅ Supports both file and inline JSON
- ✅ Environment variables work for all common args
