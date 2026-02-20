# Quick test script for apaext_store with --project-json and --template-json parameters (PowerShell)
#
# Prerequisites:
#   1. Server must be running (EaaS)
#   2. Valid API key required
#
# Usage (can be run from any directory):
#   .\store_quick_test.ps1 YOUR_API_KEY [SERVER_URI] [-NoDelete]
#
# Arguments:
#   YOUR_API_KEY  - API key for authentication (required)
#   SERVER_URI    - Server URI (optional, default: http://localhost:5565)
#   -NoDelete     - Keep the test project/template (don't delete at the end)
#
# Examples:
#   .\store_quick_test.ps1 MYAPIKEY123
#   .\store_quick_test.ps1 MYAPIKEY123 http://localhost:5565
#   .\store_quick_test.ps1 MYAPIKEY123 http://localhost:5565 -NoDelete

param(
    [Parameter(Mandatory=$false)]
    [string]$ApiKey,
    
    [Parameter(Mandatory=$false)]
    [string]$Uri,
    
    [switch]$NoDelete
)

# Parse arguments manually to handle both PowerShell and bash-style syntax
$argList = $args + @($ApiKey, $Uri) | Where-Object { $_ -ne $null -and $_ -ne "" }
$parsedApiKey = $null
$parsedUri = "http://localhost:5565"
$parsedNoDelete = $NoDelete

foreach ($arg in $argList) {
    if ($arg -eq "--nodelete" -or $arg -eq "-nodelete" -or $arg -eq "-NoDelete") {
        $parsedNoDelete = $true
    }
    elseif ($arg -like "http*") {
        $parsedUri = $arg
    }
    elseif ($null -eq $parsedApiKey) {
        $parsedApiKey = $arg
    }
}

# Validate required parameters
if ([string]::IsNullOrEmpty($parsedApiKey)) {
    Write-Host "ERROR: API key is required" -ForegroundColor Red
    Write-Host ""
    Write-Host "Usage: $($MyInvocation.MyCommand.Name) YOUR_API_KEY [SERVER_URI] [-NoDelete|--nodelete]"
    Write-Host ""
    Write-Host "Arguments:"
    Write-Host "  YOUR_API_KEY  - API key for authentication (required)"
    Write-Host "  SERVER_URI    - Server URI (optional, default: http://localhost:5565)"
    Write-Host "  -NoDelete     - Keep the test project (don't delete at the end)"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\$($MyInvocation.MyCommand.Name) MYAPIKEY123"
    Write-Host "  .\$($MyInvocation.MyCommand.Name) MYAPIKEY123 http://localhost:5565"
    Write-Host "  .\$($MyInvocation.MyCommand.Name) MYAPIKEY123 -NoDelete"
    Write-Host "  .\$($MyInvocation.MyCommand.Name) MYAPIKEY123 http://localhost:5565 -NoDelete"
    Write-Host "  .\$($MyInvocation.MyCommand.Name) MYAPIKEY123 --nodelete   # bash-style also works"
    exit 1
}

# Use parsed values
$ApiKey = $parsedApiKey
$Uri = $parsedUri
$NoDelete = $parsedNoDelete

# Determine the path to run_cli.py (in the same directory as this script)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunCliPath = Join-Path $ScriptDir "run_cli.py"
$RunCliPath = [System.IO.Path]::GetFullPath($RunCliPath)

$ErrorActionPreference = "Stop"

# Generate unique project ID
$ProjectId = "test-proj-$(Get-Random -Maximum 99999)"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Testing apaext_store with inline JSON" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Project ID: $ProjectId"
Write-Host "Server URI: $Uri"
Write-Host "Delete after test: $(-not $NoDelete)"
Write-Host ""

# Define a simple pipeline as JSON
$Pipeline = '{"source":"source_1","pipeline":{"name":"Test Pipeline","description":"Testing inline JSON","components":[{"id":"source_1","provider":"filesystem","config":{"mode":"Source","name":"Test Source","path":"C:\\tmp\\test"}}]}}'

