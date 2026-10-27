# Vector Explorer

Vector Explorer is the console for a vector store your pipelines already
write to: see what the collection holds, list its documents in a sortable grid
with a folder tree, stage documents to move to the trash (and restore them, or
delete them for good), add new files, search, compare and ask questions over
what is stored, read what the store node reports about the collection, and map
the chunks to see which ones sit close together. It is
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
- **An LLM key, only for Ask.** The templates' LLM node carries the
  placeholder `replace-with-your-key`; replace it with your key, and set
  `base_url` only for an OpenAI-compatible server other than OpenAI. Until
  then Ask cannot answer; everything else works, Search and Compare included.
- **The trash is a node setting.** Each store node has **Allow document
  management from tool calls** (`allow_writes`). It is off unless the pipeline
  turns it on; the templates turn it on for `store_1` only. With it off, every
  control that stages, moves, restores or deletes documents is disabled and
  says why.

## Connections

The Connections page lists one card per store node a running Tools source
controls. A card is one button: the node's name, a state badge (**Checking**,
**Running**, **Stopped**, **Unreachable**, **No access** or **Needs upgrade**), a
line `<store> · <collection> · <pipeline>` (with "· 1,200 documents" once the
console has counted them) and its flags. Which of the pipeline's three sources run ("Sources: ingest running, chat running, tools running") is in the card's tooltip. The flags say
**Read-only**, **Experimental**, **Empty collection** (the collection does not
exist yet; add a document to create it; it goes away once the console's figures
show documents), **Repair needed** (the collection's control record is missing)
and **Metadata column pending** (pgvector: another session holds the table, so
file size and ingest time are not stored yet; the node retries).

`store_2`, the chat path's copy of the store, is never a card. SQL and graph
nodes are never cards.

A pipeline with vector stores but no running Tools source (for example the
stock RAG template, a webhook and a chat) is listed as a **Read-only** card,
anchored on its Chat source (or its Ingest source when chat is not running):
documents cannot be added or removed from there, and the card says so. A store
the anchor source cannot reach is shown **Stopped**, "Not reachable from the
chat source".

The drawer of a card describes the collection first: its name, documents and
chunks (once the console has counted them), embedding model, dimension, metric,
index and size. Then come the metadata fields read so far (or a line saying the
Collection tab reads them from a sample on request), **Sample chunks** (the
first chunks of the first document: two reads when the drawer opens, only for a
store that can hold documents, kept in memory until the console writes to the store or a refresh finds the store holding a different number of documents), **Quick actions** (**Browse documents**, **Search**, **Open map**, which
open the console on that tab) and, behind a collapsed **Connection details**,
the sources, pipeline, node, backend and its version, the embedding and LLM node
names, whether removing documents is on, the support level and any caveat. For
`rocketride_vector` it adds: "Shared table: every pipeline in this organization
that names table '<table>' reads and writes these rows." It never shows a host,
a connection string, a credential or a database name. The console's **Details**
shows the same panel.

Signing out, or a switch to another organization or development team, forgets
every connection, closes every console and document tab, and clears every
cache (documents, chunks, uploads, answers, samples and the selection).

## The console

Opening a connection opens its console, the main screen: a header, a row of
tabs, and one panel per tab.

- **Header.** The collection and its pipeline, then **Refresh**, **Details**
  and **Add documents**. **Refresh** counts the collection again, lists the documents again and probes the store node again, and says "Refreshing…" only for a refresh you asked for, not for the quick check that runs in the background; the button keeps one width. It is never disabled: where the connection cannot be opened it is marked unavailable, with the reason. When the store's last check failed, Refresh (and **Retry** on a banner, in Documents and in Trash) checks the store again before anything else. A store that did not answer is said to have "not answered when it was last checked", never to need an update of the node, and a listing that fails again keeps the last known rows, marked as such. A store's error text drops a leading exception name. **Details** shows or hides the connection's details inside the
  console: what a card's drawer shows on the Connections page, with **Test
  connection**. The header and the tab row do not move when a run starts or an
  answer arrives.
- **Tabs.** **Overview**, **Documents**, **Query**, **Map**, **Collection** and
  **Trash**; the Trash tab carries the store's count of documents with chunks in
  the trash ("Trash (3)"). The arrow keys move along the row and Enter or Space
  opens a tab, because a tab can call the store. A panel is built the first time
  its tab shows and then kept, so each tab keeps its state.
- **Banners**, under the tab row on every tab, for a lasting state: the console
  cannot open (the pipeline is stopped, you may not call its tools, or the node
  needs an upgrade); the store is unreachable (a refresh you asked for failed,
  two quick checks in a row failed, or nothing was ever read), with the reason
  and **Retry**; the collection has no control record, or was built with another
  embedding model than the chat's; writes are off, with the reason; the
  collection is empty ("No documents yet.", or "No documents outside the trash
  (3 in the Trash)." when the trash holds some, with **Add documents** where
  uploads can work, otherwise why they cannot). One failed quick check shows no
  banner: the Overview marks its figures "last known values".
- **Bottom line.** Under the panels, one line of a fixed height holds what comes
  and goes after a press, so nothing above it moves: the pending bar while
  documents are staged, otherwise the result of the last write (announced as a
  status, as an alert when it failed), or nothing. A finished write's line is cut
  to one line and has **Write details** beside it, a popup that opens above the
  line and stays inside the window, with the whole result sentence and then the store's audit of each batch (for moves to the trash and restores as well as deletes); Escape, a press outside it or a resize closes it.
  A result that lands while documents are staged shows first: a success for 6
  seconds, a failure or a write that did not do all it was asked (documents kept
  whole, or already gone) until the staged set changes or you press **Show
  pending**. It is never swapped out while the focus or the pointer is in it.
- **Removals are confirmed inline.** Applying staged documents, deleting them
  permanently and emptying the trash ask in a panel under the banners, in the
  app and in the dev tool alike; no window opens over the page for them. See
  [Documents](#documents) and [Trash](#trash). The one question that is still a
  window is the replace question of [Adding documents](#adding-documents), in the
  app.

### Overview

Cards across the top: **Documents**, **Chunks**, **Chunks per document**, **In
trash**, **Model**, **Dimensions · metric · index**, and **Size** where the
store reports one. The figures come from the node's `stats` tool: a full count
when the console opens, after a write (to or from the trash, a delete) or a
completed upload, and on **Refresh**, and a quick refresh at most every 15
seconds while the console is visible, which says "counts as of 12 s ago". A
figure the store cannot count shows "—" with a tooltip saying so (Pinecone
counts nothing per document). After a failed refresh the cards keep the last
known figures, marked "last known values". Chips name what qualifies the
figures: **Supported** or **Experimental**, **Brute-force search**, **Writes
on** or **Writes off**, **Read-only**, **N without first chunk**, **N need
attention** and caveats such as "Scores are the backend's raw values, not 0–1."
While a scope is active a line says what it covers.

Under the cards, three views on a row of their own (the arrow keys show the
view they reach):

- **Summary**: **Top folders** (a folder counts its subfolders, as Documents'
  folder view shows it; documents, chunks and share of the chunks, the rest in
  one "Other folders" row; a folder opens Documents on it),
  **Document fields** (each field, its type and how many documents have a
  value), the chunk metadata fields once the Collection tab has read a sample of
  them, and **Quick actions** (**Add documents** where the mount can,
  **Browse documents**, **New query**, **Open map**).
- **Charts**: chunks per document, chunk length (from the map's sample),
  documents by file type and documents by ingest time. Clicking a bar sets that
  condition on the scope and opens Documents.
- **Insights**: the loaded documents that need attention, each with its flags,
  each opening its drawer in Documents. The tab says "Insights (3)", or
  "Insights (3+)" while the listing is not complete.

Everything counted from the documents says what it covers: "Over the 1,200
documents loaded so far." while the listing is incomplete, "Within the current
scope." while a scope filters it.

### Documents

The **Documents** tab is a folder rail, a grid, and a drawer.

- **Folder rail.** A tree of the loaded documents, grouped into folders by `/`
  and `\` (Windows drive letters and network shares are kept as roots; a bare
  file name goes under **Uploaded**), with **Tree** / **Flat**, **Collapse all**
  and **Refresh**, a root "All documents" and a **Trash (N)** item that opens the
  Trash tab. It follows the tree pattern of the keyboard: arrows, Home, End,
  Enter, type-ahead. Clicking a folder is a view filter over the rows already
  loaded: nothing is listed again, the scope does not change, and sibling folders
  stay. **Scope search, map and Ask to this folder** (beside the grid's status
  line) is the separate, explicit action: it adds the folder to the scope for
  search, the map and Ask, and leaves the list as it is (its label names the
  list too only when the scope already applies to it, and then the list is
  listed again with it). Where the drawer
  and the grid would not both fit, the rail hides and **Folders** brings it back.
- **Grid.** One row per document, by its path: a staging tick, **Name**,
  **Folder**, **Type**, **Chunks**, **Tables**, **Size**, **Ingested**,
  **Health** and **Status** ("to Trash" while staged). A header sorts the column
  (ascending, descending, none); Up from the first row reaches the headers' sort
  buttons. The grid is a keyboard grid: Up, Down, Home,
  End, Page Up and Page Down move between rows, Enter opens the drawer and Space
  stages the row. Health says what is wrong with a document whose stored chunks
  look wrong (no first chunk, gaps in its chunk numbers, soft-deleted chunks
  still stored, nothing parsed, far more chunks than the others); a cell reads
  "—" where the store does not report what the check needs, and is empty when no
  problem was found. A document is listed once; two with the same path are both
  listed, with their short ids.
- **Loading and counts.** The list loads its first page at once and keeps loading
  in the background up to 5,000 documents ("Loading documents… 1,200 of
  10,000"); in the store's order, rows are re-sorted only when loading ends or pauses, so nothing moves under the pointer; a column you sort by is re-sorted as pages arrive. Past 5,000 the footer says "Limit reached at 5,000
  documents; more may exist" with **Load more**. While the listing is incomplete
  and the grid is in an order other than the store's own, a note says "Sorted
  within the 1,200 loaded documents; more may exist." When a store sends back
  documents already listed instead of the next page, loading stops there and the
  footer says that too. The footer and the status line count what is loaded; they
  never state a total the store did not give.
- **Scope**: the row above the grid starts with the path box ("Filter paths…")
  and adds **Add condition** (*Folder is under*, *File type is*, *Ingested
  after/before*, *Chunks between*, *Has tables*, *Missing first chunk*) and
  **Saved**. With no condition it is one row. A scope applies to the documents,
  the map, the search and the chat (**Apply to**: Documents, Map, Search, Chat;
  the Chat toggle covers Ask), and says who filtered: "12 documents match (store)"
  where the store applies the conditions, "12 of 1,200 loaded match (filtered
  here; the store cannot filter by these)" where it cannot. The map, the search
  and Ask take at most 2,000 documents; a larger scope says so and leaves them
  unscoped. The scope reaches them as the ids of the documents it covers,
  worked out from the documents loaded (on pgvector too) once the listing holds
  every document; until then Search waits and the map keeps the scope it drew
  with. **Save** keeps the conditions under a name for this connection until
  you sign out.
- **Drawer.** Selecting a row (or Enter, or a document in the rail) opens a
  drawer beside the grid: the first three loaded chunks (**Show all** the ones
  read, **More chunks**; each chunk has **Open at chunk** and **Map**), the
  metadata (path, objectId with **Copy**, chunks, tables, size, ingest time, node,
  deleted chunks where the store reports them), the document's health, and
  **Neighbours**: **Find similar** asks the store for the chunks nearest the
  document's first chunk that was read and lists the other documents among them,
  dropping the document's own chunks. The actions are **Show on map**, **Ask
  about this**, **Open document** and, apart, **Move to Trash**. Escape (in the
  drawer, or on a row) closes it and the focus stays on, or goes back to, the
  row. When a folder view or the review narrows the list, the export menu offers
  **Documents shown** beside the loaded and in-scope exports.
- **Move to Trash stages.** Ticking a row, **Stage all shown** or the drawer's
  **Move to Trash** only marks documents; nothing is sent. While anything is
  staged, a **pending bar** in the bottom line says "3 staged for the trash (14
  chunks)" ("14+ chunks" when the store did not count every document; its title
  has the whole sentence, "3 documents staged to move to the trash (14
  chunks).", and why Apply is unavailable when it is) with **Review** (Documents, listing only the staged documents), **Discard**
  (unstage all) and **Apply**. Apply asks once, inline: nothing is typed, because
  the Trash can restore them, and **Confirm** has the focus, except for more
  than 100 documents (or more than one batch of the store's limit), which opens
  with **Cancel** focused. Every staging press is announced ("3 documents are
  staged for the trash; nothing moves until the pending changes are applied."). It sends the
  documents in batches of at most 100; the first error stops the run and says
  what already ran. The map's review queues stage the same way ("Stage removal").
  A staged document the store no longer has leaves the set when the write
  answers ("N were already gone"); a relisting never changes the set. When
  writes are off, the staging controls are unavailable and say why.

### Trash

The **Trash** tab lists the documents with chunks in the trash (on stores that
list the trash by first chunk it says so) in the same kind of grid, with a path
box, an export menu and the store's own count. **Restore** (on a row, or
**Restore selected**) brings documents back at once. **Delete permanently** (on a
row, or **Delete selected permanently…**) and **Empty trash…** remove documents
from the store for good, after an inline confirmation that does not focus the
destructive button. Deleting a document sends `delete` with `deleted_only`, so a document that still has chunks outside the trash is kept whole: none of its chunks, in the trash or not, is deleted. The answer names the documents it kept, by path. Typing: one document asks for its file name
(for a document with no path, `1`; the full path is always shown beside the box);
several documents, or Empty trash, ask for their count; Enter confirms once what is typed matches, and before that a line under the field says what is missing ("Nothing is typed yet." or "What is typed does not match."); on `rocketride_vector`
the permanent deletes ask for the table name instead, because the table is
shared by every pipeline of your organization that names it. A document in the trash says "This document is in the trash. Restore it to read it." until it is restored. The grid's headers fit their words, and a row of a partly trashed document says "4 chunks outside the trash" (or "chunks outside the trash" where the count is not known), as far as the loaded documents say.

### Query

The **Query** tab has three modes on a row of its own, **Search**, **Compare**
and **Ask**, and at the end of the row **New query** and **History (N)**. Every
mode stays built while another shows, so a question and its results survive a
switch.

- **Search** needs no LLM. A question box (up to 1,000 characters; a longer one
  handed in is cut, and the box says so), a mode, how many results, a table
  choice and **Run**. The modes are Semantic, Keyword ("matches text fragments"
  or "matches whole words" where the store can; "This store cannot search by
  keyword" elsewhere), Hybrid (a semantic and a keyword search, fused in the
  browser by their ranks) and Auto; a mode the store or the embedding node
  cannot serve is disabled with the reason. The table choice (any chunks, tables
  only, no tables) is sent to the store as `isTable`. The scope is shown, not
  edited, here: **Edit in Documents** changes it. A **Will run** line says what
  Run will send before you press it.
- **Results** show rank, document, chunk, score, whether the node's threshold
  would keep the row, a 120-character preview, and **open** (the document's own tab at that chunk), **map** and **ask**, which stay on one line; a document's name shows it in the Documents tab's drawer. Rows are one line each, with a short status (passes, near miss, below floor, keyword match) whose meaning a legend line above the table gives. A Hybrid run adds a **Found by** column (the semantic and keyword ranks). The Score heading gives the scale from the
  store's `dialect.score` (formula, range, which direction is closer); a bar is drawn only where the store reports a range (higher is closer unless the store says lower is), inverted where lower is closer, and otherwise there is the number alone with the reason. A row found
  by keyword only has no score and no bar; a Hybrid row that the semantic search
  also found keeps its semantic score and bar.
- **Threshold.** The slider runs over the store's score range and marks the rows
  in place; it never searches again. It shows how many rows would pass ("At 0.42:
  7 of 20 would pass (today's node setting 0.30 passes 11)") and announces the
  count when you let go. **Copy as node setting** copies `threshold_search: 0.42`
  to set on the store node in the pipeline editor; nothing else of a node's
  settings is copied, and the app cannot change them. The store returns the top
  rows whatever their scores; the threshold only marks them here.
- **Compare** runs a second question beside the first and reports what the two
  share ("A and B share 4 of 10 results (Jaccard 0.25); 3 documents only in A, 2
  only in B"); the map draws both as stars: B is placed after A, and the status line says when B could not be placed.
- **Ask** is the question over the stored documents through the pipeline's LLM
  (up to 4,000 characters, one at a time). The answer lists the chunks it was
  given, each with **open** and **map**; "Why these?" under an answer shows the
  candidates the search weighed, and **Open in Search** opens Search with the
  answer's question and its cited chunks marked. Ask says why it cannot run (no
  running Chat source; the dev tool) and offers **Use Search**.
- **History** is an aside beside the modes. Every finished run is recorded: its
  question (for Compare, A and B), its kind, k, what it came to, when and how
  long. A run that repeats the newest entry's kind (for a Search, its mode), question and top-k updates that entry ("Ran again"), a Compare only when both its questions repeat; a run in another mode or with another top-k is a new entry, and so are a Search, a Compare and an Ask of the same text. **Load** puts an entry back in the form and
  runs nothing; **Rerun** runs it again with its mode and k and the threshold,
  scope and table choice you have now (it is off, with the reason, when it
  cannot run); entries can be pinned, annotated and removed, filtered (All runs,
  Search, Compare, Ask, Pinned), **Record runs** turns recording off, and
  **Clear…** asks inline. A Compare's question B is held whole in memory for the
  session only; after a reload the entry says "Question B isn't saved." The
  history keeps at most the first 200 characters of a question, and says so.

### Collection

The **Collection** tab is read-only: what the store node reports about the
collection. **Embedding** (model, dimensions), **Index** (metric,
index and its parameters, backend, how the score reads, the score threshold set
on the node) and **Storage and writes** (size, chunks, whether removing documents is on, whether delete moves to the trash, the write batch) come from the node's `dialect`, and Chunks from the console's statistics; where the node has not said, the console's last statistics
fill in the model, dimension and metric, and anything else reads "—".

**Metadata fields** is a table of Field, Type, Coverage, Example and
**Filterable**. No store lists a collection's fields, so the table has two
sources. Document fields (path, size, modified and ingest time, node, chunks, tables) are exact
over the documents loaded; the caption says "the 40 documents the current scope
keeps, of 1,200 loaded" while a scope applies, or "the 1,200 documents loaded".
Chunk metadata fields come only from **Read fields
from a sample**, which reads the first 20 chunks of up to 5 documents spread over
the loaded folders (at most 5 `chunks` calls); the table says how many chunks it
read from how many documents, that types are guesses and that coverage is of the
chunks read, not of the collection, and the result is dropped once documents are
written. **Filterable** says only what the node does: its listing filters are
applied by the store on pgvector and RocketRide Vector only (and only with a meta column for ingest
dates), Chroma applies none of these (only the first-chunk condition), and elsewhere they are matched over the
loaded rows; the node's search accepts filters on a few keys, of which the Query
tab offers only the table choice and the scope's documents.

### The document tab

A document tab shows one document with two views, **Reader** and **Chunks**.
Reader has its path, objectId, chunk count, size, type and ingest time where the
store keeps them, its health, and every chunk in reading order. Once a text
query is placed on the map (or an Ask answer is shown there), its heat strip
shows how similar each chunk is to that query; until then it says how to get
one. **Chunks** is a grid of the chunks read (#, text, chars, table, deleted,
and a score while a query has scored the document); sorting reorders only the
chunks read. A chunk opens a drawer with its text, its metadata (its own fields, without repeating the ids already shown), its nearest
chunks from other documents (the document's own are dropped; **Try again** when
the store is busy; none for a chunk in the trash) and the actions **Show on
map**, **Use as query** (the app only), **Open in reader** and **Move document to
Trash**. That move is asked at once, inline, naming this document's own path and chunk count: staging belongs to the console. What the write did shows in a fixed line at the bottom of the document (the console's rules, without a pending bar), and the document reads itself again after its own write. While every chunk is in the trash the tab offers **Restore** instead of Move to Trash (marked unavailable, with the reason, when writes are off).

## The map

The **Map** tab of a connection draws a sample of the chunks (up to 2,000 with
text, or 5,000 points without) positioned by their embeddings, so chunks that
say similar things sit close together. A text query is placed on the map with
rays to its true top matches; a point shows its 12 nearest chunks in the whole
collection; every action leads back to the console. Everything below works on
the sample the browser already holds, without asking the store again, unless it
says otherwise.

One toolbar row holds **Points** (Detailed: up to 2,000 points with text; Light:
up to 5,000 points, without their text), **Layout**, **Colour by**, **Query**,
**Table** (the same points as a list, for keyboard and screen-reader use, so it
stays on the row), **Advanced**, **Export** and **Views**. **Advanced** is a
panel that opens under its button and holds **Edges** (with **Per point** and
**Expand selected**), **Lasso**, **Fit**, **3D** and the **Sample**'s seed with
**New sample**; **Export** and **Views** open the same way, and all three stay
inside the window and close when it, or the panel holding them, is resized. A
status line of its own under the toolbar holds the busy words ("Sampling…") and
**Cancel** while a layout runs, and **Clear lasso selection**, **Clear
highlight** or **Clear selection** while something is lit, so nothing in the
toolbar moves when a run starts. Every map notice goes on this line, and a failure reads "Failed: …" (announced as an alert, and repeated in the legend's notes). Escape on the map does the same one step at a time: the lasso, then a highlight (an answer's sources, Show on map, a duplicate
group, a query's fading), then the selected point. Resizing keeps the zoom relative to the fit. Under the map, the legend (a box of a fixed height, 144 px, that scrolls inside itself) says how many of how many chunks are shown ("Showing 1,000 of 1,318
chunks (random sample) · 42 docs · seed 7") and shows a glyph for each kind of
mark that is drawn: similarity edges (fainter: less similar), the selected
point's nearest chunks, outliers, the query's star and rays, near-duplicate
pairs, and a shown duplicate group's rings.

- **Clusters**: connected groups of the sample's neighbour graph, named by
  their most frequent terms (computed by the store node). The **Clusters** tab
  lists them by size with **Show**, **Ask about these** (scopes Ask to
  their documents) and **Export**; **Minimum size** (2, 5 or 10) regroups
  instantly. **Colour by** offers Cluster, and also ingest date, file size,
  health, ingest node, table chunks, density and query similarity.
- **Edges** (under Advanced): off by default. **Neighbours** draws each point's
  strongest links (3, 5 or 10; 3 only, above 3,000 points of a light sample) and
  **Tree** the spanning tree of the neighbour graph. Each edge is drawn in an
  opaque colour measured to stand out from the background in every theme, and every line and edge the map draws spans at least 2 device pixels (the Canvas 2D fallback outlines a point with 1 px),
  fainter for a less similar pair; the links from the selected point are drawn
  (1.5 px) whether or not edges are on. Hovering a point thickens its edges and
  **Expand selected** adds the selected point's own. Selecting a point, a
  highlighted set (a lasso, a document, a duplicate group, an answer's sources)
  or a placed query fades the other points and the edges between them, and
  while the map is coloured by cluster (or the Clusters tab is open), hovering a point of a cluster fades the other clusters, and keeps them faded across the gaps between its points; what is faded is
  below the contrast the lit marks keep, on purpose.
- **Isolate** shows only the lasso selection or a cluster ("Showing 212 of
  1,000"), **Expand by neighbours** grows it by one ring, **Show all** brings
  the rest back.
- **Duplicates** is a review queue: near-duplicate chunks grouped by document,
  a similarity slider, a keep policy (oldest ingest, shortest path, most chunks
  or by hand), **Show group** (which rings both ends of each pair of the group
  and prints the pair's similarity with its scale, "cosine 0.99") and **Stage
  all N removals**, which puts the queued documents in the console's pending
  changes; the pending bar applies them.
- **Outliers** lists the sparsest points with why ("density 0.12 vs sample
  median 0.61"), the share to show (1, 2 or 5 %), **Mark reviewed** and
  **Stage removal**.
- **Recommend** finds chunks like the positive examples and unlike the
  negative ones (add them from a point's panel; best score where the store
  offers it, Qdrant).
- **Similarity matrix** of 2 to 100 selected points, with a table alternative
  and CSV export; it is computed by the store from the points' keys. Up to 12 ×
  12 the values are printed in the cells; above that each value is in its cell's
  title, and the table always holds every value. A legend reads "fainter" to
  "stronger".
- **Show full text** of a point, with the active question's words marked
  (lexical matches only; retrieval is by meaning).
- **Export**: the sample, the selection, the points shown, the clusters, the
  duplicates and the outliers as CSV or JSON, and the map as PNG with its
  legend, drawn as it is on screen at that moment (faded points included).
- **Views**: save the map's settings, selection and camera under a name and
  apply them again later in the session; a view keeps up to 2,000 selected
  points and redraws up to 200 of those the new sample lacks, and says how many
  it restored.

## Adding documents

**Add documents** in the console's header (or in Overview's quick actions, or in
the empty-collection banner) opens an aside beside the panels with the drop area:
drop files or folders, or use **Add files** / **Add folder**. Where uploads
cannot work it says why instead: a pipeline with no running Ingest source, a
read-only card, or a dev-tool mount. Closing it keeps an upload in flight
running; Escape or its close button closes it.

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
document; Documents, Query, the map and the other panels are tabs of the console. A connection's row shows its
state as a dot and, when it is not running or cannot be written, in words
(**Checking**, **Stopped**, **Unreachable**, **No access**, **Needs upgrade**,
**Read-only**); its tooltip names the store, the collection and the pipeline,
the sources that run, and why the console cannot be opened. Click a row, or
press Enter or Space on it, to open its console. **Refresh** is on the
Connections header, and a line under the rows says when discovery is running,
found nothing, or failed. What a card's drawer shows in the app (the state,
the sources and flags, **Test connection**, the store's details) is on the
console itself: **Details** on its header shows or hides it (the app's console
has the same button). The tool's own
page, with no document, only says to open a connection from the sidebar.
Everything that reaches the engine goes through the sidebar, which holds the
tool's one connection; the documents hold none.

What is different there:

- **No Ask and no uploads.** The editors do not pass a chat question or a
  file upload on for a dev tool. In **Query**, Ask says so and offers **Use
  Search**; **Add documents** opens with the reason uploads are not available.
  Search and Compare, which need no LLM, work as in the app. Open Vector Explorer
  as an app to ask questions or add documents.
- **Removals are confirmed inline.** As in the app, Apply, Delete permanently and Empty trash ask in a panel inside the console, and a document's Move to Trash asks inside that document, with the same words and typed confirmations; Escape cancels.
- **Query history is kept in memory.** History lists the runs of this document
  and says "Kept only while this document is open; nothing is saved."
- **Documents follow each other.** A removal in one document refreshes the console of its connection (its listing, figures and map), and any open document it names or that a write naming no document might have changed; a document that was deleted says it is no longer stored, and one moved to the trash says so. A document scores its
  heat strip against the question its console shows, and compares its chunk
  count with the console's listing once the console has listed. A document
  refreshes in place after a write that names it, or that names no document (a
  restore, a write whose outcome is unknown); a write that names other documents
  leaves it as it is.
- **Focus.** A console or document brought forward by a press (Show on map, open) takes the focus when nothing shown has it; a document restored at load, or opened behind, does not.
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

- The app never saves a task token or a connection string. In the full app the Query history is saved in your workspace file, for each connection: whether recording is on and, while it is, the first 200 characters of each question, tagged with its kind (a Search and its mode, a Compare or an Ask), its top-k, when it ran, how long it took, its result count or error, and its pin and note. Never the answers or results, the threshold, the scope, the table filter or a Compare's question B (held in memory for the session). A question can be
  chunk text, because **Use as query** (a chunk's drawer, in the app) puts a
  chunk's text in the Search box; the first 200 characters of it are what the
  history keeps. History says this in its footer (the app's note begins "Saved in your workspace file, for each connection: whether recording is on, and while it is, the first 200 characters of each question…"), and **Record runs** turns recording off. In a dev tool nothing is
  saved: the history is kept in memory and says "Kept only while this document
  is open; nothing is saved."
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
- As a dev tool nothing is saved, on the server or in the editor: the Query
  history is kept in memory while the document is open, and no preference is
  written. Saved filters and views last until the document's panel closes in
  VS Code, and until the page reloads in the RocketRide workspace.

## What it does that the stores' own consoles do not

Within one app, across pgvector, RocketRide Vector, Qdrant and Chroma: a search
surface, beside Ask in the Query tab, with semantic, keyword and fused modes, a
threshold slider that shows what the node's setting would keep, and a history
of runs; a text question
placed on the map with rays to the chunks the store really ranks first, and two
questions compared side by side; the collection's clusters named by their own
words; the neighbour graph and its spanning tree drawn over the sample;
near-duplicate groups staged and moved to the trash in one confirmed batch with
the rows reported, and a trash to restore them from; a
folder, file-type or date scope that applies to the documents, the map, the
search and Ask; charts of chunks per document, chunk length, file types
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
  the app never estimates a count. Documents lists, and the Overview counts,
  only the documents loaded so far, and say so; the footer never states a
  total the store did not give.
- **The chunk metadata fields are an estimate.** No store lists a collection's
  fields; the Collection tab reads a few chunks (up to 5 documents, 20 chunks
  each) when asked and says what it read.
- **No cancel.** A request the app stops waiting for may still finish on the
  server; refresh to check.
- **Elasticsearch and OpenSearch** are not supported.
- **Experimental stores** (Milvus, Weaviate, Pinecone, Astra DB, MongoDB Atlas)
  were checked against stand-ins only.
- **The map's analysis is of its sample.** Clusters, duplicates, outliers and
  edges cover the sampled chunks; draw a larger or light sample to cover more.
  A collection of more than 500 documents is sampled from the first 500 the
  store lists, unless a scope names the documents, and the legend says so.
- **Scopes and filters.** pgvector and RocketRide Vector filter the documents in the store; Chroma
  filters by first chunk only and Qdrant not at all, so the app filters the
  rows it has loaded there and says so. The map, the search and Ask take a
  scope of at most 2,000 documents. A folder chosen in the Documents rail only
  filters the loaded rows; the scope is set by **Scope search, map and Ask to
  this folder**.
- **Keyword search** depends on the store: pgvector and Chroma match text
  fragments, Qdrant whole words, Pinecone none. Hybrid results are fused in the
  browser, not by the store. The Search and Compare boxes take 1,000
  characters, Ask 4,000.
- **Saved filters and views last for the session.** They are not kept across
  sign-ins or browsers.
- **As a dev tool, no Ask and no uploads** (see [As a dev tool](#as-a-dev-tool)).
  Open the app for both.
