@set "DIR=%~dp0"
@set "DIR=%DIR:~0,-1%"
@node "%DIR%\scripts\build.js" "--overlay-root=%DIR%" %*
