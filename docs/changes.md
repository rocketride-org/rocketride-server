# Changes to procedures with feat/debugger2

</br>
</br>

## <b>Rule #1 - forget everything you know about building previous versions!</b>

</br>
</br>

## <b>The build directory is ./build, not ./out!</b>

This was really all over the map due to inconsistencies betwwen the IDE and the command line. It caused double work, and mad command line build different than IDE based builds. So, since half the tools we using build, the other half out, we settled on ./build...

</br>
</br>

## <b>Do not use .sh scripts themselves. Use pnpm!</b>

The build.sh/.bat and setup.sh/.bat are invoked when needed by pnpm scripts. There is much more that needs to be executed in the context of setting up and building now. By using these scripts directly, your build may look like it functions correctly, but will fail since submodules are not build. Use PNPM... 

</br>
</br>

## Important notes

### Coming soon

The aparavi-ai and aparavi-nodes will combined into a single repo. While not strictly necessary, it will make life somethat easier since the two are so co-depenedent on one another. Stepan will announce when this occurs.

### Clients

The clients in aparavi-clients are GENERIC clients. The need to work on a standard system, like python.exe and standard NodeJS. You cannot assume any type of environment, nor import things like the aparavi or engLib modules - they aren't there. Keep in mind, this is CLIENT code, keep it clean as this will be public!

Also, we MUST keep the API in sync, so, if you made a fix in the typescript code, at least check to see if the python code also needs a fix. If you extend the functionality of the python code, you must also extend the typescript code -- keep them in sync! 

We use these client internally in the engine. For python, all the /task endpoints connect to the Eaas server via websockets, make the request and then disconnect the client. The typescript client is used in chat and dropper UIs

### aparavi cli

If you install the aparavi python client, there is a binary called aparavi.exe (or just aparavi) that lets you monitor events, start/stop tasks, etc. It uses the python client to perform all these actions. 

## New launch.template.json

We are not going to overwrite your existing launch.json, but there is a new template you can use which greatly simplifies setting up the debugging experience.

## Changes to modules and submodules

### ./scripts/bootstrap.sh

If you are running on a brand new, retail OS, or a bare docker image, an image in WSL, etc, you can use the ./scrips/bootstrap.sh script. This will ensure the bare essentials like nodeJS and pnpm are installed in order to utilize all the pnpm scripts.

### Running in the [root] project

We can no longer just "copy" things around. Submodules must be built, specifically, dropper, chat
and the clients. So the days of just copying aparavi-ai\ai to ai are over...

Each module that requires some kind of build procedure has a corresponing package.json located
in its root directory. Each package has a series of actions:

| Action		| What it does 									|
|---------------|-----------------------------------------------|
| install		| Installs everything required for the immediate module	|
| build			| Builds the module and places its output into the ./build/Engine directory |
| test			| Tests the modules, stopping on any errors |
| clean			| Cleans output in both the ./build/Engine directory and any internal directories used during the build process
| lint			| lints the modules |
| dev			| runs the module in dev mode |

All modules are registered in the root modules workspace settings, so the workspace root has additional actions you can perform to work on all modules together:

| Action			| What it does 									|
|-------------------|-----------------------------------------------|
| install			| Installs all requirements						|
| configure			| Configures the projects						|
| configure:auto	| Configures the projects and automatically install dependencies |
| build:all			| Builds all modules, including the engine		|
| build:only		| Build only submodules, not the engine itself	|
| test:all			| Tests all modules								|
| clean:all			| Cleans all modules							|
| lint:all			| lints all modules								|
| dev:all			| starts all modules in dev mode				|

### Running a specific module

If you are working on a specific submodule that requires building (chatUI for example), go into the chatUI subdirectory. From here, you can directly issue actions on only the chatUI module. For example,

```bash
./engine/ai/modules/chat/chatUI> pnpm build
```

This will allow full access to all the actions for the module individually without affecting or building other modules.

### README.md

Pay close attention to the readme instructions for your operating system. Although setup and build procedures are dramatically simplified, it is still a change to your workflow, so go through the steps. We eliminated about 90% of the steps going from a bare OS to a functional build system.

On Windows, there are a few manual installation steps you need to go through that we could not automate (due to so many variations in OS configurations).

On Mac and Linux, it is fully automated.


## Docker Builds

Docker builds have undergone some major changes in order to be more efficient and utilize the common build system. 

* aparavi-engine - this image is the compiled engine, which is based on debian-12. 

* aparavi-eaas - this image is the fully configured eaas server. It utilizes the latest aparavi-engine, updates the ai/connecters/clients (and compiles them) in an intermediate step, so the final image has your latest python code, with the aparavi-engine:latest.

