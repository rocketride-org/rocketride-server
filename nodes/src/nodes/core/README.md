# core

The shared-services module of the RocketRide engine: it registers the built-in pipeline services (file system source, parser, fingerprinter, word indexer, ZIP target, null endpoint) and the common field libraries that other nodes merge into their own service definitions.

## What it does

`core` is not one node; it is the module that registers RocketRide's family of shared services. Each service is declared in a `services.*.json` file in this directory, and you configure them inside a pipeline rather than dropping one standalone node on the canvas.

The directory holds three kinds of content:

- **Concrete service definitions**: `services.filesys.json`, `services.parse.json`, `services.hash.json`, `services.indexer.json`, `services.zip.json`, and `services.null.json` each register one engine service (title, protocol, class type, capabilities, lanes, and config shape).
- **Shared field libraries**: the `services.common*.json` files define reusable field groups (cloud-provider credentials, include/exclude path forms, vector-store settings, LLM access, anonymization, remote processing) that are merged into other service definitions as required.
- **Shared code and assets**: `google_access.py` (the access/scope resolver used by Google tool nodes) and the SVG icons displayed in the UI for connector and processing nodes (Amazon S3, Azure Blob, Google Drive, OneDrive, SharePoint, Outlook, Gmail, Confluence, Slack, SMB, and others).

The `hash/` and `parser/` subdirectories carry the per-service documentation pages for the Fingerprinter and Parser services.

---

## Services

| Service | File | Protocol | Class type | Lanes |
|---------|------|----------|------------|-------|
| Local File System | `services.filesys.json` | `filesys://` | `source` | `_source` → `tags` |
| Parser | `services.parse.json` | `parse://` | `data` | `tags` → `text`, `table`, `image`, `video`, `audio` |
| Fingerprinter | `services.hash.json` | `hash://` | `data` | `tags` → `tags` |
| Word indexer | `services.indexer.json` | `indexer://` | (empty, internal, not selectable) | none |
| ZIP Creation | `services.zip.json` | `zip://` | `target` (internal) | none |
| Null | `services.null.json` | `null://` | (empty, internal) | `source` → `tags` |

### Local File System

A source service that reads data from the local file system, ingesting files and documents from directories for further processing. Capabilities: `filesystem`, `noremote`, `security`, `nosaas`. Supported actions: `export`, `delete`, `download`.

| Field | Type / Default | Description |
|-------|----------------|-------------|
| `include` | array (min 1 item) | Paths included for Scan, Index, Classify, and OCR. Windows: `C:\foldername` or `\\file.core.net\foldername`; Linux: `/file.core.net/foldername`. Each entry carries per-path toggles (`include.permissions`, `include.signing`). |
| `exclude` | array, optional | Paths excluded from processing (same path formats). |
| `excludeExternalDrives` | boolean, default `true` | Skip external drives. |
| `excludeEnableGlobal` | boolean, default `true` | Skip typical OS files and directories. |
| `excludeSymlinks` | boolean, default `true` | Skip symlinks. |
| `estimation` | section, optional | Cost estimations: `estimation.accessDelay`, `estimation.accessRate`, `estimation.storeCost`, `estimation.accessCost` (all numbers, default `0`). |

The service exposes two shape sections: **Source** (full form with estimation) and **Pipe** (the `Pipe.include` / `Pipe.exclude` variants, for example `/Users/usr/Documents/product-images/*`). A development variant of the definition exists as `services.filesys.json.dev`.

### Parser

Extracts structured content from a wide variety of document types. It automatically identifies embedded content and routes it to the appropriate output lane, making text, tables, images, audio, and video accessible for downstream processing. No configuration fields.

| Lane in | Lane out | Description |
|---------|----------|-------------|
| `tags` | `text` | Extracted plain text |
| `tags` | `table` | Extracted tables |
| `tags` | `image` | Extracted images |
| `tags` | `video` | Extracted video streams |
| `tags` | `audio` | Extracted audio streams |

### Fingerprinter

Generates a deterministic fingerprint (hash) of each document's content as it passes through the pipeline. The hash is computed from the raw or normalized text, so identical content always produces the same fingerprint regardless of metadata. Use it for deduplication, content tracking, and identity verification before indexing. Lane: `tags` → `tags`. Ships a single empty `default` preconfig profile and has no configuration fields.

### Word indexer

Enables full-text indexing inside the engine. Registered with capability `internal` and an empty `classType`, so it is not user-selectable on the canvas; it has no fields or shape of its own.