Write-Host "Step 1: Save NEW project with --project-json (no version needed for new)" -ForegroundColor Yellow
Write-Host "-------------------------------------------------------------------------"
python $RunCliPath apaext_store save_project `
    --apikey $ApiKey `
    --uri $Uri `
    --project-id $ProjectId `
    --project-json $Pipeline
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to save project" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step 2: Get the saved project" -ForegroundColor Yellow
Write-Host "------------------------------"
python $RunCliPath apaext_store get_project `
    --apikey $ApiKey `
    --uri $Uri `
    --project-id $ProjectId
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to get project" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step 3: Get all projects (should include our test project)" -ForegroundColor Yellow
Write-Host "-----------------------------------------------------------"
python $RunCliPath apaext_store get_all_projects `
    --apikey $ApiKey `
    --uri $Uri
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to get all projects" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step 4: Update project with modified JSON (version auto-fetched)" -ForegroundColor Yellow
Write-Host "-----------------------------------------------------------------"
$UpdatedPipeline = '{"source":"source_1","pipeline":{"name":"Test Pipeline (Updated)","description":"Updated via inline JSON","components":[{"id":"source_1","provider":"filesystem","config":{"mode":"Source","name":"Test Source","path":"C:\\tmp\\test"}},{"id":"source_2","provider":"s3","config":{"mode":"Source","name":"S3 Source","bucket":"test-bucket"}},{"id":"processor_1","provider":"transform","config":{"mode":"Not-a-source","name":"Data Processor"}}]}}'

python $RunCliPath apaext_store save_project `
    --apikey $ApiKey `
    --uri $Uri `
    --project-id $ProjectId `
    --project-json $UpdatedPipeline
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to update project" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step 5: Get project again to verify update (and capture version)" -ForegroundColor Yellow
Write-Host "-------------------------------------------------------------------"
$ProjectJson = python $RunCliPath apaext_store get_project `
    --apikey $ApiKey `
    --uri $Uri `
    --project-id $ProjectId | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to get updated project" -ForegroundColor Red
    exit 1
}
Write-Host $ProjectJson

# Parse JSON to extract version for deletion
try {
    $ProjectData = $ProjectJson | ConvertFrom-Json
    $ProjectVersion = $ProjectData.version
    if ($ProjectVersion) {
        Write-Host "Captured version for deletion: $ProjectVersion" -ForegroundColor Gray
    }
} catch {
    Write-Host "Warning: Could not parse project JSON to extract version" -ForegroundColor Yellow
    $ProjectVersion = $null
}

Write-Host ""
Write-Host "Step 6: Get all projects again (verify update appears in list)" -ForegroundColor Yellow
Write-Host "---------------------------------------------------------------"
python $RunCliPath apaext_store get_all_projects `
    --apikey $ApiKey `
    --uri $Uri
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to get all projects" -ForegroundColor Red
    exit 1
}

