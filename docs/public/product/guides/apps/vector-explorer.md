---
title: Vector Explorer
---

# Vector Explorer

Vector Explorer is the app for managing the documents in a vector store your
pipelines already use. Its main screen is a console: how many documents and
chunks the store holds, a directory of every document with a button to move it
to the trash (and the trash, to restore or delete for good), a drop zone that
adds files, and a chat that answers from those documents.
A second tab, the map, shows how close the chunks are to each other and to a
question you type.

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
a chip on the console's stats strip: **Supported** when that store's tests
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
    parsed, chunked, embedded and written to the store. The app's drop zone
    uses it.
  - **Chat** ([Chat](/nodes/webhook/chat)): questions are embedded, matched
    against the store, and answered by an LLM, which also returns the chunks it
    was given.
  - **Tools** ([Tools](/nodes/webhook/tools)): the app's own requests (counts,
    the directory, the trash, the map).

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
- **A key for the chat's LLM.** The templates ship with the placeholder key
  `replace-with-your-key` and an empty `base_url` on the LLM node
  ([OpenAI-Compatible API](/nodes/llm_openai_api)). Replace the key, and set
  `base_url` only for an OpenAI-compatible server other than OpenAI. Until you
  do, every chat answer is an error message: an empty `base_url` sends
  questions to OpenAI, which refuses the placeholder key, and the answer reads
  "**LLM error** — ValueError: Invalid API key." (offline, it names the failed
  connection instead). That is the expected state of a template whose key has
  not been replaced, not a fault in the app. Everything else (counts, the
  directory, adding documents, the trash, the map) works without an LLM.
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
  source. Counts, documents, chat and the map work where the store answers
  them; adding and removing documents are disabled with the reason "No Tools
  source: documents cannot be added or removed from here".
- **Trying it without a model.** The repository's acceptance scripts include a
  local stub of an OpenAI-compatible server,
  `scripts/acceptance/vector-explorer/stub_llm.py`. It is a test stand-in, not
  a model: its answers start with `[STUB-LLM]` and prove only that retrieval
  reached the LLM node. The test fixtures rename the LLM node to "Local stub
  LLM" so the chat header says what it is. The stub logs every request, which
  includes document text, to its own `out/` folder.
