# Debugging Python components

## Debugging using the full engine project

> The ${workspace}/.vscode directory contains launch.template.json that contains the latest updates for 
debugging in various components

## Debug support
The python bindings for the engine now support a fully functional python interpreter with all DLLS, libs,
etc. pip is also fully supported.

VSCode needs to use a resident python interpreter for its own internal use. The engine.exe fully supports
VSCode servers and required modules. However, a couple of things you need to keep in mind.

For VSCode to use engine.exe as it's interpreter, and hence, fully support debugging and running python
nodes, you must make copy engine.exe => python.exe. This has 


## Non-node debugging
Debug as usual with any program or module

## node debugging
To debug a node, use the following launch configuration

		{
			"name": "Engine - Python",
			"type": "python",
			"request": "launch",
			"cwd": "${workspaceFolder}",
			"justMyCode": false,
			"program": "${workspaceFolder}/build/Engine/lib/dbgconn.py",
			"args": [
				"testdata/tasks/0200-scan"
			]
		}

dbgconn.py internally calls the methods to run tasks as specified on the
command line. You can setup breakpoints in the node code, step 
through it as usual