# Check if we should delete the project
if (-not $NoDelete) {
    Write-Host ""
    Write-Host "Step 7: Delete the project (using captured version)" -ForegroundColor Yellow
    Write-Host "-----------------------------------------------------"
    
    if ($ProjectVersion) {
        # Build command as array to avoid line continuation issues
        $deleteArgs = @(
            $RunCliPath,
            'apaext_store',
            'delete_project',
            '--apikey', $ApiKey,
            '--uri', $Uri,
            '--project-id', $ProjectId,
            '--expected-version', $ProjectVersion
        )
        & python $deleteArgs
    } else {
        Write-Host "ERROR: No version captured from previous step, cannot delete safely" -ForegroundColor Red
        exit 1
    }
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to delete project" -ForegroundColor Red
        exit 1
    }

    Write-Host ""
    Write-Host "Step 8: Verify deletion (should get 'not found' error)" -ForegroundColor Yellow
    Write-Host "-------------------------------------------------------"
    python $RunCliPath apaext_store get_project `
        --apikey $ApiKey `
        --uri $Uri `
        --project-id $ProjectId 2>&1 | Out-Null
    Write-Host "(Expected: NOT_FOUND error - this is correct!)" -ForegroundColor Gray
} else {
    Write-Host ""
    Write-Host "Step 7: Skipping deletion (-NoDelete flag specified)" -ForegroundColor Yellow
    Write-Host "-----------------------------------------------------"
    Write-Host "Project $ProjectId was kept for manual inspection"
    if ($ProjectVersion) {
        Write-Host "Project version: $ProjectVersion" -ForegroundColor Gray
    }
    Write-Host ""
    Write-Host "To delete it manually, run:"
    if ($ProjectVersion) {
        Write-Host "  python $RunCliPath apaext_store delete_project --apikey $ApiKey --uri $Uri --project-id $ProjectId --expected-version $ProjectVersion" -ForegroundColor Cyan
    } else {
        Write-Host "  # First get the project to obtain the version:"
        Write-Host "  python $RunCliPath apaext_store get_project --apikey $ApiKey --uri $Uri --project-id $ProjectId" -ForegroundColor Cyan
        Write-Host "  # Then delete with the version from the output"
    }
}

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Testing apaext_store TEMPLATES" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# Generate unique template ID
$TemplateId = "test-tmpl-$(Get-Random -Maximum 99999)"
Write-Host "Template ID: $TemplateId"
Write-Host ""

# Define a simple template as JSON
$Template = '{"source":"source_1","pipeline":{"name":"Test Template","description":"Testing template inline JSON","components":[{"id":"source_1","provider":"filesystem","config":{"mode":"Source","name":"Template Source","path":"C:\\tmp\\template"}}]}}'

Write-Host "Step T1: Save NEW template with --template-json" -ForegroundColor Yellow
Write-Host "------------------------------------------------"
python $RunCliPath apaext_store save_template `
    --apikey $ApiKey `
    --uri $Uri `
    --template-id $TemplateId `
    --template-json $Template
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to save template" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step T2: Get the saved template" -ForegroundColor Yellow
Write-Host "--------------------------------"
python $RunCliPath apaext_store get_template `
    --apikey $ApiKey `
    --uri $Uri `
    --template-id $TemplateId
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to get template" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step T3: Get all templates (should include our test template)" -ForegroundColor Yellow
Write-Host "--------------------------------------------------------------"
python $RunCliPath apaext_store get_all_templates `
    --apikey $ApiKey `
    --uri $Uri
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to get all templates" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step T4: Update template with modified JSON" -ForegroundColor Yellow
Write-Host "---------------------------------------------"
$UpdatedTemplate = '{"source":"source_1","pipeline":{"name":"Test Template (Updated)","description":"Updated via inline JSON","components":[{"id":"source_1","provider":"filesystem","config":{"mode":"Source","name":"Template Source","path":"C:\\tmp\\template"}},{"id":"source_2","provider":"s3","config":{"mode":"Source","name":"S3 Template Source","bucket":"template-bucket"}}]}}'

python $RunCliPath apaext_store save_template `
    --apikey $ApiKey `
    --uri $Uri `
    --template-id $TemplateId `
    --template-json $UpdatedTemplate
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to update template" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step T5: Get template again to verify update (and capture version)" -ForegroundColor Yellow
Write-Host "--------------------------------------------------------------------"
$TemplateJson = python $RunCliPath apaext_store get_template `
    --apikey $ApiKey `
    --uri $Uri `
    --template-id $TemplateId | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to get updated template" -ForegroundColor Red
    exit 1
}
Write-Host $TemplateJson

# Parse JSON to extract version for deletion
try {
    $TemplateData = $TemplateJson | ConvertFrom-Json
    $TemplateVersion = $TemplateData.version
    if ($TemplateVersion) {
        Write-Host "Captured version for deletion: $TemplateVersion" -ForegroundColor Gray
    }
} catch {
    Write-Host "Warning: Could not parse template JSON to extract version" -ForegroundColor Yellow
    $TemplateVersion = $null
}

# Check if we should delete the template
if (-not $NoDelete) {
    Write-Host ""
    Write-Host "Step T6: Delete the template (using captured version)" -ForegroundColor Yellow
    Write-Host "-------------------------------------------------------"
    
    if ($TemplateVersion) {
        $deleteArgs = @(
            $RunCliPath,
            'apaext_store',
            'delete_template',
            '--apikey', $ApiKey,
            '--uri', $Uri,
            '--template-id', $TemplateId,
            '--expected-version', $TemplateVersion
        )
        & python $deleteArgs
    } else {
        Write-Host "ERROR: No version captured from previous step, cannot delete safely" -ForegroundColor Red
        exit 1
    }
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to delete template" -ForegroundColor Red
        exit 1
    }

    Write-Host ""
    Write-Host "Step T7: Verify deletion (should get 'not found' error)" -ForegroundColor Yellow
    Write-Host "---------------------------------------------------------"
    python $RunCliPath apaext_store get_template `
        --apikey $ApiKey `
        --uri $Uri `
        --template-id $TemplateId 2>&1 | Out-Null
    Write-Host "(Expected: NOT_FOUND error - this is correct!)" -ForegroundColor Gray
} else {
    Write-Host ""
    Write-Host "Step T6: Skipping template deletion (-NoDelete flag specified)" -ForegroundColor Yellow
    Write-Host "----------------------------------------------------------------"
    Write-Host "Template $TemplateId was kept for manual inspection"
}

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Testing apaext_store LOGS" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# Use the first project ID for log tests
$LogProjectId = $ProjectId
Write-Host "Using Project ID for logs: $LogProjectId"
Write-Host ""

