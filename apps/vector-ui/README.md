# Vector Explorer

Vector Explorer is the console for a vector store your pipelines already
write to: see how many documents and chunks it holds, list every document by
its path, move a document to the trash (and restore it, or delete it for good),
drop new files in to add them, ask questions over
what is stored, and map the chunks to see which ones sit close together. It is
not a database client of its own. Every call travels through a store node
inside one of your running pipelines, so it reaches exactly the collection that
node is configured for, with that node's settings. If apps are new to you, read
[Apps](https://github.com/rocketride-org/rocketride-server/blob/develop/docs/public/product/concepts/apps.md)
first. What the app deliberately does not do is under [Limits](#limits). The
full user guide, from preparing a pipeline to what every note means, is
[Vector Explorer](https://docs.rocketride.org/guides/apps/vector-explorer) on
docs.rocketride.org.

The store nodes it opens are
[`postgres`](https://github.com/rocketride-org/rocketride-server/blob/develop/nodes/src/nodes/store_postgres/README.md)
(pgvector),
[`rocketride_vector`](https://github.com/rocketride-org/rocketride-server/blob/develop/nodes/src/nodes/rocketride_vector/README.md)
(a managed RocketRide database: your organization's, your team's or your own),
[`qdrant`](https://github.com/rocketride-org/rocketride-server/blob/develop/nodes/src/nodes/store_qdrant/README.md)
and
[`chroma`](https://github.com/rocketride-org/rocketride-server/blob/develop/nodes/src/nodes/store_chroma/README.md),
plus Milvus, Weaviate, Pinecone, Astra DB and MongoDB Atlas, which are marked
**Experimental**: their drivers were not run against a live server in this
build. Elasticsearch and OpenSearch store nodes are not listed: they do not
answer the Vector Explorer tools.

## Before you start

- **A pipeline laid out for Vector Explorer.** Nine starting pipelines, one per
  store (`postgres.pipe`, `rocketride_vector.pipe`, `qdrant.pipe`,
  `chroma.pipe`, and the experimental `milvus.pipe`, `weaviate.pipe`,
  `pinecone.pipe`, `astra.pipe` and `atlas.pipe`), are kept in the RocketRide
  repository under
  [`apps/vector-ui/templates`](https://github.com/rocketride-org/rocketride-server/tree/develop/apps/vector-ui/templates).
  They are not installed with the app. Each has three sources: **Ingest** (a
  dropper the app sends files to), **Chat** (questions) and **Tools** (the app's
  own calls), a parser, a chunker, an embedding node, two instances of the same
  store on the same collection (`store_1`, which the app manages, and
  `store_2`, which the chat reads), an LLM node and the two response nodes. They
  hold no password, token or `project_id`. To use one, open it there and save
  its text as a new `.pipe` file in a VS Code workspace: the editor gives a new
  `.pipe` file its own `project_id`, and the app groups a pipeline's three
  sources by it. Type the store's connection details into its form. Both store
  nodes keep chunks with a cosine similarity of at least 0.3 to the question,
  written on the store's own score scale: `0.3` on pgvector, RocketRide Vector
  and Pinecone, `0.65` (that is, (1 + 0.3) / 2) on the other stores.
- **All three sources running.** Connections are discovered from running tasks.
  A pipeline whose Tools source is not running still appears, as a
  **Read-only** card (see [Connections](#connections)).
- **An LLM key, only for the chat.** The templates' LLM node carries the
  placeholder `replace-with-your-key`; replace it with your key, and set
  `base_url` only for an OpenAI-compatible server other than OpenAI. Until
  then the chat cannot answer; everything else works.
- **The trash is a node setting.** Each store node has **Allow document
  management from tool calls** (`allow_writes`). It is off unless the pipeline
  turns it on; the templates turn it on for `store_1` only. With it off, the
  trash buttons (and Restore, Delete permanently and Empty trash) are disabled
  and say why.

## Connections

The Connections page lists one card per store node a running Tools source
controls. A card shows the node's name, the store, the collection and the
pipeline, which of the pipeline's three sources are running
(`ingest ✓ · chat ✓ · tools ✓`), and a state: **Checking**, **Running**,
**Stopped**, **Unreachable** or **No access**. Further badges say
**Experimental**, **Empty collection** (the collection does not exist yet; add a
document to create it), **Repair needed** (the collection's control record is
missing) and **Metadata column pending** (pgvector: another session holds the
table, so file size and ingest time are not stored yet; the node retries).

`store_2`, the chat path's copy of the store, is never a card. SQL and graph
nodes are never cards.

A pipeline with vector stores but no running Tools source (for example the
stock RAG template, a webhook and a chat) is listed as a **Read-only** card,
anchored on its Chat source (or its Ingest source when chat is not running):
documents cannot be added or removed from there, and the card says so. A store
the anchor source cannot reach is shown **Stopped**, "Not reachable from the
chat source".

The drawer of a card shows the roles, the backend and its version, the
collection, metric, embedding model and dimension, the index, the embedding and
LLM node names, whether removing documents is on, the support level and any
caveat. For `rocketride_vector` it adds: "Shared table: every pipeline in this
organization that names table '<table>' reads and writes these rows." It never
shows a host, a connection string, a credential or a database name.

Signing out, or a switch to another organization or development team, forgets
every connection, closes every console and document tab, and clears every
cache (documents, chunks, uploads, chat, samples and the selection).

## The console

Opening a connection opens its console, the main screen.

- **Statistics** across the top: documents, chunks, deleted chunks, average
  chunks per document, the embedding model and dimension, the metric and the
  index. The figures come from the node's `stats` tool: a full count when the
  console opens, after a write (to or from the trash, a delete) or a completed
  upload and on **Refresh**, and a quick refresh at most every 15 seconds while
  the console is visible, which says "counts as of 12 s ago". A figure the store
  cannot count shows "—" with a tooltip saying so (Pinecone counts nothing per
  document). Chips name what
  qualifies the figures: **Experimental**, **Brute-force search**, **Writes
  on/off**, **Read-only**, **N without first chunk** and caveats such as
  "Scores are the backend's raw values, not 0–1."
- **Documents** on the left: every document once, by its path, grouped into
  folders by `/` and `\` (Windows drive letters and network shares are kept as
  roots; a bare file name goes under **Uploaded**; a document whose first chunk
  is missing goes under **Without first chunk**). The list loads its first page
  at once and keeps loading in the background up to 5,000 documents ("Loading
  documents… 1,200 of 10,000"); rows are re-sorted only when loading ends or
  pauses, so nothing moves under the pointer. Past 5,000 the footer says "Limit
  reached at 5,000 documents; more may exist" with **Load more**. A store that
  lists documents in storage order is sorted here, and the footer says so; when
  a store sends back documents already listed instead of the next page, loading
  stops there and the footer says that too. Selecting a document lists its
  chunks. A document whose stored chunks look wrong (no first chunk, gaps in
  its chunk numbers, soft-deleted chunks still stored, nothing parsed, far more
  chunks than the others) goes under **Needs attention**, and its tab says what
  was found.
- **Scope**: the row above the list starts with the path box ("Filter
  paths…") and adds **Add condition** (*Folder is under*, *File type is*,
  *Ingested after/before*, *Chunks between*, *Has tables*, *Missing first
  chunk*) and **Saved**. With no condition it is one row. A scope applies to
  the documents, the map, the search and the chat (**Apply to**), and says who
  filtered: "12 documents match (store)" where the store applies the
  conditions, "12 of 1,200 loaded match (filtered here; the store cannot
  filter by these)" where it cannot. The map, the search and the chat take at
  most 2,000 documents; a larger scope says so and leaves them unscoped. **Save**
  keeps the conditions under a name for this connection until you sign out.
- **Charts**: a disclosure at the end of the statistics shows chunks per
  document, chunk length (from the map's sample), documents by file type and
  ingest time; clicking a bar scopes the documents to it. A **Size** figure
  appears where the store reports one.
- **Move to trash**: the trash button of a row moves that document and all its
  chunks to the trash, after a confirmation whose **Cancel** has the focus;
  nothing is typed, because the Trash can restore it. The answer says how many
  chunks moved, and the statistics, the list, the store's details and the map
  refresh. Select several rows to move them together: they go in batches of at
  most 100, and the first error stops the run and says what already ran.
- **Trash**: the directory's title switches between **Documents** and **Trash
  (N)**, N being the store's count of documents with chunks in the trash. There
  each document has **Restore** (at once) and **Delete permanently** (confirmed;
  several are confirmed by typing their count), and **Empty trash** deletes the
  whole trash permanently after you type how many documents it holds. A
  document that still has chunks outside the trash is kept, and the answer says
  so. On `rocketride_vector` the permanent deletes ask for the table name
  instead, because the table is shared by every pipeline of your organization
  that names it. A document in the trash says "This document is in the trash.
  Restore it to read it." until it is restored.
- **Add documents** at the top right: drop files or folders, or use **Add
  files** / **Add folder**. Each upload shows its progress and then "N chunks
  added".
- **Chat** at the bottom right: ask a question over the stored documents; the
  answer lists the chunks it was given, each with **open** (the document, at
  that chunk) and **map**.
- **Search** in the chat's header swaps the chat for a search without the LLM,
  in the same column (the chat and its draft are one click away): semantic,
  keyword (where the store can: "matches text fragments" or "matches whole
  words"), hybrid (the two rankings fused here) or auto, with a threshold
  slider that shows how many results would pass ("At 0.42: 7 of 20 would
  pass") and **Copy as node setting** (`threshold_search: 0.42`, to set on the
  store node in the pipeline editor). **Compare** runs a second question and
  reports what the two share; the map draws both as stars. "Why these?" under
  an answer opens the same view with the cited chunks marked.

A document tab shows one document: its path, objectId, chunk count, size,
type and ingest time where the store keeps them, and every chunk in reading
order. Once a text query is placed on the map (or a chat answer is shown
there), its heat strip shows how similar each chunk is to that query; until
then it says how to get one.

## The map

The **Map** tab of a connection draws a sample of the chunks (up to 2,000 with
text, or 5,000 points without) positioned by their embeddings, so chunks that
say similar things sit close together. A text query is placed on the map with
rays to its true top matches; a point shows its 12 nearest chunks in the whole
collection; every action leads back to the console. **Table** lists the same
points for keyboard and screen-reader use. Everything below works on the
sample the browser already holds, without asking the store again, unless it
says otherwise.

- **Clusters**: connected groups of the sample's neighbour graph, named by
  their most frequent terms (computed by the store node). The **Clusters** tab
  lists them by size with **Show**, **Ask about these** (scopes the chat to
  their documents) and **Export**; **Minimum size** (2, 5 or 10) regroups
  instantly. **Colour by** offers Cluster, and also ingest date, file size,
  health, ingest node, table chunks, density and query similarity.
- **Edges**: None, each point's strongest neighbours, or the spanning tree of
  the neighbour graph; hovering a point thickens its edges, **Expand selected**
  adds a point's own.
- **Isolate** shows only the lasso selection or a cluster ("Showing 212 of
  1,000"), **Expand by neighbours** grows it by one ring, **Show all** brings
  the rest back.
- **Duplicates** is a review queue: near-duplicate chunks grouped by document,
  a similarity slider, a keep policy (oldest ingest, shortest path, most chunks
  or by hand), and **Move all queued to the trash**, through the console's
  confirmation.
- **Outliers** lists the sparsest points with why ("density 0.12 vs sample
  median 0.61"), the share to show (1, 2 or 5 %), **Mark reviewed** and
  **Move to trash**.
- **Recommend** finds chunks like the positive examples and unlike the
  negative ones (add them from a point's panel; best score where the store
  offers it, Qdrant).
- **Similarity matrix** of 2 to 100 selected points, with a table alternative
  and CSV export; it is computed by the store from the points' keys.
- **Show full text** of a point, with the active question's words marked
  (lexical matches only; retrieval is by meaning).
- **Export**: the sample, the selection, the points shown, the clusters, the
  duplicates and the outliers as CSV or JSON, and the map as PNG with its
  legend.
- **Views**: save the map's settings, selection and camera under a name and
  apply them again later in the session; a view keeps up to 2,000 selected
  points and redraws up to 200 of those the new sample lacks, and says how many
  it restored.

## Adding documents

- Up to 20 files per drop, 50 MB per file and 200 MB per drop; PDF, DOCX, PPTX,
  XLSX, ODT, RTF, TXT, MD, CSV, HTML and JSON. The app checks these limits
  before sending: a file over a limit is excluded, not ingested, and its row
  says why ("Not added: larger than 50 MB."). The engine does not apply the
  templates' parser cap (`parse_1.config.index.maxFileSize`) in this release,
  so the app's limits are the only ones.
- A file is stored under its path in the drop (a folder keeps its structure);
  **Store under folder** puts a prefix in front. Dropping a file whose path is
  already stored asks before replacing it; the old chunks are removed when the
  new file is stored.
- An upload that completes but leaves no chunks in the store (for example a PDF
  without text the parser can read) says "Not added: the pipeline stored no
  chunks for this file." once the store still does not list it a few seconds
  later.
- Above the uploads, a drop is summed up as it runs ("Drop of 12 files: 9
  added (341 chunks) · 2 replaced · 1 not added · 00:48"); when it completes,
  **Show new chunks on the map** places up to 200 of them on the map and says
  when it placed fewer than were added.
- Anyone with the data permission on the Ingest task can add documents, with or
  without this app.

## As a dev tool

Vector Explorer also runs as a dev tool beside the pipeline editor, in VS Code
and in the RocketRide workspace. There the sidebar lists your vector store
connections, and each console and each stored document opens as its own
document; the map stays a tab of the console. A connection's row shows its
state as a dot and, when it is not running or cannot be written, in words
(**Checking**, **Stopped**, **Unreachable**, **No access**, **Needs upgrade**,
**Read-only**); its tooltip names the store, the collection and the pipeline,
the sources that run, and why the console cannot be opened. Click a row, or
press Enter or Space on it, to open its console. **Refresh** is on the
Connections header, and a line under the rows says when discovery is running,
found nothing, or failed. What a card's drawer shows in the app (the state,
the sources and flags, **Test connection**, the store's details) is on the
console itself: **Details** on its header shows or hides it. The tool's own
page, with no document, only says to open a connection from the sidebar.
Everything that reaches the engine goes through the sidebar, which holds the
tool's one connection; the documents hold none.

What is different there:

- **No chat and no uploads.** The editors do not pass a chat question or a
  file upload on for a dev tool, so the chat area and the upload area say so
  and stay in place. Search, which needs no LLM, still works from the chat
  area. Open Vector Explorer as an app to ask questions or add documents.
- **Removals are confirmed in the document.** Move to trash, Delete
  permanently and Empty trash ask in a panel inside the console or the
  document that asked, with the same words and typed confirmations as the
  app's dialogs; Cancel has the focus and Escape cancels.
- **Documents follow each other.** A removal in one document refreshes the
  console of its connection (its listing, figures and map) and every open
  document of that connection; a document that was deleted says it is no
  longer stored, and one moved to the trash says so. A document scores its
  heat strip against the question its console shows, and compares its chunk
  count with the console's listing once the console has listed.
- **Show on map** in a document opens (or fronts) the console and highlights at
  most 200 chunks there (the node's `project_keys_max`); it says when it showed
  fewer than you asked for.
- **Exports and the clipboard.** Where the editor refuses a download, the export
  menu offers **Copy as CSV** or **Copy as JSON**; where it refuses the
  clipboard too, it shows the export to select and copy by hand. A refused copy
  of an objectId or of the map's keys is said, and the text is on screen.
- **Layouts.** The map's neighbour-graph and t-SNE layouts run in a worker,
  which a VS Code panel cannot start (it loads the app from the engine, another
  origin). The map then stays on PCA and says why.
- **Error codes in VS Code.** The sidebar does not receive the server's error
  codes there, so a call interrupted by a pipeline restart is reported as
  failed instead of being retried once, and a stopped pipeline and an
  unreachable one read the same. **Refresh** always checks every connection
  again.
- **Sizes.** An answer too large to send to a document (a sample above 1.5 MB,
  a listing page above 512 KB, a chunk page above 768 KB) is refused with a
  reason; draw a smaller sample.
- **Hidden documents.** A console in a VS Code panel that is not visible stops
  paging and refreshing its figures until it is shown again; in the RocketRide
  workspace a console in a background tab keeps them.
- **Account changes.** When the signed-in user, organization or team changes,
  every console and document closes, as in the app.
- **Before it can open,** a document says what it waits for: the server
  connection (**Not connected**, or **Waiting for the server connection…**),
  the sidebar (**Starting Vector Explorer…**, then **Open the Vector Explorer
  sidebar to connect** if it does not come), sign-in (**Waiting for sign-in**),
  or its connection (**Looking for this connection**, **This connection is not
  listed**).

## Privacy

- The app never saves a task token, a connection string or a document's
  content. Chat history keeps your questions only, and is cleared with the
  connections.
- When a pipeline run is traced, the run log keeps each tool call's input and
  the first 2 KB of its output. That includes chunk text the console listed,
  the cluster names a sample carries (up to five words each, taken from the
  chunks' own text) and, for the one tool that returns stored vectors
  (`vectors`, at most two at a time), the first values of those vectors.
- Exports you download contain paths, chunk numbers, scores and the short
  snippets shown on screen; never a vector, a token or a connection detail.
- Saved filters and saved views live in memory for the session, per
  connection, and are gone when you sign out; nothing is written to the
  browser's storage.
- As a dev tool nothing is stored at all: no history and no preference, on the
  server or in the editor. Saved filters and views last until the document's
  panel closes in VS Code, and until the page reloads in the RocketRide
  workspace.

## What it does that the stores' own consoles do not

Within one app, across pgvector, RocketRide Vector, Qdrant and Chroma: a search
surface, one click from the chat, with semantic, keyword and fused modes and a
threshold slider that shows what the node's setting would keep; a text question
placed on the map with rays to the chunks the store really ranks first, and two
questions compared side by side; the collection's clusters named by their own
words; the neighbour graph and its spanning tree drawn over the sample;
near-duplicate groups moved to the trash in one confirmed batch with the rows
reported, and a trash to restore them from; a
folder, file-type or date scope that applies to the documents, the map, the
search and the chat; charts of chunks per document, chunk length, file types
and ingest time; and CSV, JSON and PNG exports of what you see. The map draws at
most 2,000 points with text or 5,000 without, and says when it was drawn from
the first 500 documents of a larger collection; Qdrant's own visualiser draws
more points. On Qdrant the neighbour graph of a sample of up to 500 points is
computed by Qdrant itself; a larger sample, such as the default 1,000, gets the
store node's graph, and the legend says which one computed it.

## Limits

- **Read-only cards cannot add documents or change the trash.** Start the
  pipeline's Tools source to manage it.
- **Deleting permanently cannot be undone.** A document moved to the trash can
  be restored; one deleted permanently (or by Empty trash) can only be added
  again.
- **Counts are what the store returns.** A store that cannot count shows "—";
  the app never estimates a count.
- **No cancel.** A request the app stops waiting for may still finish on the
  server; refresh to check.
- **Elasticsearch and OpenSearch** are not supported.
- **Experimental stores** (Milvus, Weaviate, Pinecone, Astra DB, MongoDB Atlas)
  were checked against stand-ins only.
- **The map's analysis is of its sample.** Clusters, duplicates, outliers and
  edges cover the sampled chunks; draw a larger or light sample to cover more.
  A collection of more than 500 documents is sampled from the first 500 the
  store lists, unless a scope names the documents, and the legend says so.
- **Scopes and filters.** pgvector filters the documents in the store; Chroma
  filters by first chunk only and Qdrant not at all, so the app filters the
  rows it has loaded there and says so. The map, the search and the chat take a
  scope of at most 2,000 documents.
- **Keyword search** depends on the store: pgvector and Chroma match text
  fragments, Qdrant whole words, Pinecone none. Hybrid results are fused in the
  browser, not by the store.
- **Saved filters and views last for the session.** They are not kept across
  sign-ins or browsers.
- **As a dev tool, no chat and no uploads** (see [As a dev tool](#as-a-dev-tool)).
  Open the app for both.
