#!/bin/bash
# Quick test script for apaext_store with --project-json and --template-json parameters (Linux/Mac)
#
# Prerequisites:
#   1. Server must be running (EaaS)
#   2. Valid API key required
#
# Usage (can be run from any directory):
#   ./store_quick_test.sh YOUR_API_KEY [SERVER_URI] [--nodelete]
#
# Arguments:
#   YOUR_API_KEY  - API key for authentication (required)
#   SERVER_URI    - Server URI (optional, default: http://localhost:5565)
#   --nodelete    - Keep the test project/template (don't delete at the end)
#
# Examples:
#   ./store_quick_test.sh MYAPIKEY123
#   ./store_quick_test.sh MYAPIKEY123 http://localhost:5565
#   ./store_quick_test.sh MYAPIKEY123 http://localhost:5565 --nodelete

set -e  # Exit on error

if [ -z "$1" ]; then
    echo "ERROR: API key is required"
    echo ""
    echo "Usage: $0 YOUR_API_KEY [SERVER_URI] [--nodelete]"
    echo ""
    echo "Arguments:"
    echo "  YOUR_API_KEY  - API key for authentication (required)"
    echo "  SERVER_URI    - Server URI (optional, default: http://localhost:5565)"
    echo "  --nodelete    - Keep the test project (don't delete at the end)"
    echo ""
    echo "Examples:"
    echo "  $0 MYAPIKEY123"
    echo "  $0 MYAPIKEY123 http://localhost:5565"
    echo "  $0 MYAPIKEY123 http://localhost:5565 --nodelete"
    exit 1
fi

APIKEY="$1"
URI="${2:-http://localhost:5565}"
DELETE_PROJECT=true

# Parse arguments
if [ "$2" == "--nodelete" ]; then
    URI="http://localhost:5565"
    DELETE_PROJECT=false
fi
if [ "$3" == "--nodelete" ]; then
    DELETE_PROJECT=false
fi

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_CLI_PATH="$SCRIPT_DIR/run_cli.py"

# Generate unique project ID
PROJECT_ID="test-proj-$(date +%s)"

echo "========================================="
echo "Testing apaext_store with inline JSON"
echo "========================================="
echo "Project ID: $PROJECT_ID"
echo "Server URI: $URI"
echo "Delete after test: $DELETE_PROJECT"
echo ""

# Define a simple pipeline as JSON (flat project format)
PIPELINE='{
  "name": "Test Pipeline",
  "description": "Testing inline JSON",
  "source": "source_1",
  "components": [
    {
      "id": "source_1",
      "provider": "filesystem",
      "config": {
        "mode": "Source",
        "name": "Test Source",
        "path": "/tmp/test"
      }
    }
  ]
}'

echo "Step 1: Save NEW project with --project-json (no version needed for new)"
echo "-------------------------------------------------------------------------"
python "$RUN_CLI_PATH" apaext_store save_project \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --project-id "$PROJECT_ID" \
  --project-json "$PIPELINE"

echo ""
echo "Step 2: Get the saved project"
echo "------------------------------"
python "$RUN_CLI_PATH" apaext_store get_project \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --project-id "$PROJECT_ID"

echo ""
echo "Step 3: Get all projects (should include our test project)"
echo "-----------------------------------------------------------"
python "$RUN_CLI_PATH" apaext_store get_all_projects \
  --apikey "$APIKEY" \
  --uri "$URI"

echo ""
echo "Step 4: Update project with modified JSON (version auto-fetched)"
echo "-----------------------------------------------------------------"
UPDATED_PIPELINE='{
  "name": "Test Pipeline (Updated)",
  "description": "Updated via inline JSON",
  "source": "source_1",
  "components": [
    {
      "id": "source_1",
      "provider": "filesystem",
      "config": {
        "mode": "Source",
        "name": "Test Source",
        "path": "/tmp/test"
      }
    },
    {
      "id": "source_2",
      "provider": "s3",
      "config": {
        "mode": "Source",
        "name": "S3 Source",
        "bucket": "test-bucket"
      }
    },
    {
      "id": "processor_1",
      "provider": "transform",
      "config": {
        "mode": "Not-a-source",
        "name": "Data Processor"
      }
    }
  ]
}'