### ZIP Creation

An internal target service (protocol `zip://`) that streams processed objects into a ZIP archive. Supported actions: `export`, `delete`, `download`. Its target parameters are `storePath` (destination folder, see path formats in the Local File System section) and `url` (read-only, default `https://`).

### Null

An internal no-op endpoint registered as both a source shape and a target shape with empty parameter sections. Lane: `source` → `tags`.

---

## Shared field libraries

These files define common fields that are merged into a service definition as required. Field names below are exact.

### Basic fields and include/exclude forms (`services.common.json`)

- `storePath`: exact folder path; format varies by backend (Windows, Linux, AWS/S3 `bucketname/foldername`, Azure Blob `containername/foldername`, SharePoint `sitename/drivename/foldername`, OneDrive `account/foldername`).
- `url`: service URL, read-only, default `https://`.
- `include` / `exclude`: path arrays with per-path processing toggles: `include.classify` (default `false`), `include.ocr` (default `false`), `include.signing` (default `true`; enabling it unlocks `include.index` and `include.vectorize`), `include.index` (default `false`), `include.permissions` (default `false`), `include.vectorize` (default `false`).
- `estimation`: cost-estimation section (`estimation.accessCost`, `estimation.accessDelay`, `estimation.accessRate`, `estimation.storeCost`; all default `0`).
- `DTC.*` and `Pipe.*`: simplified include/exclude/feature variants of the same forms (OCR and permissions feature toggles) used by the DTC and Pipe shapes.
- Hidden plumbing fields: `sync` (default `true`), `actions`, `source.mode` (default `"Source"`), `target.mode` (default `"Target"`), `hideForm` (default `true`).

### AWS credentials (`services.common.aws.json`)

| Field | Type | Description |
|-------|------|-------------|
| `aws.accessKey` | string, secure, optional | Access key used to sign requests to Amazon S3. |
| `aws.secretKey` | string, secure, optional | Secret key used to access AWS services. |
| `aws.region` | enum | AWS region (us-east-1 through sa-east-1; default empty "Select Region"). |

### Google Workspace credentials (`services.common.google.json`)

| Field | Type | Description |
|-------|------|-------------|
| `google.authType` | enum `service` / `user`, default `service` | Selects service-account vs user OAuth flow. |
| `google.customerId` | string | Google Workspace Customer ID (service auth). |
| `google.adminEmail` | string | Administrator e-mail with admin privileges (service auth). |
| `google.serviceKey` | data-url (`.json` upload) | Service-account JSON key file (service auth). |
| `google.oAuthButton` | string, optional | "Login with Google" OAuth widget (user auth). |
| `google.userToken` | string | Long-term access token used to mint Google API access tokens (user auth). |

### LLM access (`services.common.llm.json`)

| Field | Type / Default | Description |
|-------|----------------|-------------|
| `llm.local.serverbase` | string, default `http://localhost:11434/v1` | Base URL the model is hosted under. |
| `llm.cloud.apikey` | string, secure | API key or token. |
| `llm.cloud.project` | string | LLM project or organization name. |
| `llm.cloud.location` | string | LLM server location. |
| `llm.cloud.modelSource` | string, hidden, optional | Model source. |

### Remote processing (`services.common.remote.json`)

`remote.profile` selects the processing mode: `local` ("Process everything locally", the default) or `remote` ("Process CPU/GPU heavy tasks remotely"). Remote mode exposes `remote.host` (default `pipe.rocketride.ai`), `remote.port` (default `5565`), and `remote.apikey`.

### Vector stores and embeddings (`services.common.vector.json`)

| Field | Type / Default | Description |
|-------|----------------|-------------|
| `vector.host` / `vector.port` | string / number | Vector-store server address and port (with `vector.cloud.*` and `vector.local.*` variants, plus `vector.local.grpc_port`). |
| `vector.collection` | string, default `ROCKETRIDE` | Collection name. |
| `vector.score` | number 0-1, default `0.7` | Minimum retrieval score, from `0.0` "All results" to `1.0` "Almost identical". |
| `vector.apikey` | string, secure | API key. |
| `vectorizer.embedding` | combo `embedding` | Embedding provider selector. |
| `vectorizer.store` | combo `store` | Vector-store provider selector. |

### Anonymization (`services.common.anonymize.json`)

