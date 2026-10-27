---
title: Vector Explorer
---

# Vector Explorer

Vector Explorer is the app for managing the documents in a vector store your
pipelines already use. Its main screen is a console with six tabs. **Overview**
shows what the collection holds. **Documents** lists the documents in a sortable grid beside a folder tree, and stages documents to move to the trash.
**Query** searches the chunks, compares two questions and asks the pipeline's LLM
about the documents, and keeps a history of the runs. **Map** shows how close the
chunks are to each other and to a question you type. **Collection** shows what the
store node reports about the collection. **Trash** restores documents or deletes
them for good. Files are added from an **Add documents** aside.

It is not a database client of its own. Every request goes through a store node
inside one of your running pipelines, so it reaches exactly the collection that
node is configured for, with that node's settings. If apps are new to you, read
[Apps](/concepts/apps) first. What the app deliberately does not do is under
[Limits](#limits).

Vector Explorer is built for four stores, the ones with tests that run against
a live server: [PostgreSQL with pgvector](/nodes/store_postgres),
[RocketRide Vector](/nodes/rocketride_vector) (a managed RocketRide database:
your organization's, your team's or your own), [Qdrant](/nodes/store_qdrant) and
[Chroma](/nodes/store_chroma). [Milvus](/nodes/store_milvus),
[Weaviate](/nodes/store_weaviate), [Pinecone](/nodes/store_pinecone),
[Astra DB](/nodes/store_astra) and [MongoDB Atlas](/nodes/store_atlas) are
listed too, and are marked **Experimental**: in this build they were tested
against mock clients only.
[Elasticsearch and OpenSearch](/nodes/store_elasticsearch) are not supported and
are never listed.

Each connection shows the support level its node reports, in its drawer and as
a chip on the Overview tab: **Supported** when that store's tests
passed against a live server in this build, on a new collection and on one
written by an earlier release, and **Experimental** otherwise.

## Before you start

- **A pipeline laid out for Vector Explorer.** Nine starting pipelines, one
  per store (`postgres.pipe`, `rocketride_vector.pipe`, `qdrant.pipe`,
  `chroma.pipe`, `milvus.pipe`, `weaviate.pipe`, `pinecone.pipe`, `astra.pipe`,
  `atlas.pipe`), are kept in the RocketRide repository under
  `apps/vector-ui/templates`. They are not installed with the app, and none
  holds a password, a real key or a `project_id`. Each has three sources:
  - **Ingest** ([Drag & Drop](/nodes/webhook/dropper)): files sent here are
    parsed, chunked, embedded and written to the store. The app's **Add
    documents** aside uses it.
  - **Chat** ([Chat](/nodes/webhook/chat)): questions are embedded, matched
    against the store, and answered by an LLM, which also returns the chunks it
    was given.
  - **Tools** ([Tools](/nodes/webhook/tools)): the app's own requests (counts,
    the documents, the trash, the map).

  The pipeline has two store nodes on the same collection. `store_1` is the one
  Vector Explorer manages; `store_2` answers the chat. Give both the same
  connection settings and collection.

  Both store nodes carry the same retrieval threshold, a cosine similarity of
  0.3, written on that store's own score scale: `0.3` on pgvector, RocketRide
  Vector and Pinecone, which score a match by its cosine similarity, and
  `0.65` on Qdrant, Chroma, Milvus, Weaviate, Astra DB and MongoDB Atlas,
  which score it as (1 + cosine similarity) / 2. A question therefore cites
  the same chunks on every store, and one the documents do not cover cites
  none; **Why these?** lists the chunks that fell short. Change a threshold on
  the store's own scale; the store node's page describes it.
- **Saved as a project, so its sources are grouped.** The three sources are
  separate tasks, and the app groups them into one connection by the
  pipeline's `project_id`. Open a template, save its text as a new `.pipe` file
  in a VS Code workspace, and the editor gives it its own `project_id`, so two
  people importing the same template never share an identity. A pipeline
  started without one shows each source as its own card, and the drawer says
  "Other sources not found: save the pipeline with a project id so its sources
  are grouped."
- **All three sources running.** Start each source of the pipeline. From an
  SDK that is one `use()` per source; give the pipeline a `project_id` once and
  keep it, pass `ttl=0` if the pipeline should not stop after 15 idle minutes,
  and pass `use_existing=True` (TypeScript `useExisting: true`) so that starting
  a source that is already running hands back the running task instead of
  failing with "Pipeline is already running.":

  ```python
  import json

  pipeline = json.load(open('postgres.pipe'))
  pipeline['project_id'] = '…'  # one fixed id for this pipeline, e.g. a uuid4 you keep
  # client: a connected RocketRideClient
  for source in ('ingest_1', 'chat_1', 'tools_1'):
      result = await client.use(pipeline=pipeline, source=source, ttl=0, use_existing=True)
  ```

  `result['reused']` is `True` when the source was already running.
- **Your store's connection details.** Type them into the store nodes' forms.
  The app never shows them, and store nodes never return them. A `.pipe` file
  is plain JSON and keeps what you type as written, so treat it like any file
  that holds a password. `rocketride_vector` has none to type: it uses the
  managed RocketRide database its Database setting chooses.
- **A key for Ask's LLM.** The templates ship with the placeholder key
  `replace-with-your-key` and an empty `base_url` on the LLM node
  ([OpenAI-Compatible API](/nodes/llm_openai_api)). Replace the key, and set
  `base_url` only for an OpenAI-compatible server other than OpenAI. Until you
  do, every Ask answer is an error message: an empty `base_url` sends
  questions to OpenAI, which refuses the placeholder key, and the answer reads
  "**LLM error** — ValueError: Invalid API key." (offline, it names the failed
  connection instead). That is the expected state of a template whose key has
  not been replaced, not a fault in the app. Everything else (counts, the
  documents, adding documents, the trash, Search and Compare, the map) works
  without an LLM.
- **The trash needs the write switch.** Every vector store node that
  Vector Explorer lists reads an `allow_writes` setting, off by default. The
  Vector Explorer templates turn it on for `store_1` and leave it off for
  `store_2`. To turn it on in a pipeline of your own, set
  `config.<profile>.allow_writes` to `true` on the store component in the
  `.pipe` (for example `"local": { …, "allow_writes": true }`), then restart the
  pipeline. Every store node's form also shows it, as **Allow document
  management from tool calls** (on RocketRide Vector, next to **Allow writes
  through tools**). With it off, the
  trash buttons (and Restore, Delete permanently and Empty trash) are
  disabled and say why. Adding
  documents is not governed by this switch: it goes through the Ingest source,
  and anyone with the data permission on the ingest task can add documents.
  Agents that use a store as a tool are unaffected: an agent writes whenever
  the store's write tools exist (on RocketRide Vector, only while **Allow
  writes through tools** is on).