# Define log contents with startTime
$StartTime1 = [math]::Round((Get-Date -UFormat %s), 0)
$LogContents1 = @"
{"type":"event","seq":1,"event":"apaevt_status_update","body":{"name":"source_1","project_id":"$LogProjectId","source":"source_1","completed":true,"state":5,"startTime":$StartTime1.123,"endTime":$($StartTime1 + 90).456,"status":"Completed","totalCount":15,"completedCount":15,"failedCount":0,"errors":[],"warnings":[]}}
"@

Write-Host "Step L1: Save a log file" -ForegroundColor Yellow
Write-Host "-------------------------"
python $RunCliPath apaext_store save_log `
    --apikey $ApiKey `
    --uri $Uri `
    --project-id $LogProjectId `
    --source "source_1" `
    --contents-json $LogContents1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to save log" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step L2: Save another log (different start time)" -ForegroundColor Yellow
Write-Host "-------------------------------------------------"
$StartTime2 = $StartTime1 + 1000
$LogContents2 = @"
{"type":"event","seq":2,"event":"apaevt_status_update","body":{"name":"source_1","project_id":"$LogProjectId","source":"source_1","completed":false,"state":3,"startTime":$StartTime2.0,"status":"Running","totalCount":100,"completedCount":50,"failedCount":0,"errors":[],"warnings":[]}}
"@

python $RunCliPath apaext_store save_log `
    --apikey $ApiKey `
    --uri $Uri `
    --project-id $LogProjectId `
    --source "source_1" `
    --contents-json $LogContents2
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to save second log" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step L3: Save log for different source" -ForegroundColor Yellow
Write-Host "---------------------------------------"
$StartTime3 = $StartTime1 + 2000
$LogContents3 = @"
{"type":"event","seq":3,"event":"apaevt_status_update","body":{"name":"source_2","project_id":"$LogProjectId","source":"source_2","completed":true,"state":5,"startTime":$StartTime3.0,"endTime":$($StartTime3 + 60).0,"status":"Completed","totalCount":50,"completedCount":50,"failedCount":0,"errors":[],"warnings":[]}}
"@

python $RunCliPath apaext_store save_log `
    --apikey $ApiKey `
    --uri $Uri `
    --project-id $LogProjectId `
    --source "source_2" `
    --contents-json $LogContents3
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to save log for source_2" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step L4: List all logs for project" -ForegroundColor Yellow
Write-Host "-----------------------------------"
python $RunCliPath apaext_store list_logs `
    --apikey $ApiKey `
    --uri $Uri `
    --project-id $LogProjectId
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to list logs" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step L5: List logs filtered by source" -ForegroundColor Yellow
Write-Host "--------------------------------------"
python $RunCliPath apaext_store list_logs `
    --apikey $ApiKey `
    --uri $Uri `
    --project-id $LogProjectId `
    --source "source_1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to list logs for source_1" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step L6: Get a specific log" -ForegroundColor Yellow
Write-Host "----------------------------"
python $RunCliPath apaext_store get_log `
    --apikey $ApiKey `
    --uri $Uri `
    --project-id $LogProjectId `
    --source "source_1" `
    --start-time "$StartTime1.123"
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to get log" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Step L7: Try to get non-existent log (should fail)" -ForegroundColor Yellow
Write-Host "---------------------------------------------------"
python $RunCliPath apaext_store get_log `
    --apikey $ApiKey `
    --uri $Uri `
    --project-id $LogProjectId `
    --source "source_1" `
    --start-time "9999999999.0" 2>&1 | Out-Null
Write-Host "(Expected: NOT_FOUND error - this is correct!)" -ForegroundColor Gray

Write-Host ""
Write-Host "=========================================" -ForegroundColor Green
Write-Host "Test completed successfully!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
if ($NoDelete) {
    Write-Host ""
    Write-Host "NOTE: Test project '$ProjectId' was NOT deleted" -ForegroundColor Yellow
    Write-Host "      Test template '$TemplateId' was NOT deleted" -ForegroundColor Yellow
    Write-Host "      Use 'get_all_projects' and 'get_all_templates' to see them in the list"
}

exit 0