python "$RUN_CLI_PATH" apaext_store save_project \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --project-id "$PROJECT_ID" \
  --project-json "$UPDATED_PIPELINE"

echo ""
echo "Step 5: Get project again to verify update (and capture version)"
echo "-------------------------------------------------------------------"
PROJECT_OUTPUT=$(python "$RUN_CLI_PATH" apaext_store get_project \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --project-id "$PROJECT_ID")

echo "$PROJECT_OUTPUT"

# Parse JSON to extract version for deletion
PROJECT_VERSION=$(echo "$PROJECT_OUTPUT" | python3 -c "import sys, json; data = json.load(sys.stdin); print(data.get('version', ''))" 2>/dev/null || echo "")
if [ -n "$PROJECT_VERSION" ]; then
    echo "Captured version for deletion: $PROJECT_VERSION"
fi

echo ""
echo "Step 6: Get all projects again (verify update appears in list)"
echo "---------------------------------------------------------------"
python "$RUN_CLI_PATH" apaext_store get_all_projects \
  --apikey "$APIKEY" \
  --uri "$URI"

# Check if we should delete the project
if [ "$DELETE_PROJECT" == "true" ]; then
    echo ""
    echo "Step 7: Delete the project (using captured version)"
    echo "-----------------------------------------------------"
    
    if [ -z "$PROJECT_VERSION" ]; then
        echo "ERROR: No version captured from previous step, cannot delete safely"
        exit 1
    fi
    
    python "$RUN_CLI_PATH" apaext_store delete_project \
      --apikey "$APIKEY" \
      --uri "$URI" \
      --project-id "$PROJECT_ID" \
      --expected-version "$PROJECT_VERSION"

    echo ""
    echo "Step 8: Verify deletion (should get \"not found\" error)"
    echo "-------------------------------------------------------"
    python "$RUN_CLI_PATH" apaext_store get_project \
      --apikey "$APIKEY" \
      --uri "$URI" \
      --project-id "$PROJECT_ID" || true
    echo "(Expected: NOT_FOUND error - this is correct!)"
else
    echo ""
    echo "Step 7: Skipping deletion (--nodelete flag specified)"
    echo "-----------------------------------------------------"
    echo "Project $PROJECT_ID was kept for manual inspection"
    if [ -n "$PROJECT_VERSION" ]; then
        echo "Project version: $PROJECT_VERSION"
        echo ""
        echo "To delete it manually, run:"
        echo "  python \"$RUN_CLI_PATH\" apaext_store delete_project --apikey $APIKEY --uri $URI --project-id $PROJECT_ID --expected-version $PROJECT_VERSION"
    else
        echo ""
        echo "To delete it manually:"
        echo "  # First get the project to obtain the version:"
        echo "  python \"$RUN_CLI_PATH\" apaext_store get_project --apikey $APIKEY --uri $URI --project-id $PROJECT_ID"
        echo "  # Then delete with the version from the output"
    fi
fi

echo ""
echo "========================================="
echo "Testing apaext_store TEMPLATES"
echo "========================================="

# Generate unique template ID
TEMPLATE_ID="test-tmpl-$(date +%s)"
echo "Template ID: $TEMPLATE_ID"
echo ""

# Define a simple template as JSON (flat project format)
TEMPLATE='{
  "name": "Test Template",
  "description": "Testing template inline JSON",
  "source": "source_1",
  "components": [
    {
      "id": "source_1",
      "provider": "filesystem",
      "config": {
        "mode": "Source",
        "name": "Template Source",
        "path": "/tmp/template"
      }
    }
  ]
}'

