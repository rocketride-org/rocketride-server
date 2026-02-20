@ECHO OFF

for %%i in ("%~dp0..\..\..\..\vcpkg\installed\java") do set JAVA_ROOT=%%~fi
set "JAVA_HOME=%JAVA_ROOT%\jdk"
set "JAVA_MAVEN=%JAVA_ROOT%\maven\bin\mvn"

call %JAVA_MAVEN% clean compile assembly:single -q || exit /b
call %JAVA_MAVEN% test -q || exit /b 1