- **RocketRide Vector needs its tools turned on.** The RocketRide Vector node
  keeps its whole tool surface off until **Expose as tools** is on, and its
  write tools until **Allow writes through tools** is also on; both are off by
  default because the table is in a managed database. Vector Explorer reads a
  RocketRide Vector store through those tools, so its template turns **Expose
  as tools** on for both stores and **Allow writes through tools** on for
  `store_1` only. The chat's `store_2` has no write tools at all (**Allow writes
  through tools** off), so neither an agent nor a Tools source can write to it
  there. In a pipeline of your own, set `expose_tools` (and, to remove
  documents, `allow_write` and `allow_writes`) under `config.cloud`. On this
  node, **Allow writes through tools** is also the one switch for agent
  writes.
- **No Tools source? The card is read-only.** A pipeline with a vector store
  but no running Tools source, such as an ordinary RAG chat pipeline, is still
  listed, marked **Read-only** and reached through its Chat (or else Ingest)
  source. Overview, Documents, Query and the map work where the store answers
  them (Ask needs a running Chat source); adding and removing documents are
  disabled with the reason "No Tools source: documents cannot be added or
  removed from here".
- **Trying it without a model.** The repository's acceptance scripts include a
  local stub of an OpenAI-compatible server,
  `scripts/acceptance/vector-explorer/stub_llm.py`. It is a test stand-in, not
  a model: its answers start with `[STUB-LLM]` and prove only that retrieval
  reached the LLM node. The test fixtures rename the LLM node to "Local stub
  LLM" so Ask says which model answers. The stub logs every request, which
  includes document text, to its own `out/` folder.