echo "Step T1: Save NEW template with --template-json"
echo "------------------------------------------------"
python "$RUN_CLI_PATH" apaext_store save_template \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --template-id "$TEMPLATE_ID" \
  --template-json "$TEMPLATE"

echo ""
echo "Step T2: Get the saved template"
echo "--------------------------------"
python "$RUN_CLI_PATH" apaext_store get_template \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --template-id "$TEMPLATE_ID"

echo ""
echo "Step T3: Get all templates (should include our test template)"
echo "--------------------------------------------------------------"
python "$RUN_CLI_PATH" apaext_store get_all_templates \
  --apikey "$APIKEY" \
  --uri "$URI"

echo ""
echo "Step T4: Update template with modified JSON"
echo "---------------------------------------------"
UPDATED_TEMPLATE='{
  "name": "Test Template (Updated)",
  "description": "Updated via inline JSON",
  "source": "source_1",
  "components": [
    {
      "id": "source_1",
      "provider": "filesystem",
      "config": {
        "mode": "Source",
        "name": "Template Source",
        "path": "/tmp/template"
      }
    },
    {
      "id": "source_2",
      "provider": "s3",
      "config": {
        "mode": "Source",
        "name": "S3 Template Source",
        "bucket": "template-bucket"
      }
    }
  ]
}'

python "$RUN_CLI_PATH" apaext_store save_template \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --template-id "$TEMPLATE_ID" \
  --template-json "$UPDATED_TEMPLATE"

echo ""
echo "Step T5: Get template again to verify update (and capture version)"
echo "--------------------------------------------------------------------"
TEMPLATE_OUTPUT=$(python "$RUN_CLI_PATH" apaext_store get_template \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --template-id "$TEMPLATE_ID")

echo "$TEMPLATE_OUTPUT"

# Parse JSON to extract version for deletion
TEMPLATE_VERSION=$(echo "$TEMPLATE_OUTPUT" | python3 -c "import sys, json; data = json.load(sys.stdin); print(data.get('version', ''))" 2>/dev/null || echo "")
if [ -n "$TEMPLATE_VERSION" ]; then
    echo "Captured version for deletion: $TEMPLATE_VERSION"
fi

# Check if we should delete the template
if [ "$DELETE_PROJECT" == "true" ]; then
    echo ""
    echo "Step T6: Delete the template (using captured version)"
    echo "-------------------------------------------------------"
    
    if [ -z "$TEMPLATE_VERSION" ]; then
        echo "ERROR: No version captured from previous step, cannot delete safely"
        exit 1
    fi
    
    python "$RUN_CLI_PATH" apaext_store delete_template \
      --apikey "$APIKEY" \
      --uri "$URI" \
      --template-id "$TEMPLATE_ID" \
      --expected-version "$TEMPLATE_VERSION"

    echo ""
    echo "Step T7: Verify deletion (should get \"not found\" error)"
    echo "---------------------------------------------------------"
    python "$RUN_CLI_PATH" apaext_store get_template \
      --apikey "$APIKEY" \
      --uri "$URI" \
      --template-id "$TEMPLATE_ID" || true
    echo "(Expected: NOT_FOUND error - this is correct!)"
else
    echo ""
    echo "Step T6: Skipping template deletion (--nodelete flag specified)"
    echo "----------------------------------------------------------------"
    echo "Template $TEMPLATE_ID was kept for manual inspection"
fi

echo ""
echo "========================================="
echo "Testing apaext_store LOGS"
echo "========================================="

# Use the first project ID for log tests
LOG_PROJECT_ID="$PROJECT_ID"
echo "Using Project ID for logs: $LOG_PROJECT_ID"
echo ""

