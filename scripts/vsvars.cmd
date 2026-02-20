@echo off
REM =============================================================================
REM Aparavi Engine - Visual Studio Build Environment (Windows)
REM =============================================================================
REM Expects the VS installation path as the first argument (found by the caller
REM via vswhere). Sets up the build environment by calling vcvars64 or VsDevCmd.
REM
REM Usage: vsvars.cmd "C:\Path\To\Visual Studio"
REM =============================================================================

if defined VSINSTALLDIR (
  set
  exit /b 0
)

if "%~1"=="" (
  echo vsvars.cmd: missing VS installation path
  exit /b 1
)

set "VSROOT=%~1"

set "VCVARS=%VSROOT%\VC\Auxiliary\Build\vcvars64.bat"
if exist "%VCVARS%" (
  call "%VCVARS%"
  set
  exit /b 0
)

set "VSDEVCMD=%VSROOT%\Common7\Tools\VsDevCmd.bat"
if exist "%VSDEVCMD%" (
  call "%VSDEVCMD%" -arch=amd64
  set
  exit /b 0
)

echo No vcvars64.bat or VsDevCmd.bat found under: %VSROOT%
exit /b 1
