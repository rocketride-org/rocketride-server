call builder vscode:clean vscode:build
call code --uninstall-extension rocketride.rocketride
call code --install-extension dist\vscode\rocketride-0.0.1.vsix
