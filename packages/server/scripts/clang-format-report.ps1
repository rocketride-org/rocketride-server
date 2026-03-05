# Run from repo root or packages/server. Reports C++ files that would be changed by clang-format.
# Looks for clang-format on PATH or under "C:\Program Files\LLVM\bin".
# Usage: .\scripts\clang-format-report.ps1  [optional: -Apply to fix in place]

param(
    [switch]$Apply  # If set, run clang-format -i on non-compliant files instead of just reporting
)

$ErrorActionPreference = "Stop"

# Find clang-format: PATH first, then LLVM install under Program Files
$clangFormat = Get-Command clang-format -ErrorAction SilentlyContinue
if (-not $clangFormat) {
    $llvmPath = "C:\Program Files\LLVM\bin\clang-format.exe"
    if (Test-Path $llvmPath) { $clangFormat = $llvmPath } else { $clangFormat = $null }
}
if (-not $clangFormat) {
    Write-Error "clang-format not found. Add it to PATH or install LLVM to C:\Program Files\LLVM (bin\clang-format.exe)."
}

# Script lives in packages/server/scripts; server root is parent (where .clang-format is)
$serverRoot = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $serverRoot ".clang-format"))) {
    Write-Error "Run from packages/server or ensure packages/server/scripts exists under server root. Missing .clang-format."
}

$files = Get-ChildItem -Path $serverRoot -Recurse -Include "*.cpp","*.hpp" -File |
    Where-Object { $_.FullName -notmatch "\\node_modules\\|\\\.git\\" }
$needFormat = @()
foreach ($f in $files) {
    $rel = $f.FullName.Substring($serverRoot.Length).TrimStart("\")
    $out = & $clangFormat --dry-run -Werror $f.FullName 2>&1
    if ($LASTEXITCODE -ne 0) { $needFormat += $rel }
}
if ($needFormat.Count -eq 0) {
    Write-Host "All $($files.Count) C++ files are formatted."
    exit 0
}
$n = $needFormat.Count
Write-Host "$n file(s) are not well formatted (of $($files.Count) checked)."
Write-Host "Files that need formatting:"
$needFormat | ForEach-Object { Write-Host "  $_" }
if ($Apply) {
    foreach ($rel in $needFormat) {
        $full = Join-Path $serverRoot $rel
        & $clangFormat -i $full
        Write-Host "Formatted: $rel"
    }
}
exit 1
