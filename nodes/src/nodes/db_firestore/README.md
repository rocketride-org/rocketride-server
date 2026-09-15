# db_firestore

A RocketRide database node that reads and writes documents in a Google Cloud Firestore (Native mode) database. Pick it when a pipeline's agent needs to fetch or persist individual JSON documents in Firestore.

## About Google Cloud Firestore

Firestore is Google Cloud's managed document database. It stores JSON-like
documents in named collections, addresses each document by an ID within its
collection, and is offered in a Native mode alongside a Datastore-compatible
mode. Applications on Google Cloud commonly use it for application state and
user-facing data.

## What it does

The node opens a Firestore client against one project and database when the pipeline starts and keeps it open for the run. It has no data lanes and no invoke connections: its whole surface is two document operations offered to a connected agent. Reach for it when the work is document-at-a-time reads and writes against Firestore; it does not expose collection queries, listing, or deletes.

Configuration names a default collection, so an agent can be pointed at one collection and then call the tools without repeating it.

## As a tool

The registered tool names are the bare method names below; an agent catalog namespaces them by the pipeline component id, not by the services.json `prefix`.

| Function | Description |
| --- | --- |
| `get_document` | Fetch a single document by ID and return its fields. |
| `set_document` | Create or merge a document from a JSON object. |

`get_document` requires `document_id` and accepts an optional `collection`. It returns the document's fields as an object. A document that does not exist, an unconnected client, or a Firestore failure comes back as an object with a single `error` key rather than as a raised exception.

`set_document` requires `data`, a JSON object to store, and accepts optional `collection` and `document_id`. With a `document_id` it writes with merge semantics, so listed fields are updated and unlisted fields on an existing document are left alone. With no `document_id` Firestore generates one and the returned message names it. Both success and failure are returned as a plain sentence, so an agent should read the returned text to confirm the write.

For both functions, omitting `collection` falls back to the collection configured on the node. Leaving both empty targets an empty collection name and the call fails.

## Configuration

Pick the credential mode, then name the collection the agent should work in; the database ID only matters for projects with more than one Firestore database. Nothing else needs to be set for a single-database project.

### Collection

The collection the tools use when a call does not pass its own `collection`. It has no default, and configuration validation warns when it is left blank — leaving it blank is only reasonable when every tool call will name its own collection. Set it to the one collection this node instance is responsible for, for example `orders`; an agent then calls `get_document` with just a `document_id`.

### Database ID

The Firestore database this node connects to, defaulting to `(default)`, which is the name Google Cloud gives the first database created in a project. Change it only when the project holds several named Firestore databases and this node should target one of the others. A blank value is treated as `(default)`.

## Authentication

The node uses RocketRide's shared Google Cloud credential resolution and requests the `https://www.googleapis.com/auth/datastore` scope.

**Authentication Type** selects between Application Default Credentials and Service Account JSON. Application Default Credentials is the default and suits an engine running on Google Cloud infrastructure with an attached service account, or a host where ADC has already been provisioned. Selecting Service Account JSON reveals **Service Account Key JSON**, an upload field for the key file; it is stored as a secret and is required in that mode.

**Project ID** is optional. Left blank, the project is taken from the uploaded key file or from the ambient default credentials; set it explicitly when the credentials could resolve to a different project than the one holding the data.

Grant the credential enough IAM to read and write the documents the agent will touch. Listing collections is not required — see the startup probe under Notes.

## Limitations

Declared `noremote`: this node runs on the local engine host only and is not
available for remote execution. It needs network access to Google Cloud APIs,
and, in Application Default Credentials mode, to whatever credential source the
host provides.

## Notes

### Startup probe

After connecting, the node tries to read one entry from the project's collection listing as a connectivity check. Listing collections needs broader IAM than document reads and writes, so a failure here is logged as a warning and startup continues — a narrowly scoped service account that can only touch documents is a supported setup. A warning from this probe is therefore not by itself proof that the tools will fail.

### Missing dependency

The node imports `google-cloud-firestore` at load time and raises an explicit `ImportError` when the package is unavailable, rather than failing later on the first tool call.

## Upstream docs

- [Firestore documentation](https://cloud.google.com/firestore/docs)
- [google-cloud-firestore Python client](https://cloud.google.com/python/docs/reference/firestore/latest)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `firestore.collection` | `string` | **Collection**<br/>The Firestore collection to query or insert into. |  |
| `firestore.database` | `string` | **Database ID**<br/>The Firestore database ID. Usually '(default)'. | `"(default)"` |
| `firestore.profile` | `string` |  | `"default"` |

## Dependencies

- `google-auth` `>=2.23.3`
- `google-cloud-firestore` `>=2.13.0`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/db_firestore)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