| Field | Type / Default | Description |
|-------|----------------|-------------|
| `anonymize` | boolean, default `false` (hidden) | Master toggle: mask classified/sensitive data in the text. |
| `anonymizeChar` | single character, default `█` | Mask character; `"SSN: 064 70 6733"` becomes `"SSN: ███████████"`. |
| `anonymizeAll` | boolean, default `false` | Collapse masked runs to a fixed length (`"SSN: ***"` instead of `"SSN: ***********"`). |

### Combined provider selectors (`services.all.json`)

Combines services into single selectable types for pipelines that pick one provider per slot:

| Field | Combo | Default |
|-------|-------|---------|
| `all.preprocessor` | `preprocessor` | `preprocessor_langchain` |
| `all.embedding` | `embedding` | `embedding_transformer` |
| `all.store` | `store` | `qdrant` |
| `all.llm` | `llm` | `openai` |

---

## Google access helper (`google_access.py`)

A single reader that turns a Google tool node's `access` enum and capability toggles into one resolved object: the OAuth scopes to request, plus the write/destructive gates the node's tool functions check at invoke time.

`resolve_google_access(config, spec)` resolves a node config against a per-API `AccessSpec` and returns a `GoogleAccess` with the granted tier, scopes, `can_write`, and gate flags. Tool functions then call `require_write(op)` and `require_flag(name, op)`, which raise `GoogleAccessError` when the operation is not enabled.

Behavior to know:

- A blank or omitted `access` value falls back to the spec's default tier; any other non-string value raises.
- `can_write` is derived from the granted scopes (a tier is writable if at least one scope does not end in `.readonly`), so it cannot drift from the actual grant.
- Gate flags are strict: only an explicit boolean `true` enables a gated operation. A present non-bool value (`"false"`, `1`, `"no"`) raises rather than coercing, and a missing flag defaults to off.

Bundled specs:

| Spec | Tiers (default in bold) | Gate flags |
|------|--------------------------|------------|
| `GMAIL` | `readonly` / **`modify`** / `send` | none (permanent delete needs the full `https://mail.google.com/` scope, which no tier grants; `gmail.modify` only trashes) |
| `DRIVE` | `readonly` / **`write`** | `allowPublicSharing`, `allowHardDelete` |
| `SHEETS` | `readonly` / **`write`** | none |
| `DOCS` | `readonly` / **`write`** | none |
| `CALENDAR` | `readonly` / **`write`** | `allowDelete` |
| `SLIDES` | `readonly` / **`write`** | none |
| `PEOPLE` | `readonly` / **`write`** (contacts write + directory read-only) | `allowDelete` |

---

## Running the tests

```bash
pytest nodes/test/core/test_google_access.py -v
```

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

### `services.all.json`

| Field | Type | Description | Default |
|---|---|---|---|
| `all.embedding` |  | **Embedding** | `"embedding_transformer"` |
| `all.llm` |  | **LLM** | `"openai"` |
| `all.preprocessor` |  | **Preprocessor** | `"preprocessor_langchain"` |
| `all.store` |  | **Vector Store** | `"qdrant"` |

### `services.common.anonymize.json`

| Field | Type | Description | Default |
|---|---|---|---|
| `anonymize` | `boolean` | **Anonymize Classified Information**<br/>Enable it if you want to mask any sensitive data in the text. If you leave it disabled, the text will be output as it is.<br/><br/>For example, if you enable it, then the text "SSN: 064 70 6733" will become "SSN: ***********". If you disable it, the text will remain "SSN: 064 70 6733". | `false` |
| `anonymizeAll` | `boolean` | **Anonymize All Data**<br/>Enable it if you want to collapse to the fixed length any sensitive data in the text.<br/><br/>For example, if you enable it, then the text "SSN: 064 70 6733" will become "SSN: ***". If you disable it, the text will remain "SSN: ***********". | `false` |
| `anonymizeChar` | `string` | **Anonymization Character**<br/>Specify a character that will mask any sensitive data in the text.<br/><br/>For example, if you specify the characher "*", then the text "SSN: 064 70 6733" will become "SSN: ***********". If you specify the character "?" the text will become "SSN: ???????????". | `"█"` |

### `services.common.aws.json`

| Field | Type | Description | Default |
|---|---|---|---|
| `aws.accessKey` | `string` | **Access key**<br/>This is a key which gives access to your AWS resources. It is provided by the service provider. It is used to sign the requests you send to Amazon S3. |  |
| `aws.region` | `string` | **Region**<br/>This is defined and provided by the service provider. | `""` |
| `aws.secretKey` | `string` | **Secret key**<br/>This is a key used to access the AWS services. |  |

