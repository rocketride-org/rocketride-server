## Working on Chat/Dropper UI

### Initial Setup
Perform the following steps when you first clone the repo:

```bash
# Install all the requirements
pnpm install

# Configure the engine and automatically install
# all missing OS modules and libraries
pnpm configure:auto

# Build all the modules - if you do not need to run engine
# tests, you can add '-- --target engine' which will speed
# up your build process
pnpm build:all
```

### Run your Eaas Server
In order for chat and dropper to function, you will need a background Eaas to run against. Start this server as follows:

```bash
# Run the Eaas server using the distributables we built
cd ./build/Engine

# Execute the engine
./engine ../../aparavi-ai/ai/eaas.py
```

After the server finishes loading all its Python dependencies, you should see:

```plain
                                                   _
                                                  (_)
                  __ _ _ __   __ _ _ __ __ ___   ___
                 / _` | '_ \ / _` | '__/ _` \ \ / / |
                | (_| | |_) | (_| | | | (_| |\ V /| |
                 \__,_| .__/ \__,_|_|  \__,_| \_/ |_|
                      | |
                      |_|

               Copyright (c) 2025, Aparavi Software, AG
                          All rights reserved

INFO:     Started server process [37260]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://localhost:5565 (Press CTRL+C to quit)
```

### Using VSCode

At this point you have an Eaas engine running, the source download and you want to
make changes. The workflow is identical to any typescript based app. 

* Open the engine/aparavi-ai/ai/modules/chat/chatUI directory in VSCode. This
will start a normal VSCode session with the typescript/react/dev server mode.

* To run the dev server with replaceable modules, just use "pnpm dev"

* To configure the server and API key to connect to (the one you started
above), setup a .env file with the address and apikey. There is a .env.template 
file for you located in the chatUI directory.