- **Know what leaves the store.** Read [Privacy](#privacy) before adding
  anything sensitive, and [Where document paths come from](#where-document-paths-come-from)
  before trusting a path.

## Connections

The Connections page lists one card per store node that a running pipeline's
Tools source controls, so `store_2` never appears, and one read-only card per
store node of a running pipeline that has no Tools source. SQL and graph nodes
are never listed. A card is one button that opens the store's drawer. It shows:

- the store node's name, and a state: **Checking**, **Running**, **Stopped**,
  **Unreachable**, **No access** or **Needs upgrade**;
- a line `<store> · <collection> · <pipeline>`, with `· 1,200 documents` added
  once the console has counted them;
- notes when they apply: **Experimental**, **Read-only**, **Empty collection**
  (the collection does not exist yet; the first upload creates it; the note goes away once the console's figures show the collection exists), **Repair
  needed** (the collection's control record, which the store node writes when
  it creates the collection, is missing), and **Metadata column pending**
  (pgvector: file size and ingest time are not stored yet, see
  [What the notes mean](#what-the-notes-mean)).

Which of the pipeline's sources run ("Sources: ingest running, chat running, tools running", or "not running" for one that is not) is in the card's tooltip and its accessible
description, and in the drawer.

On a read-only card, a store node the anchor source cannot reach is shown
Stopped with "Not reachable from the chat source", or "Not reachable from the
ingest source" when the card is anchored on the Ingest source. When nothing is
listed, the page says "No running pipeline has a vector store. Start one of the
Vector Explorer templates (`templates/<store>.pipe`) and save it as a project,
then refresh."

Selecting a card opens a drawer that describes the collection first: its name,
documents and chunks (once the console has counted them), embedding model,
dimension, metric, index and size. Then come the metadata fields read so far (or
a line saying the Collection tab reads them from a sample on request), **Sample
chunks** (the first chunks of the first document: two reads when the drawer
opens, only for a store that can hold documents, kept in memory until the console writes to the store or a refresh finds the store holding a different number of documents), **Quick actions** (**Browse documents**,
**Search**, **Open map**, each opening the console on that tab) and a
sentence per note. Behind a collapsed **Connection details** are the roles, the
pipeline, the node, the backend and its version, the embedding and LLM node
names, whether removing documents is on and the support level. For
`rocketride_vector` it adds: "Shared table: every pipeline in this organization
that names table '`<table>`' reads and writes these rows." From a pipeline's
configuration the app shows only the provider, the node name, the pipeline name
and the collection. The console's **Details** button shows the same panel.

## The console

Opening a connection shows its console: a header, a row of tabs (**Overview**,
**Documents**, **Query**, **Map**, **Collection** and **Trash**) and one panel
per tab. A panel is built the first time its tab shows and then kept, so a tab
keeps what you did in it.

The header names the collection and its pipeline and has three buttons.
**Refresh** counts the collection again, lists the documents again and asks the store node about itself again; it says "Refreshing…" only for a refresh you asked for, not for the quick check that runs in the background, and the button keeps one width. It is never disabled: where the connection cannot be opened it is marked unavailable, with the reason. When the store's last check failed, Refresh (and **Retry** on a banner, in Documents and in Trash) checks the store again first. A store that did not answer is said to have "not answered when it was last checked", never to need an update of the node, and a listing that fails again keeps the last known rows, marked as such. The banner's error text for an unreachable store drops a leading exception name. **Details**
shows or hides what a connection's drawer shows on the Connections page, with
**Test connection**, inside the console. **Add documents** opens the upload
aside (see [Adding documents](#adding-documents)). The header and the tab row do
not move when a run starts or an answer arrives; the arrow keys move along the
tab row and Enter or Space opens a tab, because a tab can call the store.

Under the tab row, on every tab, banners say what lasts: the console cannot open
(the pipeline is stopped, you may not call its tools, or the node needs an
upgrade); the store is unreachable (a refresh you asked for failed, two quick
checks in a row failed, or nothing was ever read), with the reason and **Retry**
("The Overview keeps the last figures read."); the collection has no control
record, or was built with another embedding model than the chat's; writes are
off, with the reason; or the collection is empty ("No documents yet.", or "No
documents outside the trash (3 in the Trash)." when the trash holds some, with
**Add documents** where uploads can work, and otherwise why they cannot). One
failed quick check shows no banner: the Overview marks its figures "last known
values".

Under the panels, one line of a fixed height holds what comes and goes after a
press, so nothing above it moves. While documents are staged it is the pending
bar; otherwise it is the result of the last write, announced as a status (as an
alert when the write failed), or nothing. A finished write's line is cut to one
line and has **Write details** beside it, a popup that opens above the line and
stays inside the window, with the whole result sentence and then the store's
audit of each batch (for moves to the trash and restores as well as deletes); Escape, a press outside it or a resize closes it. A result
that lands while documents are staged shows first: a success for 6 seconds, a
failure or a write that did not do all it was asked (documents kept whole, or
already gone) until the staged set changes or you press **Show pending**. It is
never swapped out while the focus or the pointer is in it.

Every removal is confirmed in a panel inside the console or the document that
asked, under the banners, in the app and in the dev tool alike; no window opens
over the page for it. The one question that is still a window is the replace
question of [Adding documents](#adding-documents), in the app.

### Overview

Cards across the top: **Documents**, **Chunks**, **Chunks per document**, **In
trash**, **Model**, **Dimensions · metric · index** and, where the store reports
how much space the collection takes, **Size** (for example 48.2 MB; its tooltip gives the bytes). They are
counted when the console opens, after every write (moving to or out of the trash,
deleting) or completed upload, and on **Refresh**. While the console is visible a
lighter check runs at most every 15 seconds and the strip says "counts as of N s
ago". Numbers the node did not return are shown as "—" with a tooltip, never
estimated: Pinecone, for example, cannot count. After a failed refresh the cards
keep the last known figures, in italics, marked "last known values".

Chips under the cards name what qualifies the figures: **Supported** or
**Experimental**, **Brute-force search**, **Writes on** or **Writes off**,
**Read-only**, "N without first chunk", "N need attention" and the notes under
[What the notes mean](#what-the-notes-mean). "N need attention" counts the
documents whose stored chunks look wrong (see [Documents](#documents)); its
tooltip breaks the number down, for example "2 without first chunk · 1 with
deleted chunks", and says how many documents it was counted over. While a scope
is active the strip adds "Scope: 12 of 42 documents · 318 chunks (counted
here)".

Three views sit on a row of their own under the chips; the arrow keys show the
view they reach.

- **Summary.** **Top folders** lists the folders of the loaded documents, each
  counting its subfolders as Documents' folder view shows them, with their
  documents, chunks and share of the chunks, the rest in one "Other folders" row;
  a folder opens Documents on it. **Document fields** lists each
  field the documents carry, its type and how many have a value, and, once the
  Collection tab has read a sample, the chunk metadata fields too.
  **Quick actions** are **Add documents** (where the mount can), **Browse
  documents**, **New query** and **Open map**.
- **Charts** opens four small charts: chunks per document (log-scale bins), chunk
  length (from the map's sample: "Draw the map's sample to see chunk lengths"
  until there is one), documents by file type and documents by ingest time (day,
  week or month, depending on the span; off on a store that does not keep ingest
  times). Each says what it covers ("1,200 of 10,000 documents loaded") and has a
  table alternative; clicking a bar sets that condition on the scope and opens
  Documents.
- **Insights** lists the loaded documents that need attention, each with its
  flags; one opens its drawer in Documents. The tab says "Insights (3)", or
  "Insights (3+)" while the listing is not complete.

Counts made from the documents say what they cover: "Over the 1,200 documents
loaded so far." while the listing is incomplete, and "Within the current scope."
while a scope filters it.

### Documents

The **Documents** tab has a folder rail on the left, the grid, and a drawer that
opens beside the grid.

Every document is listed once, by its path. Two documents with the same path are
both listed, with their short ids. The grid's columns are a staging tick,
**Name**, **Folder**, **Type**, **Chunks**, **Tables**, **Size**, **Ingested**,
**Health** and **Status** (which says "to Trash" while the document is staged);
a column header sorts it, ascending, then descending, then not at all. The grid
works from the keyboard: Up, Down, Home, End, Page Up and Page Down move between
rows, Enter opens the drawer and Space stages the row; Up from the first row
reaches the headers' sort buttons. When a folder view or the review narrows the
list, the tab's export menu offers **Documents shown** beside the loaded and
in-scope exports.

**Health** says what is wrong with a document whose stored chunks look wrong,
with a badge per problem: *no first chunk* (chunk 0 is not stored: the document
was partly removed or partly ingested), *gaps* (chunk numbers are missing), *N
deleted chunks* (soft-deleted rows are still stored), *empty* (the parser found no
text) or *oversize* (more than ten times the median chunk count). Gaps and
deleted chunks are reported by pgvector stores; on other stores the cell reads
"—" and says these are not checked. An empty cell means no problem was found.

The first page loads at once, then the rest load in the background, up to 5,000
documents, with "Loading documents… 1,200 of 10,000". In the store's order the grid does not reshuffle while pages arrive and is re-sorted when loading finishes; a column sort places arriving rows as they come. Past 5,000 the footer reads "Limit reached at N documents; more may exist" with **Load more**; when a store cannot page its list, the line says so, without Load more. While the listing is incomplete and the grid is in
an order other than the store's own, a note says "Sorted within the 1,200 loaded
documents; more may exist." The grid and the rail count what is loaded and never
state a total the store did not give.

#### The folder rail

The rail shows the loaded documents as a tree, with folders built from `/` and `\`
(Windows drive roots included) and names without a folder grouped under
**Uploaded**. It has a **Flat** toggle (off: the tree), **Collapse all** and **Refresh**, a
root "All documents" and a **Trash (N)** item that opens the Trash tab, and works
from the keyboard (arrows, Home, End, Enter, type-ahead). Clicking a folder
filters the rows already loaded and nothing else: nothing is listed again, the
scope does not change and the sibling folders stay. **Scope search, map and Ask
to this folder** is the separate, explicit action: it adds the folder to the
scope for search, the map and Ask, and leaves the list as it is (the button names
the list too only when the scope already applies to it, and then the list is
listed again with it). When the
drawer and the grid would not both fit, the rail hides and **Folders** brings it
back, and a drawer that still does not fit moves under the grid.

#### Scope

The row above the grid starts with the path box ("Filter paths…") and carries
**Add condition** and **Saved**; with no condition it is that one row. The
conditions are *Folder is under* (also offered as "Scope search, map and Ask to
this folder"), *File type is*, *Ingested after* and *Ingested before* (off on a
store that does not keep ingest times), *Chunks between*, *Has tables* and
*Missing first chunk*. Each shows as a chip you can remove; with the first one,
**Apply to: Documents · Map · Search · Chat** appears, all on (the Chat toggle
covers Ask).

The tab then says who applied the conditions: "12 documents match (store)" when
the store filtered, "12 documents match (store; ingest dates filtered here)" when
it applied some, and "12 of 1,200 loaded match (filtered here; the store cannot
filter by these)" when the app filtered the rows it loaded. pgvector and RocketRide Vector stores filter in the store; Chroma filters by first chunk only; Qdrant and the
experimental stores do not, so the app filters there.

The map, the search and Ask are handed the scope as the ids of the documents it
covers, worked out from the documents loaded, on pgvector as well as elsewhere
and once the listing holds every document; until then Search waits and the map
keeps the scope it drew with. They take a scope of at most 2,000 documents. A larger one
says "Scope too large for the map, search and chat (2,340 documents; at most
2,000). Narrow the folder." and leaves them unscoped, with their toggles off.
**Save…** keeps the conditions under a name; **Saved** lists them with **Apply**
and **Delete**. Saved filters belong to the connection and are kept in memory for the session: a reload or a sign-out clears them (in a dev tool, closing the document does).

#### The drawer

Selecting a row, pressing Enter on it, or choosing a document in the rail opens
its drawer. It shows the first three loaded chunks (**Show all** the ones read,
**More chunks**), each with **Open at chunk** and **Map**; the metadata (path,
objectId with **Copy**, chunks, tables, size, ingest time, node and deleted
chunks where the store reports them); the document's health; and **Neighbours**,
where **Find similar** asks the store for the chunks nearest the document's first
chunk that was read and lists the other documents among them, with the document's
own chunks dropped. Its actions are **Show on map**, **Ask about this**, **Open
document** and, set apart, **Move to Trash**. Escape (in the drawer, or on a row)
closes it, and the focus stays on, or goes back to, the row.

### Adding documents

**Add documents** in the header, in Overview's quick actions or in the
empty-collection banner opens an aside beside the panels. Drop files or folders on
its drop area, or use **Add files** and **Add folder**. A folder keeps its
structure in the stored paths, and the **Store under folder** box puts a prefix in
front of every path. Accepted: PDF, DOCX, PPTX, XLSX, ODT, RTF, TXT, MD, CSV, HTML
and JSON, up to 20 files per drop, 50 MB per file and 200 MB per drop. The app
checks these before sending: a file over a limit is excluded, not ingested, and
its row says why. A drop with the same path twice is refused before anything is
sent. The aside stays open and keeps following an upload when you change tab;
Escape or its close button closes it. Where uploads cannot work (a pipeline
without a running Ingest source, a read-only card, a dev tool) it says why
instead.

Before sending, the app checks each path against the store. If a document
added through a Drag & Drop source has that path (see
[Where document paths come from](#where-document-paths-come-from)), it asks
"Replace existing '`<path>`' (N chunks)? The old chunks are removed when the
new file is stored." with **Cancel** focused. Each file
then shows queued, uploading, processing, and "N chunks added". A failed upload
says "Failed. The engine did not return the reason; the pipeline's run log
may. The document was not added." An upload that completes but leaves nothing
in the store, such as a PDF without text the parser can read, is looked up
again for a few seconds and then says "Not added: the pipeline stored no chunks
for this file." Files with the same name in different folders are sent one
after another so each row reports its own file.

When the Ingest source feeds more than one store node, the aside names the
others: "This pipeline's ingest also reaches: `<names>`".

Above the upload list, the drop is summed up as it runs: "Drop of 12 files: 9
added (341 chunks) · 2 replaced · 1 not added · 00:48". When it completes,
**Show new chunks on the map** places the new chunks on the map, up to 200 of
them as hollow points, and says "N of M new chunks placed" when it placed fewer
than were added.

### Query

The **Query** tab has three modes on a row of their own, **Search**, **Compare**
and **Ask**, and at the end of the row **New query** (it empties the Search form
and its results) and **History (N)**. Every mode stays built while another shows,
so a question and its results survive a switch.

#### Search

Search asks the store directly, without the LLM. Type a question (up to 1,000
characters; a longer one handed in is cut, and the box says so), choose a mode and
**Run**:

- **Semantic** embeds the question with the pipeline's embedding node and asks
  the store for the nearest chunks.
- **Keyword** asks the store for the text itself, where the store can: "Keyword
  search matches text fragments on this store" (pgvector, Chroma) or "… matches
  whole words on this store" (Qdrant). It is off, with "This store cannot search
  by keyword", elsewhere (Pinecone).
- **Hybrid** runs both and fuses the two rankings in your browser, by rank,
  labelled "fused in the browser"; the store has no hybrid search. **Auto** lets
  the store node choose.

A mode the store or the embedding node cannot serve is disabled with the reason.
Beside the mode are how many results to show (10 to start with) and a table
choice (any chunks, tables only, no tables), which is sent to the store as
`isTable`. The scope is shown and not edited here; **Edit in Documents** changes
it. Under the form a **Will run** line says what Run will send before you press
it, for example that the threshold only marks rows and the store returns the top
rows whatever their scores.

Results show rank, document, chunk, score, whether the node's threshold would keep
the row, a 120-character preview, and **open** (the document's own tab at that
chunk), **map** and **ask**, which stay on one line; a document's name shows it in the Documents tab's drawer. Rows are one line each, with a short status (passes, near miss, below floor, keyword match) whose meaning a legend line above the table gives, and a Hybrid run adds a **Found by** column (the semantic and keyword ranks). The Score heading gives the scale from the store's own
score definition (formula, range, which direction is closer). A bar is drawn only
where the store reports a range (higher is closer unless the store says lower is), inverted where lower is closer; otherwise there is the number alone, with the reason. A row found
by keyword only has no score and no bar; a Hybrid row that the semantic search
also found keeps its semantic score and bar.

The **Threshold** slider runs over the store's score range and re-marks the rows
as you move it; it never searches again: "At 0.42: 7 of 20 would pass (today's
node setting 0.30 passes 11)", with the score histogram under it, and the count is
announced when you let go. **Copy as node setting** copies `threshold_search:
0.42` and nothing else: set it on the store node in the pipeline editor; this
console cannot change node settings.

#### Compare

**Compare** runs a second question beside the first and says what they share: "A
and B share 4 of 10 results (Jaccard 0.25); 3 documents only in A, 2 only in B";
with the map open, both are drawn as stars (A ★, B ☆): B is placed after A, and the map's status line says when B could not be placed. An answer that arrives for a sample that has been replaced is not drawn, and the status line says so (for B, to show it again).

#### Ask

Ask a question about the documents (up to 4,000 characters, one at a time). The
answer comes with its **sources**: the chunks the store returned for the
question, with rank, path, chunk number and score (hover for the raw score and
how it is computed), expandable text, **open** (the document at that chunk) and
**map** (the chunk on the map). Answers are shown as plain formatted text: raw
HTML and remote images in an answer are not rendered.

**Why these?** re-runs the search with the question and shows every candidate:
the node's score threshold, the store's floor below which rows are dropped, the
near misses greyed out, and a histogram of scores. It is hidden when the
pipeline's embedding node cannot be reached from the app. **Open in Search** in
it opens Search with the answer's question and its cited chunks marked. The floor
is the store node's long-standing cut, on the same score scale as the threshold:
`0.2` on most stores (`0` on Pinecone). On pgvector and RocketRide Vector that
is a cosine similarity of 0.2, so off-topic chunks show up below it. On the
stores that score (1 + cosine similarity) / 2, such as Qdrant and Chroma, `0.2`
is a cosine of −0.6, which almost no chunk falls under: there, every chunk under
the threshold shows as a near miss and none as below the floor.

The app stops waiting after 120 seconds: "Stopped waiting after 120 s. The
pipeline may still be answering; there is no way to cancel it from here." Ask
names the LLM node. Where Ask cannot run (the pipeline has no running Chat source,
or this is a dev tool), it says why and offers **Use Search**.

#### History

**History (N)** opens an aside beside the modes with the runs of this connection,
newest first and pinned ones on top: the question (for Compare, A and B), its
kind, k, what it came to, when and how long. A run that repeats the newest entry's kind (for a Search, its mode), question and top-k updates that entry, which says "Ran again" (a Compare only when both its questions repeat), instead of adding one; a run in another mode or with another top-k is a new entry, and so are a Search, a Compare and an Ask of the same text, and Compare keeps each pair. **Load** puts an entry back in the form and runs nothing. **Rerun** runs it
again with its mode and k and the threshold, scope and table choice you have now;
it is off, with the reason, when it cannot run. Entries can be pinned, given a
note and removed; the filter offers All runs, Search, Compare, Ask and Pinned;
**Record runs** turns recording off (the entries kept stay); **Clear…** asks
inline. A Compare's question B is held whole in memory for the session only, and
after a reload its entry says "Question B isn't saved." History keeps at most the
first 200 characters of a question, and says so.

### Collection

The **Collection** tab is read-only: what the store node reports about the
collection. **Embedding** (model, dimensions), **Index** (metric, the index and its
parameters, backend and version, how the score reads, the score threshold set on
the node) and **Storage and writes** (size, chunks, whether removing documents
is on, whether delete moves to the trash, the write batch) come from the node's answer about itself (Chunks from the console's figures); where it has not said, the console's last figures fill in
the model, dimension and metric, and anything else reads "—".

**Metadata fields** is a table of Field, Type, Coverage, Example and Filterable.
No store lists a collection's fields, so it has two sources. The document fields
(path, size, modified and ingest time, node, chunks, tables) are exact over the documents loaded
("Document fields are exact over the 1,200 documents loaded; more are not loaded
yet."; while a scope applies, "…over the 40 documents the current scope keeps, of
1,200 loaded"). The chunk metadata fields come only from **Read fields from a sample**,
which reads the first 20 chunks of up to 5 documents spread over the loaded
folders (at most 5 requests) and says how many chunks it read from how many
documents, that the types are guesses and that coverage is of the chunks read,
not of the collection; a write to the store drops that result. **Filterable**
says only what the node does: its listing filters are applied by the store on pgvector and RocketRide Vector only (and only with a meta column for ingest dates), Chroma applies none of these (only the first-chunk condition), and elsewhere they are matched over the loaded rows; the node's search
accepts filters on a few keys, of which the Query tab offers only the table
choice and the scope's documents.

## Trash and removing documents

**Move to Trash** only stages. Ticking a row, **Stage all shown** or the drawer's
**Move to Trash** marks documents; nothing is sent. While anything is staged, a
**pending bar** in the bottom line says, for example, "3 staged for the trash (14
chunks)" ("14+ chunks" when the store did not count every document; its title has
the whole sentence, "3 documents staged to move to the trash (14 chunks).", and
why Apply is unavailable when it is). Every staging press on the map is announced ("3
documents are staged for the trash; nothing moves until the pending changes are
applied."); in Documents the pending bar's count is a live status. The bar offers **Review** (the Documents tab, listing only the staged documents),
**Discard** (unstage them all) and **Apply**. The map's review queues stage the
same way ("Stage removal", "Stage all N removals"), and a lasso's **Stage these
documents for the trash** too. When writes are off the staging controls are
unavailable and say why.

**Apply** asks once, inline: "Moves these 3 documents and their 14 chunks to the
trash of `<collection>`, in batches of at most 100; the first error stops the
rest. Restore them from the Trash." Nothing is typed, because the Trash can
restore them; **Confirm** has the focus, except for more than 100 documents (or
more than one batch of the store's limit), which opens with **Cancel** focused.
The app says what already moved if an
error stops the run. A staged document the store no longer has leaves the set when
the write answers ("N were already gone"); listing again never changes the set.
The document tab's own **Move document to Trash** is asked at once, with the same confirmation naming that document's own path and chunk count, because staging belongs to the console. What that write did shows in a fixed line at the bottom of the document (the console's rules, without a pending bar), and the document reads itself again after its own write. While every chunk is in the trash the tab offers **Restore** instead (marked unavailable, with the reason, when writes are off).

The **Trash** tab lists the documents with chunks in the trash, as the store
counts them (on a store that lists the trash by first chunk it says so), in a grid
with a path box and an export menu, and the tab's label carries that count, "Trash
(N)". **Restore** (on a row, or **Restore selected**) brings documents back at
once. **Delete permanently** (on a row, or **Delete selected permanently…**) and
**Empty trash…** ask first, and the confirmation does not focus the destructive
button: "Deletes this document and its N chunks from `<collection>`. If it still
has chunks outside the trash, it is kept whole. This cannot be undone; add the
file again to restore it." One document asks you to type its file name (`1` for a
document with no path; the full path is always shown beside the box); several
documents, or Empty trash, ask you to type their count. Enter confirms once what is typed matches; an Enter before that confirms nothing, and a line under the field says what is missing ("Nothing is typed yet." or "What is typed does not match."). **Empty trash…** lists the
whole trash first. Deleting sends `delete` for the trash only, so a document that
still has chunks outside the trash (a later upload added some after it was moved
there) is kept whole (none of its chunks, in the trash or not, is deleted), and the answer names it by path: "Emptied the trash:
deleted 12 documents permanently (140 chunks). 1 was kept whole, because it still
has chunks outside the trash: `<path>`." On `rocketride_vector` the permanent
deletes ask for the table name instead, because the table is shared by every
pipeline in the organization that names it. A document in the trash cannot be read
until it is restored: "This document is in the trash. Restore it to read it." The grid's headers fit their words, and a row of a partly trashed document says "4 chunks outside the trash" (or "chunks outside the trash" where the count is not known), as far as the loaded documents say.

After any of these the counts, both lists, the store's details (model,
dimension, index) and the map refresh, and the app says what happened, for
example "Moved `<path>` to the trash (N chunks)" or "Deleted `<path>`
permanently (N chunks)", with the number of chunks the store actually reported
(none when it cannot count them, as on Pinecone). If the request times out:
"The request may still complete on the server. Refresh to check." Writes are
never retried. The result line is announced as a status, and as an alert when the
write failed.

When the store refuses, the app says why:

| The store's answer | What the app says |
| --- | --- |
| Removal switched off | Removing documents is turned off on this store node (allow_writes). |
| Not a Tools source | Only a Tools source may remove documents. |
| The engine did not identify the caller | The engine did not identify this request, so the store refused the write. Update the engine to a version that supports the Vector Explorer. |
| The collection's control record | That record is the collection's control record and cannot be removed. |
| Anything else | The store refused this request; see the pipeline's run log. |

## The map

The **Map** tab draws a sample of the collection's chunks, each as a point,
placed so that chunks with similar meaning sit close together. It is hidden,
with the reason, when the store node cannot sample; the console is unaffected.

- **Toolbar.** One row holds **Points**, **Layout**, **Colour by**, **Query**,
  **Table**, **Advanced**, **Export** and **Views**. **Table** lists the same points for screen readers and keyboard use, so it stays on the row. The row never wraps: when it has no room, Export and Views, then Colour by, Layout and Points, move into **More ▾**.
  **Advanced** opens a panel under its button with **Edges** (and **Per point**
  and **Expand selected**), **Lasso**, **Fit**, **3D** and the sample's seed with
  **New sample**. **Export** and **Views** open the same way. These panels stay
  inside the window, and close when it, or the panel holding them, is resized.
  Under the row a status line of its own, always there at the same height, holds
  the busy words ("Sampling…") and **Cancel** while a layout runs, and **Clear
  lasso selection**, **Clear highlight** or **Clear selection** while something
  is lit, so nothing in the toolbar moves when a run starts.
- **Sample.** **Detailed** draws up to 2,000 points with a short snippet each;
  **Light** draws up to 5,000 points without text (the inspector fetches it on
  demand). The legend says "Light mode draws up to 5,000 points, without their
  text" (or "Detailed mode draws up to 2,000 points"), how many of how many
  chunks are shown, whether the sample is random or not uniform, how many
  documents they come from and the seed ("Showing 1,000 of 1,318 chunks (random
  sample) · 42 docs · seed 7"), and says so when the store returned fewer points
  than asked for. Below it a glyph
  names each kind of mark that is drawn: similarity edges (fainter: less
  similar), the selected point's nearest chunks, outliers, the query's star and
  rays, near-duplicate pairs and a shown duplicate group's rings. The legend collapses to one row ("▾ Legend"), kept for the session; open, it is a box of a fixed height (144 px) that scrolls inside itself, and its glyphs draw their lines at the canvas widths for the screen's pixel ratio.
- **Layout.** The first picture is a PCA projection computed on the node.
  **Neighbour graph** refines it in your browser by pulling each chunk towards
  its nearest neighbours, and is kept only when it preserves neighbours at
  least as well as PCA; otherwise the map says "Neighbour layout did not improve
  on PCA for this sample". **t-SNE** is offered up to 1,000 points. Both have a
  time limit and **Cancel**. The legend reminds you that 2D distance is
  approximate; ranks and scores are exact. On Qdrant the neighbour graph of a
  sample of up to 500 points is computed by Qdrant, and the legend says
  "neighbour graph computed by Qdrant"; a larger sample, such as the default
  1,000 points, gets the store node's graph, and the legend says "neighbour
  graph computed by the store node".
- **Query.** Type text and **Run**: the text is embedded by the pipeline's
  embedding node, drawn as a star, and joined by rays to its true top results
  from the whole collection, not only from the sample. This needs the embedding
  node to be reachable from the Tools source; otherwise it is disabled with the
  reason.
- **Point.** Hover shows the document and snippet. Click lists the 12 nearest
  chunks in the whole collection with their similarity; neighbours outside the
  sample are drawn hollow. **Open document**, **Find similar** and **Stage
  removal** act on it.
- **Answers.** The sources of an Ask answer light up on the map; sources
  outside the sample are added to it. The answer's question becomes the star:
  it is embedded by the pipeline's embedding node and placed like a query, with
  rays to its true top results. When that node cannot be reached from the
  Tools source, the star is the score-weighted centre of the sources instead,
  and the legend marks it approximate.
- **Lasso** (`L`, or under Advanced): select an area, then **Ask about these
  only**, **Stage these documents for the trash**, **Isolate** or **Copy keys**.
  The **Selection** tab also shows a **similarity matrix** of 2 to 100 selected
  points: a heatmap (the values are printed in the cells up to 12 × 12; above
  that each is in its cell's title and in the table), ordered so that close
  points sit together, read from "fainter: less similar" to "stronger: more
  similar", with a table alternative, **Export CSV** and **Show pair**. The store computes it from
  the points' keys, so a sample drawn again cannot shift it.
- **Clusters.** With each sample the store node groups the points (connected
  groups of the neighbour graph) and names the largest groups by their most
  frequent terms. **Colour by → Cluster** colours them; the **Clusters** tab
  lists them by size with their label, points and documents, and **Show**,
  **Ask about these** (scopes Ask to their documents) and **Export**; a
  **Noise** row lists the points in no group. **Minimum size** (2, 5 or 10)
  regroups at once, without asking the store again. The legend says how the
  groups were made, for example "Clusters: connected groups of the sample's
  neighbour graph above similarity 0.61 (the 60th percentile of its edges,
  computed by the store node), groups of at least 5 points; labels are the most
  frequent terms of up to 50 of their chunks."
- **Colour by** also offers file type, folder, chunk position, table chunks,
  ingest date, file size, health, ingest node, density and query similarity,
  each with a legend; a mode the data cannot support is off with the reason.
- **Edges** (under Advanced). Off by default. **Neighbours** draws each point's
  3, 5 or 10 strongest links (3 only, on a light sample of more than 3,000
  points) and **Tree** the strongest path connecting every point: the spanning
  tree of the neighbour graph, "2,000 points, 1,999 edges". Each edge is drawn in
  an opaque colour measured to stand out from the background in every theme,
  fainter for a less similar pair, and the links from the selected point are
  drawn heavier than the edges (3 px thick on a standard screen, 1.5 px on a high-density one) whether or not edges are on. Hovering a point thickens its
  edges; **Expand selected** adds the selected point's own. When frames get slow
  the map draws fewer edges and says so.
- **Dimming.** Selecting a point, a highlighted set (a lasso, a document, a
  duplicate group, an answer's sources) or a placed query fades the other points,
  and the edges, outlier rings and duplicate lines that touch only faded points,
  to a quarter of their colour; hovering a point of a cluster, while the map is coloured by cluster or the Clusters tab is open, fades the other clusters, and the cluster stays lit across the gaps
  between its points. The lit marks keep their colour, and what is
  faded is below the contrast they keep, on purpose. The PNG export shows what is
  drawn on screen at that moment.
- **Isolate, Show all, Expand by neighbours.** Show only the selection or a
  cluster ("Showing 212 of 1,000"), grow it by one ring of neighbours, or bring
  every point back. The keyboard and the layouts skip hidden points.
- **Duplicates.** Near-identical chunks are joined by a dashed line, and the
  **Duplicates** tab is a review queue: pairs grouped by document, each group
  with its similarity range, a **Keep** choice per document and a policy (keep
  oldest ingest, shortest path, most chunks, or choose by hand). The similarity
  slider (0.90 to 0.995) regroups at once, from each point's 15 nearest
  neighbours in the sample. **Show group** rings both ends of each pair of the
  group and prints the pair's similarity with its scale ("cosine 0.99");
  **Mark reviewed**, **Stage removal** (or "Stage 3 removals") and **Stage all N
  removals** follow: they put the documents in the console's pending changes,
  which the pending bar applies through the console's confirmation, and the Trash
  restores them. Repeated text inside one document is listed apart, with
  **Open** only.
- **Outliers.** Unusually isolated chunks are ringed, and the **Outliers** tab
  lists the lowest-density share of the sample (1, 2 or 5 %, chosen without
  asking the store again), each with why ("density 0.12 vs sample median 0.61;
  nearest neighbour 0.31 in `<path>`"), **Mark reviewed**, **Show neighbours**
  and **Stage removal**.
- **Recommend.** From a point's panel, **Add as example (+)** or **(−)**; the
  **Recommend** tab finds the chunks most like the positives and least like the
  negatives in the whole collection (**Average vector** everywhere; **Best
  score** on Qdrant, which ranks it itself), and can pin the results on the
  map. "+ current query" adds the text query as a positive.
- **Full text.** **Show full text** on a point shows its chunk with the active
  question's words marked: "Lexical matches only; retrieval is by meaning."
- **Heat strip.** The heat strip shows a document's chunks in order against the
  active query.
- **Export.** The map's **Export** menu saves the sample, the lasso selection,
  the points shown, the clusters, the duplicates or the outliers as CSV or
  JSON, and the map as a PNG with its legend and a footer; the Documents and Trash
  tabs and the search export their rows the same way. Files are named
  `vector-explorer_<collection>_<kind>_<date>.csv`; cells that start with `=`,
  `+`, `-` or `@` are guarded against spreadsheet formulas.
- **Views.** **Views → Save current view** keeps the sample size, mode and
  seed, layout, colouring, edges, minimum cluster size, query text, scope,
  selection (up to 2,000 points) and camera under a name; **Apply** draws the
  sample again with its seed and restores the selection: "1,340 of 1,900
  selected points restored; 200 drawn hollow" (up to 200 points missing from the
  new sample are drawn hollow, the rest are dropped). A saved query runs again
  only on **Run saved query**, because it costs an embedding. Up to 20 views
  per connection, kept in memory for the session: a reload or a sign-out clears them.
- **Keyboard.** The arrow keys move to the nearest point in that direction,
  Enter inspects it, Escape clears one step at a time: the lasso, then a
  highlight (an answer's sources, Show on map, a duplicate group, a query's
  fading), then the selected point.

Resizing keeps the zoom relative to the fit. Every map notice goes on the status line under the toolbar, and a failure reads "Failed: …" (announced as an alert, and repeated in the legend's notes). Every line and edge the map draws spans at least 2 device pixels (the Canvas 2D fallback outlines a point with 1 px).

The map works on positions and neighbour lists computed by the store node; the
browser never receives the raw embedding vectors of a sample.

## A document's tab

**Open** on a document, a source or a point opens the document's own tab, with two
views, **Reader** and **Chunks**. The header has the path, id (with a copy button),
chunk count, size, type and ingest time when the store keeps them, the document's
health (the problems listed under [Documents](#documents), each with a sentence,
or which stores report them) and a button to move the document to the trash,
which asks at once, inline, as described under
[Trash and removing documents](#trash-and-removing-documents).

**Reader** lists the chunks in reading order with table chunks tagged. **Show
chunk path on map** draws the document's chunks in order on the map. When a query
is active (a text query placed on the map, or an Ask answer shown there), a heat
strip above the chunks shows how similar each one is to it: the query is embedded
by the pipeline's embedding node and the store scores the document's chunks
against it. A chunk the store does not hold has no bar. Without a query, the tab
says how to get one.

**Chunks** is a grid of the chunks read, a page of 100 at a time: the chunk
number, its text, its length, whether it is a table or deleted, and a score
while a query has scored the document. Sorting reorders only the chunks read
("Showing 100 of 340 chunks; sorting reorders only these."). A chunk opens a
drawer with its text, its metadata (its own fields, without repeating the ids already shown), and its nearest chunks from other documents
(the document's own chunks are dropped; **Try again** when the store is busy; none
for a chunk in the trash), and the actions **Show on map**, **Use as query**
(the app only), **Open in reader** and **Move document to Trash**.

## What the notes mean

**Experimental** is the support level the store node reports: a store is
marked supported only after its tests against a live server pass. An
Experimental store also carries the first note below. Each note has one
sentence:

| When | The app says |
| --- | --- |
| The store is marked Experimental | Experimental: this store was checked against stand-ins only in this build. |
| The store searches exactly, without an index | This store searches by brute force (exact); large collections answer slowly. |
| The store cannot count with a filter (Pinecone, for example) | This store cannot count with a filter, so some figures are not shown. |
| The store's scores are not on a 0–1 scale | Scores are the backend's raw values, not 0–1. |
| Earlier releases reported this store's scores the wrong way round (Chroma; Qdrant and Weaviate with some metrics) | Scores on this store were inverted before this release; they now rise with similarity. |
| The map's sample is not uniform | This sample is not uniform: some documents are over-represented. |
| The store does not keep the extra file details | This backend does not keep file size or ingest time. |
| The store is a cloud service that was not checked against a live server | This backend was not run against a live server in this build. |
| The store counts documents by their first chunk | Documents are counted by their first chunk on this store. |
| More than 1,000 documents lack a first chunk | Orphan counts above 1,000 are not exact on this store. |
| The store lists documents unsorted | This store lists documents in storage order; Documents sorts what is loaded. |
| The store cannot page its document list | This store cannot page its document list; only the first page is shown. |
| The chat's embedding model is not the collection's | The chat embedding model differs from the one this collection was built with; results may be meaningless. |
| pgvector could not add its metadata column yet | File size and ingest time are not stored yet: another session holds this table; the store will retry. |
| The server runs pgvector older than 0.8, whose index search can stop short when a search is limited to some documents | A search limited to some documents may return fewer results than asked: this pgvector is older than 0.8. |
| The map's sample was drawn from the first 500 documents of a larger collection | Sampled from the first 500 documents by path; the collection has more |
| The store's document listing stopped early | Sampled from part of the collection: the store's listing stopped early |
| The store lists documents by their first chunk and its trash was too large to read to the end | The trash is large, so only part of it was read: a document moved to the trash during its upload may be missing from this list. |
| The store applied some of a scope's conditions | N documents match (store; ingest dates filtered here) |
| The store cannot filter documents | N of M loaded match (filtered here; the store cannot filter by these) |
| The store node does not compute clusters | This store node does not compute clusters; update the node. |
| The map drew fewer edges to stay smooth | Fewer edges drawn to keep the map smooth |

On RocketRide Vector the drawer also says that the table is shared; that
sentence is quoted under [Connections](#connections).

## Where document paths come from

The path a document shows is a label the store keeps with every chunk, written
by whatever added the document:

- **Added here**, it is the path of the file relative to what you dropped: a
  file's own name, or `folder/sub/file.pdf` for a folder, with the **Store
  under folder** prefix in front when you set one. Browsers do not tell a web
  page where a file sits on your disk, so a full path such as `C:/…` appears
  only if you typed it as the prefix. Paths are cleaned before sending: Unicode
  normalised, control and bidirectional characters removed, `..` and a leading
  `/` refused, each folder or file name at most 255 bytes. A file without a
  folder is listed under **Uploaded**.
- **Added by another pipeline**, it is whatever that pipeline's source
  recorded, for example a file-system path or an object-store key.

A path is not a location: the app never opens a file at that path, and the path
does not prove where the file is now or who added it. For a document added
through a Drag & Drop source (this app or another pipeline's), the document's id
is derived from its path, so adding a file under a path that is already stored
replaces that document, which is why the app asks first. A document another
kind of source recorded under the same path keeps its own id and is listed
beside the new one. Uploads from the app are tagged as coming from Vector
Explorer.

## As a dev tool

Vector Explorer also runs as a dev tool beside the pipeline editor, in VS Code
and in the RocketRide workspace. The sidebar lists your vector store
connections, each with its state; click one to open its console, and open a
stored document from the console as its own document. The console has the same
tabs as in the app. **Details** on its header shows what a connection's drawer
shows on the Connections page, with **Test connection**; the app's console has
the same button.

What is different there:

- **No Ask and no uploads.** The editors do not pass a chat question or a file
  upload on for dev tools, so both say so: Ask in the Query tab explains and
  offers **Use Search**, and **Add documents** opens with the reason uploads are
  not available. Search and Compare work as in the app. Open Vector Explorer as
  an app to ask questions or add documents.
- **Removals are confirmed inside the document** that asked, with the same words
  and typed confirmations as in the app, where they are inline too.
- **A document follows its console's writes.** A document tab refreshes in place
  after a write that names it, or that names no document (a restore, a write whose
  outcome is unknown); a write that names other documents leaves it as it is.
- **Focus.** A console or document brought forward by a press (Show on map, open) takes the focus when nothing shown has it; a document restored at load, or opened behind, does not.
- **History stays in memory.** The Query history lists this document's runs and
  says "Kept only while this document is open; nothing is saved."

- **Where downloads are refused**, the export menu offers to copy the CSV or
  JSON instead; where the clipboard is refused too, it shows the text to copy by
  hand.
- **The map stays on PCA** where the editor cannot start the layout worker,
  and says why.
- **Nothing is saved**: no preference is written, and the Query history lives
  in memory; saved filters and views last until the document (VS Code) or the
  page (RocketRide workspace) closes.

## Privacy

- **Only through your nodes.** The app sees what the pipeline's nodes return
  and nothing else. Store nodes never return a host, connection string,
  credential or database name.
- **Not through a Public Authorization Key.** The tools the app reads with
  (the store node's document list, chunks, vectors, samples, projections and
  neighbours, and the embedding node's `embed`) refuse a connection signed in
  with a pipeline's Public Authorization Key (`pk_…`, the key the chat widget
  uses): it gets "The store refused this request." (code `READS_PUBLIC`) and
  nothing is read. The app signs in with your account, so this never affects
  it.
- **Tokens stay in memory.** The tokens of the pipelines' tasks are kept in
  memory for the session only, never in history, preferences or anything saved.
  When you sign out, or switch organization or team, every connection, list,
  answer, map and selection is cleared.
- **Run log traces.** When a pipeline runs with any trace level other than
  `none` (`metadata`, `summary` or `full`), its run log records the first 2 KB
  of each tool call's input and of its output. Unlike lane data, a tool trace
  carries its input and output even at `metadata`, the level the Observability
  page lists as component enter/leave and object identities only. The VS Code
  extension starts runs with `full`, the MCP tools with `summary`, and an SDK
  `use()` with `none`; a deployment records at `full` unless its schedule sets
  a lower level. For Vector Explorer that means your map queries, document paths and
  ids, snippets of chunk text, and for a `vectors` answer (the one request that
  returns raw embedding values) the start of the raw vector. Ask's
  questions and the chunks passed to the LLM travel through the pipeline's
  lanes, which `summary` and `full` record too. Run logs are kept 7 days for
  development runs and 30 days for deployments; see
  [Observability](/guides/observability). If that matters, start the pipeline,
  or set the deployment's schedule, with the trace level `none`.
- **Query history.** In the app it is saved in your workspace file, for each connection: whether recording is on and, while it is, the first 200 characters of each question, tagged with its kind (a Search and its mode, a Compare or an Ask), its top-k, when it ran, how long it took, its result count or error, and its pin and note. Never the answers or results, the threshold, the scope, the table filter or a Compare's question B (held in memory for the session). History says so in its footer. A question can be chunk text, because **Use as
  query** in a chunk's drawer puts a chunk's text in the Search box; the history
  keeps the first 200 characters of it. In a dev tool it is kept in memory only,
  and says "Kept only while this document is open; nothing is saved."
- **Cluster names** are up to five words each, taken from the sampled chunks'
  own text by the store node; they travel with the sample like its snippets.
- **Exports** you download contain paths, chunk numbers, scores and the short
  snippets shown on screen; never a vector, a token, a host or a node setting.
- **Saved filters and views** are kept in memory for the session, per
  connection, and cleared on sign-out; nothing is written to the browser's
  storage.

## Limits

- **Deleting permanently cannot be undone.** A document moved to the trash can be
  restored; one deleted permanently (or by Empty trash) can only be added again.
- **No cancel on the server.** A question, an upload or a sample already
  running on the server cannot be cancelled from the app; it only stops
  waiting. A write that timed out may still complete. (A layout runs in your
  browser and has **Cancel**.)
- **Elasticsearch and OpenSearch** store nodes are not supported and are not
  listed.
- **Experimental stores.** Milvus, Weaviate, Pinecone, Astra DB and MongoDB
  Atlas are Experimental in this build: they were tested against mock clients
  only. Any store whose connection shows **Experimental** has not passed tests
  against a live server in this build. Pinecone cannot count documents or
  chunks and has no keyword search.
- **Size.** The map draws at most 2,000 points in detailed mode and 5,000 in
  light mode, and t-SNE at most 1,000. Documents loads 5,000 documents on its
  own; **Load more** goes further. Documents, Overview and the folder rail count
  only the documents loaded so far, and say so.
- **Metadata fields are an estimate.** No store lists a collection's fields; the
  Collection tab reads a few chunks (up to 5 documents, 20 chunks each) when asked
  and says what it read.
- **Question length.** The Search and Compare boxes take 1,000 characters, Ask
  4,000.
- **Uploads.** 20 files, 50 MB per file and 200 MB per drop, checked by the
  app before it sends anything; a file over a limit is excluded, not ingested.
  These are the only upload limits: the engine does not apply the templates'
  parser size setting in this release.
- **Read-only cards** cannot add documents or change the trash.
- **Answers need a model.** Ask needs a working LLM (a key, or a local
  OpenAI-compatible server); everything else does not.
- **The map's analysis covers its sample.** Clusters, duplicates, outliers and
  edges are found among the sampled chunks; draw a larger or light sample to
  cover more. An unscoped sample of a collection of more than 500 documents is
  drawn from the first 500 the store lists, and the legend says so.
- **Scopes** reach the map, the search and Ask up to 2,000 documents.
  Stores that cannot filter are filtered by the app over the rows it loaded. A
  folder chosen in the Documents rail only filters the rows loaded; **Scope
  search, map and Ask to this folder** sets the scope.
- **Keyword search and best-score recommendations depend on the store**: see
  [Search](#search) and the map's **Recommend**.
- **Saved filters and views last for the session.** They are not kept across
  sign-ins or browsers.

## Compared with the native consoles

Vector Explorer does not replace your database's own console. Within one app,
across pgvector, RocketRide Vector, Qdrant and Chroma, it gives you:

- a search surface, beside Ask in the Query tab, with semantic, keyword and fused
  modes, a threshold slider that shows what the node's setting would keep, and a
  history of runs;
- a text question placed on the map with rays to the chunks the store really
  ranks first, and two questions compared side by side;
- the collection's clusters named by their own words;
- the neighbour graph and its spanning tree drawn over the sample;
- near-duplicate groups staged and moved to the trash in one confirmed batch, with the rows reported, and a trash to restore them from;
- a folder, file-type or date scope that applies to the documents, the map, the
  search and Ask;
- charts of chunks per document, chunk length, file types and ingest time;
- CSV, JSON and PNG exports of what you see;
- Ask answers linked to the exact chunks they were given.

The map draws at most 2,000 points with text or 5,000 without, and says when it
was drawn from the first 500 documents of a larger collection; Qdrant's own
visualiser draws more points. On Qdrant the neighbour graph of a sample of up
to 500 points is computed by Qdrant itself; a larger sample gets the store
node's graph.