### `services.common.google.json`

| Field | Type | Description | Default |
|---|---|---|---|
| `google.adminEmail` | `string` | **Administrator E-mail**<br/>Enter the email address of a Google Workspace administrator.<br/><br/>This email should belong to a user with administrative privileges in your Google Workspace domain. |  |
| `google.authType` | `string` | **Authentication Type** | `"service"` |
| `google.customerId` | `string` | **Customer ID**<br/>Enter your Google Workspace Customer ID.<br/><br/>This unique identifier is assigned to your organization by Google. It is used to specify the particular Google Workspace domain you want to manage. |  |
| `google.oAuthButton` | `string` | **Login with Google** |  |
| `google.serviceKey` | `string` | **Service Account Key File**<br/>Upload the JSON key file for your Google Workspace service account.<br/><br/>This file contains the credentials necessary to authenticate API requests. |  |
| `google.userToken` | `string` | **Access Token**<br/>It is a long term token that allows you to get new access tokens to access the Google API. |  |

### `services.common.json`

| Field | Type | Description | Default |
|---|---|---|---|
| `DTC.exclude` | `array` | **Provide the path to exclude** |  |
| `DTC.exclude.path` | `string` | **Exclude path** |  |
| `DTC.features` | `object` | **What features do you want?**<br/>Please be advised that selecting additional features will increase the time it takes to scan your data. |  |
| `DTC.include` | `array` | **Provide the path to your data** |  |
| `DTC.include.path` | `string` | **Include path** |  |
| `Pipe.exclude` | `array` | **Provide the path to exclude** |  |
| `Pipe.exclude.path` | `string` | **Exclude path** |  |
| `Pipe.features` | `object` | **What features do you want?**<br/>Please be advised that selecting additional features will increase the time it takes to scan your data. |  |
| `Pipe.include` | `array` | **Provide the path to your data** |  |
| `Pipe.include.path` | `string` | **Include path** |  |
| `actions` | `object` |  |  |
| `estimation` |  | **Cost estimations** |  |
| `estimation.accessCost` | `number` | **Access cost**<br/>The egress cost per MB to recall a file. | `0` |
| `estimation.accessDelay` | `number` | **Access delay**<br/>Elapsed time before access to a file starts. (For example: S3 could be 0 second delay, while Glacier could be hours. | `0` |
| `estimation.accessRate` | `number` | **Access rate**<br/>Time required to recall a file in MB per second. | `0` |
| `estimation.storeCost` | `number` | **Store cost**<br/>The cost per MB to store a file for a month. | `0` |
| `exclude` | `array` | **Exclude paths** |  |
| `exclude.path` | `string` | **Exclude path** |  |
| `hideForm` | `boolean` |  | `true` |
| `include` | `array` | **Include paths** |  |
| `include.classify` | `boolean` | **Enable Classification**<br/>Classification will assign each file to one or more classification policies. Once enabled, all supported files will be classified into one or more of the activated classification policies. | `false` |
| `include.index` | `boolean` | **Enable Indexing**<br/>Indexing will allow for full-text search of all processed files. Once enabled, all supported files will be scanned and indexed as they are processed.<br/>Once Index is enabled, other parameters like OCR and classify could be enabled too. | `false` |
| `include.ocr` | `boolean` | **Enable OCR**<br/>Optical Character Recognition (OCR) will convert typed or handwritten text found in images into text.Once enabled, all image files such as jpgs will have text extracted for use in classification and search. | `false` |
| `include.path` | `string` | **Include path** |  |
| `include.permissions` | `boolean` | **Enable Permissions**<br/>Permissions allow gathering of file ownerships and permissions from all connected and scanned sources. | `false` |
| `include.signing` | `boolean` | **Content Signature**<br/>Content Signature executes a hash algorithm on the content of every object to generate a "signature". Identical signatures indicate identical content and are an effective method to detect duplicate objects. | `true` |
| `include.vectorize` | `boolean` | **Enable AI Embeddings**<br/>AI embeddings make text content accessible to AI technologies like semantic relevancy and generative AP chants.<br/>Once AI embeddings are enabled, other parameters like OCR and classify could be enabled too. | `false` |
| `source.mode` | `string` |  | `"Source"` |
| `storePath` | `string` | **Store path**<br/>This path defines the exact specific folder in the filesystem.<br/><br/>Format for Windows : C:\foldername (for local filesystem) or \\file.core.net\foldername (for shared folders)<br/><br/>Format for Linux : /file.core.net/foldername<br/><br/>Format for AWS/S3 : bucketname/foldername<br/>Format for Azure blob : containername/foldername<br/>Format for SharePoint: sitename/drivename/foldername<br/>Format for onedrive: account/foldername |  |
| `sync` | `boolean` |  | `true` |
| `target.mode` | `string` |  | `"Target"` |
| `url` | `string` | **URL**<br/>URL to connect to the service. E.g: https://[dnsname].com | `"https://"` |

### `services.common.llm.json`

| Field | Type | Description | Default |
|---|---|---|---|
| `llm.cloud.apikey` | `string` | **API key (Token)**<br/>Enter your API key or token |  |
| `llm.cloud.location` | `string` | **Location**<br/>LLM server location |  |
| `llm.cloud.modelSource` | `string` | **Model source** |  |
| `llm.cloud.project` | `string` | **Project (Organization)**<br/>LLM project or organization name |  |
| `llm.local.serverbase` | `string` | **LLM URL**<br/>Base url the model is hosted under. | `"http://localhost:11434/v1"` |

### `services.common.remote.json`

| Field | Type | Description | Default |
|---|---|---|---|
| `remote.apikey` | `string` | **API key**<br/>Enter your API key |  |
| `remote.host` | `string` | **Host** | `"pipe.rocketride.ai"` |
| `remote.local.mode` | `string` |  | const: `"local"` |
| `remote.port` | `number` | **Port** | `5565` |
| `remote.profile` | `string` | **Processing Mode** | `"local"` |
| `remote.provider` | `string` |  | const: `"remote"` |
| `remote.remote.mode` | `string` |  | const: `"remote"` |

### `services.common.vector.json`

| Field | Type | Description | Default |
|---|---|---|---|
| `vector.apikey` | `string` | **API key**<br/>Enter your API key |  |
| `vector.cloud.host` | `string` | **Host**<br/>Enter the server IP address e.g. Localhost |  |
| `vector.cloud.port` | `number` | **Port**<br/>Enter the port number |  |
| `vector.collection` | `string` | **Collection**<br/>Enter the name of the collection | `"ROCKETRIDE"` |
| `vector.host` | `string` | **Host**<br/>Enter the server IP address e.g. Localhost |  |
| `vector.local.grpc_port` | `number` | **gRPC Port**<br/>Enter the port number |  |
| `vector.local.host` | `string` | **Host**<br/>Enter the server IP address e.g. Localhost |  |
| `vector.local.port` | `number` | **Port**<br/>Enter the port number |  |
| `vector.port` | `number` | **Port**<br/>Enter the port number |  |
| `vector.score` | `number` | **Retrieval Score**<br/>Minumum retrieval score | `0.7` |
| `vectorizer.embedding` |  | **Embedding** |  |
| `vectorizer.store` |  | **Vector Store** |  |

### Local File System (`services.filesys.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `Pipe.exclude` |  | Example Path: /Users/usr/Documents/product-images/* |  |
| `Pipe.filesys.source.parameters` |  |  |  |
| `Pipe.include` |  | Example Path: /Users/usr/Documents/product-images/* |  |
| `exclude` |  | This path defines the paths excluded for Scan, Index, Classify and OCR. By default, its empty.<br/><br/>Format for Windows : C:\foldername (for local filesystem) or \\file.core.net\foldername (for shared folders)<br/><br/>Format for Linux : /file.core.net/foldername |  |
| `excludeEnableGlobal` | `boolean` | **Exclude typical OS files and directories** | `true` |
| `excludeExternalDrives` | `boolean` | **Exclude external drives** | `true` |
| `excludeSymlinks` | `boolean` | **Exclude symlinks** | `true` |
| `filesys.source.parameters` |  | **Parameters** |  |
| `include` |  | This path defines the paths included for Scan, Index, Classify and OCR. By default, its empty.<br/><br/>Format for Windows : C:\foldername (for local filesystem) or \\file.core.net\foldername (for shared folders)<br/><br/>Format for Linux : /file.core.net/foldername |  |

### Fingerprinter (`services.hash.json`)

_No configuration fields._

### Word indexer (`services.indexer.json`)

_No configuration fields._

### Local File System (`services.null.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `null.source.parameters` |  | **Parameters** |  |

### Parser (`services.parse.json`)

_No configuration fields._

### ZIP Creation (`services.zip.json`)

_No configuration fields._

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/core)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
