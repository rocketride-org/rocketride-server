@echo off
setlocal

set "EXTRA_ARGS="
if defined CI (
  set "HAS_TEST="
  set "HAS_SEQUENTIAL="
  for %%A in (%*) do (
    if "%%~A"=="test" set "HAS_TEST=1"
    if "%%~A"=="--sequential" set "HAS_SEQUENTIAL=1"
    if "%%~A"=="-s" set "HAS_SEQUENTIAL=1"
  )
  if defined HAS_TEST if not defined HAS_SEQUENTIAL set "EXTRA_ARGS=--sequential"
)

node "%~dp0scripts/build.js" %* %EXTRA_ARGS%