# Define log contents with startTime
START_TIME1=$(date +%s)
LOG_CONTENTS1="{\"type\":\"event\",\"seq\":1,\"event\":\"apaevt_status_update\",\"body\":{\"name\":\"source_1\",\"project_id\":\"$LOG_PROJECT_ID\",\"source\":\"source_1\",\"completed\":true,\"state\":5,\"startTime\":${START_TIME1}.123,\"endTime\":$((START_TIME1 + 90)).456,\"status\":\"Completed\",\"totalCount\":15,\"completedCount\":15,\"failedCount\":0,\"errors\":[],\"warnings\":[]}}"

echo "Step L1: Save a log file"
echo "-------------------------"
python "$RUN_CLI_PATH" apaext_store save_log \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --project-id "$LOG_PROJECT_ID" \
  --source "source_1" \
  --contents-json "$LOG_CONTENTS1"

echo ""
echo "Step L2: Save another log (different start time)"
echo "-------------------------------------------------"
START_TIME2=$((START_TIME1 + 1000))
LOG_CONTENTS2="{\"type\":\"event\",\"seq\":2,\"event\":\"apaevt_status_update\",\"body\":{\"name\":\"source_1\",\"project_id\":\"$LOG_PROJECT_ID\",\"source\":\"source_1\",\"completed\":false,\"state\":3,\"startTime\":${START_TIME2}.0,\"status\":\"Running\",\"totalCount\":100,\"completedCount\":50,\"failedCount\":0,\"errors\":[],\"warnings\":[]}}"

python "$RUN_CLI_PATH" apaext_store save_log \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --project-id "$LOG_PROJECT_ID" \
  --source "source_1" \
  --contents-json "$LOG_CONTENTS2"

echo ""
echo "Step L3: Save log for different source"
echo "---------------------------------------"
START_TIME3=$((START_TIME1 + 2000))
LOG_CONTENTS3="{\"type\":\"event\",\"seq\":3,\"event\":\"apaevt_status_update\",\"body\":{\"name\":\"source_2\",\"project_id\":\"$LOG_PROJECT_ID\",\"source\":\"source_2\",\"completed\":true,\"state\":5,\"startTime\":${START_TIME3}.0,\"endTime\":$((START_TIME3 + 60)).0,\"status\":\"Completed\",\"totalCount\":50,\"completedCount\":50,\"failedCount\":0,\"errors\":[],\"warnings\":[]}}"

python "$RUN_CLI_PATH" apaext_store save_log \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --project-id "$LOG_PROJECT_ID" \
  --source "source_2" \
  --contents-json "$LOG_CONTENTS3"

echo ""
echo "Step L4: List all logs for project"
echo "-----------------------------------"
python "$RUN_CLI_PATH" apaext_store list_logs \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --project-id "$LOG_PROJECT_ID"

echo ""
echo "Step L5: List logs filtered by source"
echo "--------------------------------------"
python "$RUN_CLI_PATH" apaext_store list_logs \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --project-id "$LOG_PROJECT_ID" \
  --source "source_1"

echo ""
echo "Step L6: Get a specific log"
echo "----------------------------"
python "$RUN_CLI_PATH" apaext_store get_log \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --project-id "$LOG_PROJECT_ID" \
  --source "source_1" \
  --start-time "${START_TIME1}.123"

echo ""
echo "Step L7: Try to get non-existent log (should fail)"
echo "---------------------------------------------------"
python "$RUN_CLI_PATH" apaext_store get_log \
  --apikey "$APIKEY" \
  --uri "$URI" \
  --project-id "$LOG_PROJECT_ID" \
  --source "source_1" \
  --start-time "9999999999.0" || true
echo "(Expected: NOT_FOUND error - this is correct!)"

echo ""
echo "========================================="
echo "Test completed successfully!"
echo "========================================="
if [ "$DELETE_PROJECT" == "false" ]; then
    echo ""
    echo "NOTE: Test project \"$PROJECT_ID\" was NOT deleted"
    echo "      Test template \"$TEMPLATE_ID\" was NOT deleted"
    echo "      Use 'get_all_projects' and 'get_all_templates' to see them in the list"
fi

exit 0