- **Know what leaves the store.** Read [Privacy](#privacy) before adding
  anything sensitive, and [Where document paths come from](#where-document-paths-come-from)
  before trusting a path.

## Connections

The Connections page lists one card per store node that a running pipeline's
Tools source controls, so `store_2` never appears, and one read-only card per
store node of a running pipeline that has no Tools source. SQL and graph nodes
are never listed. A card shows:

- the store node's name, then `<store> · <collection> · <pipeline>`;
- the roles: `ingest ✓ · chat ✓ · tools ✓`, with `–` for a source that is not
  running;
- a state: **Checking**, **Running**, **Stopped**, **Unreachable** or
  **No access**;
- notes when they apply: **Experimental**, **Read-only**, **Empty collection**
  (the collection does not exist yet; the first upload creates it), **Repair
  needed** (the collection's control record, which the store node writes when
  it creates the collection, is missing), and **Metadata column pending**
  (pgvector: file size and ingest time are not stored yet, see
  [What the notes mean](#what-the-notes-mean)).

On a read-only card, a store node the anchor source cannot reach is shown
Stopped with "Not reachable from the chat source", or "Not reachable from the
ingest source" when the card is anchored on the Ingest source. When nothing is
listed, the page says "No running pipeline has a vector store. Start one of the
Vector Explorer templates (`templates/<store>.pipe`) and save it as a project,
then refresh."

Selecting a card opens a drawer with the roles, the backend and its version,
the collection, metric, embedding model and dimension, the index, the embedding
and LLM node names, whether removing documents is on, the support level and a
sentence per note. For `rocketride_vector` it adds: "Shared table: every
pipeline in this organization that names table '`<table>`' reads and writes these
rows." From a pipeline's configuration the app shows only the provider, the
node name, the pipeline name and the collection.

## The console

Opening a connection shows its console: the stats strip across the top, the
document directory on the left, and on the right the drop zone above the chat.
Below 900 pixels wide the panels stack.

### Stats

Documents, chunks, deleted chunks, average chunks per document, the embedding
model and dimension, the metric and the index type. They are counted when the
console opens, after every write (moving to or out of the trash, deleting) or
completed upload, and on **Refresh**.
While the console is visible a lighter check runs at most every 15 seconds and
the strip says "counts as of N s ago". Numbers the node did not return are
shown as "—" with a tooltip, never estimated: Pinecone, for example, cannot
count. "N need attention" counts the documents whose stored chunks look wrong
(see [Documents](#documents)); its tooltip breaks the number down, for example
"2 without first chunk · 1 with deleted chunks".

**Charts**, at the end of the strip, opens four small charts: chunks per
document (log-scale bins), chunk length (from the map's sample: "Draw the map's
sample to see chunk lengths" until there is one), documents by file type and
documents by ingest time (day, week or month, depending on the span; off on a
store that does not keep ingest times). Each says what it covers ("1,200 of
10,000 documents loaded") and has a table alternative; clicking a bar scopes the
documents to it. Where the store reports how much space the collection takes,
a **Size** figure joins the strip ("48.2 MB on the store").

### Documents

Every document is listed once, by its path, with its chunk count, folders built
from `/` and `\` (Windows drive roots included). Names without a folder are
grouped under **Uploaded**. Documents whose stored chunks look wrong are listed
under **Needs attention**, each with a badge: *no first chunk* (chunk 0 is not
stored: the document was partly removed or partly ingested), *gaps* (chunk
numbers are missing), *N deleted chunks* (soft-deleted rows are still stored),
*empty* (the parser found no text) or *oversize* (more than ten times the median
chunk count). Gaps and deleted chunks are reported by pgvector stores; on other
stores the document's page says these are not checked. Two documents with the
same path are both listed; hover shows their short ids.

The first page loads at once, then the rest load in the background, up to
5,000 documents, with "Loading documents… 1,200 of 10,000". The list does not
reshuffle while pages arrive; it is re-sorted when loading finishes. Past
5,000, or when a store cannot page its list, the footer reads "Limit reached at
N documents; more may exist" with **Load more**.

#### Scope

The row above the directory starts with the path box ("Filter paths…") and
carries **Add condition** and **Saved**; with no condition it is that one row.
The conditions are *Folder is under* (also offered on a folder's menu as "Scope
to this folder"), *File type is*, *Ingested after* and *Ingested before* (off on
a store that does not keep ingest times), *Chunks between*, *Has tables* and
*Missing first chunk*. Each shows as a chip you can remove; with the first one,
**Apply to: Documents · Map · Search · Chat** appears, all on.

The directory then says who applied the conditions: "12 documents match
(store)" when the store filtered, "12 documents match (store; ingest dates
filtered here)" when it applied some, and "12 of 1,200 loaded match (filtered
here; the store cannot filter by these)" when the app filtered the rows it
loaded. pgvector stores filter in the store; Chroma filters by first chunk only;
Qdrant and the experimental stores do not, so the app filters there. While a
scope is active the stats strip adds "Scope: 12 of 42 documents · 318 chunks
(counted here)".

The map, the search and the chat take a scope of at most 2,000 documents. A
larger one says "Scope too large for the map, search and chat (2,340 documents;
at most 2,000). Narrow the folder." and leaves them unscoped, with their toggles
off. **Save…** keeps the conditions under a name; **Saved** lists them with
**Apply** and **Delete**. Saved filters belong to the connection and last until
you sign out.

Selecting a document lists its chunks, 100 at a time, each with its length and
a **map** button.

### Adding documents

Drop files or folders on the drop zone, or use **Add files** and **Add
folder**. A folder keeps its structure in the stored paths, and the **Store
under folder** box puts a prefix in front of every path. Accepted: PDF, DOCX,
PPTX, XLSX, ODT, RTF, TXT, MD, CSV, HTML and JSON, up to 20 files per drop,
50 MB per file and 200 MB per drop. The app checks these before sending: a
file over a limit is excluded, not ingested, and its row says why. A drop with
the same path twice is refused before anything is sent.

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

When the Ingest source feeds more than one store node, the panel names the
others: "This pipeline's ingest also reaches: `<names>`". Without a running
Ingest source, or on a read-only card, the panel says so instead.

Above the upload list, the drop is summed up as it runs: "Drop of 12 files: 9
added (341 chunks) · 2 replaced · 1 not added · 00:48". When it completes,
**Show new chunks on the map** places the new chunks on the map, up to 200 of
them as hollow points, and says "N of M new chunks placed" when it placed fewer
than were added.

### Chat

Ask a question about the documents (up to 4,000 characters, one at a time). The
answer comes with its **sources**: the chunks the store returned for the
question, with rank, path, chunk number and score (hover for the raw score and
how it is computed), expandable text, **open** (the document at that chunk) and
**map** (the chunk on the map). Answers are shown as plain formatted text: raw
HTML and remote images in an answer are not rendered.

**Why these?** re-runs the search with the question and shows every candidate:
the node's score threshold, the store's floor below which rows are dropped, the
near misses greyed out, and a histogram of scores. It is hidden when the
pipeline's embedding node cannot be reached from the app. The floor is the
store node's long-standing cut, on the same score scale as the threshold:
`0.2` on most stores (`0` on Pinecone). On pgvector and RocketRide Vector that
is a cosine similarity of 0.2, so off-topic chunks show up below it. On the
stores that score (1 + cosine similarity) / 2, such as Qdrant and Chroma, `0.2`
is a cosine of −0.6, which almost no chunk falls under: there, every chunk under
the threshold shows as a near miss and none as below the floor.

The app stops waiting after 120 seconds: "Stopped waiting after 120 s. The
pipeline may still be answering; there is no way to cancel it from here." The
chat header names the LLM node. The question history keeps your questions only.

### Search

**Search** in the chat's header ("Search without the LLM") swaps the chat for a
search in the same column; the chat, its history and your draft are one click
away. Type a question, choose a mode and **Run**:

- **Semantic** embeds the question with the pipeline's embedding node and asks
  the store for the nearest chunks.
- **Keyword** asks the store for the text itself, where the store can: "Keyword
  search matches text fragments on this store" (pgvector, Chroma) or "… matches
  whole words on this store" (Qdrant). It is off, with "This store cannot search
  by keyword", elsewhere (Pinecone).
- **Hybrid** runs both and fuses the two rankings in your browser, labelled
  "hybrid (fused here)"; **Auto** lets the store node choose.

Results show rank, path and chunk, score (the formula on hover), whether the
node's threshold would keep them, a short preview, and **open**, **map** and
**ask about this**. The **Threshold** slider re-classifies them as you move it:
"At 0.42: 7 of 20 would pass (today's node setting 0.30 passes 11)", with the
score histogram under it. **Copy as node setting** copies `threshold_search:
0.42`: set it on the store node in the pipeline editor; this console cannot
change node settings. **Compare** runs a second question beside the first and
says what they share: "A and B share 4 of 10 results (Jaccard 0.25); 3
documents only in A, 2 only in B"; with the map open, both are drawn as stars (A
★, B ☆). **Why these?** under a chat answer gains **Open in Search**, which
opens this view with the answer's question and its cited chunks marked.

## The trash and removing documents

Each document has a trash button ("Move `<path>` to the trash"). It is enabled
only when the store node allows writes (and can move documents to the trash),
the connection has a Tools source, and the card is not read-only; otherwise it
is disabled and says why.

**Move to trash** asks first, with nothing to type: the confirmation shows the
path, the short id, the chunk count and the store, collection and backend:
"Moves this document and its N chunks to the trash of `<collection>`. Search,
chat and the map leave it out until it is restored from the Trash." **Cancel**
has the focus, and Enter never confirms. Several documents (select them, or
lasso them on the map) move together, in batches; the first error stops the
rest, and the app says what already moved.

The directory's title switches between **Documents** and **Trash (N)**, where
N is the number of documents with chunks in the trash as the store counts it.
The Trash lists those documents. On each one, **Restore** brings it back at
once, and **Delete permanently** asks first: "Deletes this document and its N
chunks from `<collection>`. This cannot be undone; add the file again to
restore it." Checked rows restore or delete together; deleting several asks you
to type their count. **Empty trash** lists the whole trash, asks you to type
the number of documents in it, and deletes them permanently. A document that
still has chunks outside the trash (a later upload added some after it was
moved there) is kept and reported: "Emptied the trash: deleted 12 documents
permanently (140 chunks). 1 was kept: it still has chunks outside the trash."
On `rocketride_vector` the permanent deletes ask for the table name instead,
because the table is shared by every pipeline in the organization that names
it. A document in the trash cannot be read until it is restored: "This
document is in the trash. Restore it to read it."

After any of these the counts, both lists, the store's details (model,
dimension, index) and the map refresh, and the app says what happened, for
example "Moved `<path>` to the trash (N chunks)" or "Deleted `<path>`
permanently (N chunks)", with the number of chunks the store actually reported
(none when it cannot count them, as on Pinecone). If the request times out:
"The request may still complete on the server. Refresh to check." Writes are
never retried.

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

- **Sample.** **Detailed** draws up to 2,000 points with a short snippet each;
  **Light** draws up to 5,000 points without text (the inspector fetches it on
  demand). The label says how many of how many chunks are shown and whether the
  sample is random or not uniform, and says so when the store returned fewer
  points than asked for.
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
  sample are drawn hollow. **Open document**, **Find similar** and **Move to
  trash** act on it.
- **Answers.** The sources of a chat answer light up on the map; sources
  outside the sample are added to it. The answer's question becomes the star:
  it is embedded by the pipeline's embedding node and placed like a query, with
  rays to its true top results. When that node cannot be reached from the
  Tools source, the star is the score-weighted centre of the sources instead,
  and the legend marks it approximate.
- **Lasso** (`L`): select an area, then **Ask about these only**, **Move
  these documents to the trash**, **Isolate** or **Copy keys**. The **Selection** tab also
  shows a **similarity matrix** of 2 to 100 selected points: a heatmap (values
  in the cells up to 20 × 20), ordered so that close points sit together, with a
  table alternative, **Export CSV** and **Show pair**. The store computes it from
  the points' keys, so a sample drawn again cannot shift it.
- **Clusters.** With each sample the store node groups the points (connected
  groups of the neighbour graph) and names the largest groups by their most
  frequent terms. **Colour by → Cluster** colours them; the **Clusters** tab
  lists them by size with their label, points and documents, and **Show**,
  **Ask about these** (scopes the chat to their documents) and **Export**; a
  **Noise** row lists the points in no group. **Minimum size** (2, 5 or 10)
  regroups at once, without asking the store again. The legend says how the
  groups were made, for example "Clusters: connected groups of the sample's
  neighbour graph above similarity 0.61 (the 60th percentile of its edges,
  computed by the store node), groups of at least 5 points; labels are the most
  frequent terms of up to 50 of their chunks."
- **Colour by** also offers file type, folder, chunk position, table chunks,
  ingest date, file size, health, ingest node, density and query similarity,
  each with a legend; a mode the data cannot support is off with the reason.
- **Edges.** **None**, **Neighbours** (each point's 3, 5 or 10 strongest
  links) or **Tree** (the strongest path connecting every point: the spanning
  tree of the neighbour graph, "2,000 points, 1,999 edges"). Hovering a point
  thickens its edges; **Expand selected** adds the selected point's own. When
  frames get slow the map draws fewer edges and says so.
- **Isolate, Show all, Expand by neighbours.** Show only the selection or a
  cluster ("Showing 212 of 1,000"), grow it by one ring of neighbours, or bring
  every point back. The keyboard and the layouts skip hidden points.
- **Duplicates.** Near-identical chunks are joined by a dashed line, and the
  **Duplicates** tab is a review queue: pairs grouped by document, each group
  with its similarity range, a **Keep** choice per document and a policy (keep
  oldest ingest, shortest path, most chunks, or choose by hand). The similarity
  slider (0.90 to 0.995) regroups at once, from each point's 15 nearest
  neighbours in the sample. **Show group**, **Mark reviewed**, **Move the
  others to the trash** and **Move all queued to the trash (N documents)**
  follow, through the console's confirmation; the Trash restores them. Repeated
  text inside one document is listed apart, with
  **Open** only.
- **Outliers.** Unusually isolated chunks are ringed, and the **Outliers** tab
  lists the lowest-density share of the sample (1, 2 or 5 %, chosen without
  asking the store again), each with why ("density 0.12 vs sample median 0.61;
  nearest neighbour 0.31 in `<path>`"), **Mark reviewed**, **Show neighbours**
  and **Move to trash**.
- **Recommend.** From a point's panel, **Add as example (+)** or **(−)**; the
  **Recommend** tab finds the chunks most like the positives and least like the
  negatives in the whole collection (**Average vector** everywhere; **Best
  score** on Qdrant, which ranks it itself), and can pin the results on the
  map. "+ current query" adds the text query as a positive.
- **Full text.** **Show full text** on a point shows its chunk with the active
  question's words marked: "Lexical matches only; retrieval is by meaning."
- **Heat strip and Table.** The heat strip shows a document's chunks in order
  against the active query, and the **Table** tab lists the points for screen
  readers and keyboard use.
- **Export.** The map's **Export** menu saves the sample, the lasso selection,
  the points shown, the clusters, the duplicates or the outliers as CSV or
  JSON, and the map as a PNG with its legend and a footer; the directory and
  the search export their rows the same way. Files are named
  `vector-explorer_<collection>_<kind>_<date>.csv`; cells that start with `=`,
  `+`, `-` or `@` are guarded against spreadsheet formulas.
- **Views.** **Views → Save current view** keeps the sample size, mode and
  seed, layout, colouring, edges, minimum cluster size, query text, scope,
  selection (up to 2,000 points) and camera under a name; **Apply** draws the
  sample again with its seed and restores the selection: "1,340 of 1,900
  selected points restored; 200 drawn hollow" (up to 200 points missing from the
  new sample are drawn hollow, the rest are dropped). A saved query runs again
  only on **Run saved query**, because it costs an embedding. Up to 20 views
  per connection, kept until you sign out.
- **Keyboard.** The arrow keys move to the nearest point in that direction,
  Enter inspects it, Escape clears.

The map works on positions and neighbour lists computed by the store node; the
browser never receives the raw embedding vectors of a sample.

## A document's page

**Open** on a document, a source or a point opens the document's page: its
path, id (with a copy button), chunk count, size, type and ingest time when the
store keeps them, its health (the problems listed under [Documents](#documents),
each with a sentence, or which stores report them), and its chunks in reading
order with table chunks tagged. **Show chunk path on map** draws the
document's chunks in order on the map. When a query is active (a text query
placed on the map, or a chat answer shown there), a heat strip above the
chunks shows how similar each one is to it: the query is embedded by the
pipeline's embedding node and the store scores the document's chunks against
it. A chunk the store does not hold has no bar. Without a query, the page says
how to get one.

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
| The store lists documents unsorted | This store lists documents in storage order; the directory sorts what is loaded. |
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
stored document from the console as its own document. **Details** on the
console's header shows what a connection's drawer shows in the app, with
**Test connection**.

What is different there:

- **No chat and no uploads.** The editors do not pass a chat question or a file
  upload on for dev tools, so both areas say so. Search still works from the
  chat area. Open Vector Explorer as an app to ask questions or add documents.
- **Removals are confirmed inside the document** that asked, with the same
  words and typed confirmations.
- **Where downloads are refused**, the export menu offers to copy the CSV or
  JSON instead; where the clipboard is refused too, it shows the text to copy by
  hand.
- **The map stays on PCA** where the editor cannot start the layout worker,
  and says why.
- **Nothing is stored**: no history and no preference; saved filters and views
  last until the document (VS Code) or the page (RocketRide workspace) closes.

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
  chat, map and selection is cleared.
- **Run log traces.** When a pipeline runs with any trace level other than
  `none` (`metadata`, `summary` or `full`), its run log records the first 2 KB
  of each tool call's input and of its output. Unlike lane data, a tool trace
  carries its input and output even at `metadata`, the level the Observability
  page lists as component enter/leave and object identities only. The VS Code
  extension starts runs with `full`, the MCP tools with `summary`, and an SDK
  `use()` with `none`; a deployment records at `full` unless its schedule sets
  a lower level. For Vector Explorer that means your map queries, document paths and
  ids, snippets of chunk text, and for a `vectors` answer (the one request that
  returns raw embedding values) the start of the raw vector. The chat's
  questions and the chunks passed to the LLM travel through the pipeline's
  lanes, which `summary` and `full` record too. Run logs are kept 7 days for
  development runs and 30 days for deployments; see
  [Observability](/guides/observability). If that matters, start the pipeline,
  or set the deployment's schedule, with the trace level `none`.
- **Chat history** keeps the text of your questions only, and is forgotten on
  sign-out.
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
  light mode, and t-SNE at most 1,000. The directory loads 5,000 documents on
  its own; **Load more** goes further.
- **Uploads.** 20 files, 50 MB per file and 200 MB per drop, checked by the
  app before it sends anything; a file over a limit is excluded, not ingested.
  These are the only upload limits: the engine does not apply the templates'
  parser size setting in this release.
- **Read-only cards** cannot add documents or change the trash.
- **Answers need a model.** Chat needs a working LLM (a key, or a local
  OpenAI-compatible server); everything else does not.
- **The map's analysis covers its sample.** Clusters, duplicates, outliers and
  edges are found among the sampled chunks; draw a larger or light sample to
  cover more. An unscoped sample of a collection of more than 500 documents is
  drawn from the first 500 the store lists, and the legend says so.
- **Scopes** reach the map, the search and the chat up to 2,000 documents.
  Stores that cannot filter are filtered by the app over the rows it loaded.
- **Keyword search and best-score recommendations depend on the store**: see
  [Search](#search) and the map's **Recommend**.
- **Saved filters and views last for the session.** They are not kept across
  sign-ins or browsers.

## Compared with the native consoles

Vector Explorer does not replace your database's own console. Within one app,
across pgvector, RocketRide Vector, Qdrant and Chroma, it gives you:

- a search surface, one click from the chat, with semantic, keyword and fused
  modes and a threshold slider that shows what the node's setting would keep;
- a text question placed on the map with rays to the chunks the store really
  ranks first, and two questions compared side by side;
- the collection's clusters named by their own words;
- the neighbour graph and its spanning tree drawn over the sample;
- near-duplicate groups moved to the trash in one confirmed batch, with the rows reported, and a trash to restore them from;
- a folder, file-type or date scope that applies to the documents, the map, the
  search and the chat;
- charts of chunks per document, chunk length, file types and ingest time;
- CSV, JSON and PNG exports of what you see;
- chat answers linked to the exact chunks they were given.

The map draws at most 2,000 points with text or 5,000 without, and says when it
was drawn from the first 500 documents of a larger collection; Qdrant's own
visualiser draws more points. On Qdrant the neighbour graph of a sample of up
to 500 points is computed by Qdrant itself; a larger sample gets the store
node's graph.
