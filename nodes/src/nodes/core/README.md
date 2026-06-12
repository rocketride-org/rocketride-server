# core

## What it does

`core` isn't one node, it's the module that registers RocketRide's family of shared services. They live in the `services.*.json` files in this directory (for example `services.common.aws.json`, `services.common.google.json`, `services.common.vector.json`, `services.parse.json`, `services.hash.json`, `services.indexer.json`, `services.zip.json`, and `services.filesys.json`), and you configure them inside a pipeline rather than dropping one standalone node on the canvas.

## Service families

**Sources / connectors**

- Local File System (`services.filesys.json`) and SMB
- Amazon S3 and Azure Blob (object storage)
- Google Drive, OneDrive, SharePoint
- Outlook and Gmail
- Confluence and Slack

**Processing**

- Parsing (`services.parse.json`): content extraction from source objects
- Hashing / fingerprinting (`services.hash.json`)
- Zip streaming and creation (`services.zip.json`)
- Word indexing (`services.indexer.json`)
- Vectorization, embeddings, and vector stores (`services.common.vector.json`)
- Anonymization (`services.common.anonymize.json`) and LLM access (`services.common.llm.json`)

Cloud-provider credentials and connection settings are grouped per provider (AWS, Google, etc.). The `services.all.json` aggregate exposes combined selectable types (preprocessor, embedding, vector store, LLM) for pipelines that pick one provider per slot.

## Configuration

Each service exposes its own config fields (credentials, hosts/ports, collection names, processing parameters) through the pipeline builder when the corresponding service is selected. See the individual `services.*.json` files for the exact fields of each provider.
