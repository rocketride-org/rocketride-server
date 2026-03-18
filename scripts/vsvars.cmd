@echo off
REM =============================================================================
REM RocketRide Engine - Visual Studio Build Environment (Windows)
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
  call :vsvars
  exit /b
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

:vsvars
set VSWHERE="%ProgramFiles(x86)%\\Microsoft Visual Studio\\Installer\\vswhere.exe"
if not exist %VSWHERE% (
  echo Visual Studio Installer not found
  exit /b 1
)

call :vswhere -version 16.7 -property installationPath && exit /b

call :vswhere -products Microsoft.VisualStudio.Product.BuildTools -version 16.7 -property installationPath && exit /b

echo Visual Studio 2019 not found
exit /b 1


:vswhere
for /f "usebackq delims=" %%i in (`%VSWHERE% %*`) do (
  set "VSROOT=%%i"
)

if "%VSROOT%" == "" (
  exit /b 1
)

echo Using "%VSROOT%"
call "%VSROOT%\VC\Auxiliary\Build\vcvarsall.bat" amd64
exit /b
