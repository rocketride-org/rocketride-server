# VSCode

## Perform the following steps when you first clone the repo

```bash
# Install all the requirements
pnpm install

# Configure the engine and automatically install
# all missing OS modules and libraries
pnpm configure:auto

# Build all the modules - if you do not need to run engine
# tests, you can add '-- --target engine' which will speed
# up your build process
pnmp build:all
```

## Developing and debugging

From this point, you have everything you need to work on the C++
engine code and python code in ai or nodes.

The [Build] button on your VSCode status bar will recognize your
configured engine. If you make changes to any of the cmake files,
or environment, VSCode Build will autmatically reconfigure
and compile as needed.

## Running the Eaas server

Often times, you want to run the Eaas server in the background while 
you are working on other modules, like the user interfaces. To accomplish
this:

```bash
# Run the Eaas server using the distributables we will built. 
cd ./build/Engine

# Execute the engine
./engine ../../aparavi-ai/ai/eaas.py
```

This will ensure that any changes made to either the Eaas code or user 
interface code is used without have to perform a build step. The code
that is executed is coming from the dev branch itself.

