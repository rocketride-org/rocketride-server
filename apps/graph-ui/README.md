# Graph Explorer

Graph Explorer is the app for working with a graph database your pipelines
already talk to: browse what is in it, run Cypher, see the answer as a graph,
and, only where a node allows it, change data. It is not a database client of
its own. Every statement travels through a graph tool node inside one of your
running pipelines, so it reaches exactly the graph that node is configured for,
with that node's permissions. If apps are new to you, read
[Apps](https://github.com/rocketride-org/rocketride-server/blob/develop/docs/public/product/concepts/apps.md)
first. What the app deliberately does not do is under [Limits](#limits).

The supported nodes are
[`rocketride_graph`](https://github.com/rocketride-org/rocketride-server/blob/develop/nodes/src/nodes/rocketride_graph/README.md)
(Apache AGE in a managed RocketRide database, chosen in the node's Database setting),
[`graph_neo4j`](https://github.com/rocketride-org/rocketride-server/blob/develop/nodes/src/nodes/graph_neo4j/README.md)
and
[`graph_falkordb`](https://github.com/rocketride-org/rocketride-server/blob/develop/nodes/src/nodes/graph_falkordb/README.md).
Other nodes that declare the `graph` class, such as ArangoDB and HydraDB, do not
speak Cypher and are not listed.

## Before you start

- **A running pipeline with a graph node.** Connections are discovered from
  running tasks, so a stopped pipeline has none. Three starting pipelines,
  `age.pipe`, `neo4j.pipe` and `falkordb.pipe`, are kept in the RocketRide
  repository under
  [`apps/graph-ui/templates`](https://github.com/rocketride-org/rocketride-server/tree/develop/apps/graph-ui/templates).
  They are not installed with the app. Each is a tools source plus one graph node
  and a note, with direct execution off, and holds no password, token or
  `project_id`. To use one, open it there and save its text as a new `.pipe` file
  in a VS Code workspace: the editor gives a new `.pipe` file its own `project_id`
  when it has none, so two people importing the same template never share an
  identity. For Neo4j and FalkorDB, type the connection details into the node's
  form (they are stored encrypted). `rocketride_graph` has none to type: it uses
  the managed RocketRide database its Database setting names. Posting the raw file through
  an SDK `use()` also works, but the engine then reports no project id for the
  task. Two raw copies started by the same user with the same node id then share
  one connection identity and appear as ONE card in the Connections list. Save
  each copy as its own `.pipe` file in a VS Code workspace (or give each its own
  `project_id`) before running two of them.
- **A node that is up to date.** The app reads through the node's `read_query`
  tool and reads its identity, limits and capabilities from `dialect`. A node
  that does not advertise `read_query` is shown as **Needs upgrade** and cannot
  be opened. The app never falls back to `execute`, or to FalkorDB's writable
  `query`, to read: a fallback to a tool that can write would turn a read
  screen into a write path.
- **Direct execution, only if you want to change data.** Each node has an
  **Allow direct query execution** setting (`allow_execute`), off by default and
  worth leaving off. With it off there is no write console for that connection.
- **A language model, only if you want to ask in words.** Browsing with Cypher
  needs none.

## Connections

The Connections page lists every graph node in every running pipeline task you
can see that runs under one of the teams your current organization lists for
you. Your own pipelines still running in an organization you switched away
from are not listed (the server still lets you reach them from other clients);
your own runs under another team of the same organization are. A task whose
team the server does not report, or a sign-in whose organization data carries
no team list at all, is not filtered; an organization that lists none of your
teams shows only tasks that name no team. A card shows the pipeline, the node and a state: **Checking** while
the node is being asked who it is, **Running** once it answered, **Stopped**,
**Unreachable**, **No access** (you can see a team deployment but your role
cannot call it), or **Needs upgrade**. Your own development run and a team's
deployment of the same pipeline are separate connections, and two owners' runs
never merge. Selecting a card opens a drawer with the engine and version the
node reports, its target (database or graph), whether writes are allowed, and a
sentence on what the node's read path guarantees. **Test connection** asks the
node again; when nothing could be sent (the pipeline is not running, or a check
is already in progress) it says "Not tested".

An empty list does not say why. If the task list is empty the page says that it
cannot tell whether nothing is running or something is wrong. A node that fails
to start is never listed: for example, `rocketride_graph` checks its Apache AGE
graph when the pipeline starts and does not create it, so a graph name that does
not exist stops the pipeline, and the error is in the pipeline's log. On
RocketRide's managed databases (organization, team or personal) the graph
`rocketride` is created with the database.

The app never holds a connection string or a task token in anything it saves or
shows. Task tokens are kept in memory only, per session. Signing out, or a
switch to another organization or development team, forgets every connection
and closes every workbench and write console, so nothing from before stays on
screen.

## The workbench

Opening a connection gives it a workbench: an editor, a row limit, and three
result tabs.

- **Run** sends the selection, or the statement the caret is in
  (Ctrl/Cmd+Enter). **Run all** sends every statement in order
  (Ctrl/Cmd+Shift+Enter). The text under the editor says what a press would
  send before you press it. What is sent is read from the editor at the moment
  you press, never from an earlier copy of the text.
- **Several statements** run one after another, each as its own request, and the
  run stops at the first error. A strip lists each statement with its outcome.
  Nothing here is a transaction: statements that ran before a failure have
  already run, and the page says so.
- **Row limit** is 200, 1,000 or All. All means the node's own maximum, never
  unlimited, and nothing above that maximum is ever sent. The limit travels as an
  input to the node, not as text added to your Cypher, so your statement is sent
  exactly as written.
- **Stop waiting** stops the app from waiting. The query may still be running on
  the database and cannot be cancelled from here; a late answer is ignored.
- **When the connection is checked again** (any pipeline restarts, the shell
  reconnects, or you press **Test connection**), or its pipeline stops, an open
  workbench keeps its editor, results, graph and inspector on screen. Running and
  the graph's actions pause, with the reason above the editor, until the node
  answers again.
- **The editor** highlights Cypher and keeps a draft per connection (text only).
  It is the platform's shared code editor, which comes with the app (nothing is
  fetched from a CDN). If it has not loaded after ten seconds, a plain text box
  is used, with the same run keys, drafts and history, and a notice says so.
- **Browsing is read-only.** A statement the text check takes for a write is
  refused before anything is sent: one that uses `CREATE`, `INSERT`, `MERGE`,
  `SET`, `DELETE`, `DETACH`, `REMOVE`, `DROP`, `FOREACH` or `LOAD CSV` as a
  clause (not as a property, label or map key), a `CALL` of a procedure that is
  not on the allowlist, a `SHOW` of anything but indexes, constraints, functions
  and procedures, an administration command such as `GRANT` or
  `STOP DATABASE`, or a statement that starts with anything but
  `MATCH`, `OPTIONAL MATCH`, `WITH`, `UNWIND`, `RETURN`, `CALL` or such a `SHOW`
  (so `USE`, `EXPLAIN`, `PROFILE` and a `CYPHER` prefix as well). Text whose
  string, comment or quoted name never closes, and a `CALL` with no procedure
  name, are refused too. **This is a text check, not a
  database safeguard.** The node refuses writes on its read path as well; what
  keeps a read read-only depends on the node, see [Safety](#safety).
- **Where the text check's words come from.** Three of its lists are the Neo4j
  node's read-path lists, word for word, and a test fails when they differ: the
  write words, the `SHOW` targets with the words allowed before them, and the
  procedure allowlist. The rest is the app's own and is not the node's rule. The
  app counts an administration word only as the first word of a statement, and
  a few pairs such as `TERMINATE TRANSACTIONS` anywhere, while the Neo4j node
  refuses `USE`, `GRANT`, `DENY`, `REVOKE`, a `SHOW` off its list and more
  administration pairs anywhere in a statement. The app also refuses forms the
  node lets through, among them a write word used as a variable right before a
  label, as in `(set:Person)`, a procedure name quoted as one part, as in
  ``CALL `db.labels`()``, a statement that does not start with a read clause
  (`EXPLAIN`, `PROFILE`, a `CYPHER` prefix, `LET`, `FINISH`), and one that starts
  with an administration word the node refuses only in a pair (`DISABLE`,
  `ALLOCATE`, `DRYRUN`). The FalkorDB and Apache AGE read paths do not use these
  lists.

### Results

A result opens as a **Graph** when it holds nodes or relationships that can be
drawn, and as a **Table** otherwise. **Raw** shows the node's answer as JSON and
is always available. The Table lists every returned row positionally, so two
columns with the same name both show; selecting a row opens it in full, with
**Copy as JSON**. Integers beyond 2^53 are shown as the exact text the node sent,
never rounded, and a result that arrived with one as a plain number says that it
may have been rounded.

A result that hit a limit says which one: the row limit, the node's element
budget or its value budget.

## The graph

Nodes are coloured by their first label, with the first letter of the label
inside, and a legend lists every label next to its colour. Colour is never the
only carrier of meaning. How colours were chosen, and the contrast measured
against every shipped theme, is in
[docs/contrast.md](https://github.com/rocketride-org/rocketride-server/blob/develop/apps/graph-ui/docs/contrast.md).

| Action | What it does |
|---|---|
| Expand | Fetches up to 100 neighbours that are not already drawn. The node's relationships already on the canvas are left out of the request, so expanding again fetches the next ones, whatever the node's row limit. On Apache AGE only the first 200 drawn relationships of a node can be left out; past that, the node's row limit can stop an expansion, and it then says that expanding again returns the same rows. |
| Collapse | Removes what hangs only from this node. |
| Dismiss | Removes the node from the canvas. |
| Inspect | Opens the node's labels, id and properties, exact and complete, with Copy JSON. |
| Connect nodes | Draws the relationships among the nodes already on the canvas. When the node returns only part of them (it stops at its own row limit), it says that more may exist; connect fewer nodes to see the others. |
| Find path | Between two selected nodes, tried at increasing depth up to 10. A node that cannot answer says so; "no path found" names the depth it searched. |
| Show more nodes | Adds nodes the first draw left out. |

The graph sends one request at a time. While Expand, Connect, Find path or an
inspector Refresh is waiting, **Stop waiting** lets go of it: the node may still
be working on it, and its late answer is ignored.

**Relationship labels.** The type of a relationship is drawn along it when the canvas is at normal size or larger, or (at 60% zoom and above) when no more than 200 relationships are drawn. In a crowded, zoomed-out graph the labels would be unreadable and are the most expensive thing to repaint, so they are not drawn; every relationship still shows its type as a tooltip and in its accessible name ("KNOWS from Ada to Charles"), the inspector shows it, the Table lists it, and zooming in brings the labels back. All relationships are drawn into one SVG behind the nodes, so panning and zooming cost the page nothing beyond moving it.

**Ids are live handles, not identities.** Every action that asks the database about a
drawn element (Expand, Refresh in the inspector, Connect, Find path) sends the element's
id. A database may hand an id out again after a delete: FalkorDB does, and Apache AGE ids
are per-label sequences. So an answer is merged only when every element it shares an id
with has the same labels (a relationship: the same type, start and end); otherwise
nothing from the answer is added, the drawn copy is dashed and marked out of date, and
you are told. A statement run in the write console marks the whole drawing out of date,
whatever it was: Expand, Connect and Find path stop sending until the query is run
again. **This cannot catch everything:** if an element is deleted and another with the
same labels (or the same type and ends) is created, the app cannot tell them apart and
the old drawing may show the new element's properties after a Refresh. Refresh re-reads
the database, but it only shows what is there under that id now. Run the query again to
be sure.

The canvas holds at most 1,000 nodes and 2,000 relationships; a result opens with
the first 300 nodes and says how many it left out. Every query the app writes
itself (a label preview, expand, connect, path) passes values as parameters, never
spliced into the text, and uses the form each engine proves to work.

**Layout** is computed off the main thread, in a Web Worker running d3-force with
a fixed seed, so the same result lays out the same way, and the worker is stopped
when a newer layout replaces it. If the worker cannot run, the nodes are placed
on a grid and a notice says so. The page never falls back to computing the layout
on the main thread.

**Keyboard.** The canvas is a single tab stop with roving focus: arrow keys move
to the connected node in that direction, Enter inspects, Space selects, `E`
expands, `C` collapses, Delete or Backspace (the Mac "delete" key) dismisses,
`P` finds a path between two selected nodes, `?` lists every key, Tab leaves the
canvas. Each node is spoken with its caption, labels and how many relationships
are shown, and each action is announced through one polite live region.
Animations respect the reduced-motion setting. The Table tab lists the same
result for anyone who would rather not use the canvas.

## The sidebar

For the active connection the sidebar lists its **node labels** and
**relationship types**, each with its properties and the types observed for
them, and a count where the node has one. A count marked *about* is the
database's estimate. Selecting a label or type shows and runs a preview of 25
rows in the workbench. **Refresh** asks the node to read the database again. A
Refresh pressed while the schema is first being read is sent once that read
ends; one pressed while the connection is being checked again sends nothing and
says so.

The line under the tree says how far the schema can be trusted: how long ago it
was read, that property keys are **sampled** from a few nodes per label (so a
property can exist that is not listed), that a refresh failed and the last good
snapshot is shown, or that an older node reports a schema it cannot refresh. An
empty schema from a node that cannot report one is never presented as an empty
graph.

## Ask

The Ask box asks the node's language model (`get_query`) to write Cypher. What
comes back is a **preview**: it is put in the editor and **not run**; you read it,
edit it, and press Run. The node has already checked that it reads only, and the
text check runs on it again. An answer in words is shown as an answer. A pipeline
with no language model gets a note that says so instead of an error. Any other
failure is shown as an error or a warning. An error leads with the text it came
with: the node's (a model that returned nothing, or the node's refusal of what
the model wrote), the SDK's (a lost connection), or the app's own (the pipeline
is not running, or the answer could not be read). The warnings include a node
that cannot answer Ask yet, which gets the upgrade notice, and a wait the app
gave up on, which says that the node may still be working on the question and
that nothing here can cancel it. An empty question, or one longer than 2,000
characters, is not sent. **Stop waiting** drops a late answer.

## History

Each statement you run is recorded per connection in your RocketRide workspace
file on the server, not in this browser: its text as typed (including any
literal values), when, how long it took, how many rows, and how it ended. You can
search, pin, add a note, load a statement into the editor, run it again (an
explicit action), delete entries, clear all, or turn recording off per
connection. Up to 100 entries per connection and 8 KiB of text per entry are
kept, and about 256 K characters of history across all your Graph Explorer
connections: past that, the oldest entries anywhere are dropped first, unpinned
before pinned. When a search or **Pinned only** hides every entry, the panel says
that nothing matches. Tokens and connection strings are never recorded.

## As a dev tool

Graph Explorer also runs as a dev tool beside the pipeline editor, in VS Code
and in the RocketRide workspace. There the sidebar lists your graph connections
and shows the active connection's schema, and each workbench and write console
opens as its own document. A connection's row shows its state as a dot and,
when it is not running, in words (**Checking**, **Stopped**, **Unreachable**,
**No access**, **Needs upgrade**); its tooltip names the pipeline and says why
it cannot be browsed. Click a row, or press Enter or Space on it, to open its
workbench. **Refresh** is on the Connections header, and a line under the rows
says when discovery is running, found nothing, or failed. What a card's drawer
shows in the full app (engine, version, target, writes, **Test connection**)
shows inside the connection's own document instead, under its header:
**Details** on the workbench header shows or hides it, and **Test connection**
where a connection cannot be browsed or its write console is not available
shows it and tests. Close it with its close button, or Escape inside it. The tool's own page, with no document, only says to
open a connection from the sidebar. Everything that reaches the engine goes
through the sidebar, which holds the tool's one connection; the documents hold
none.

What is different there:

- History is kept in a file in your user folder on the server
  (`rocketride.graph.history.json`), not in the workspace file, and the History
  panel says so. Changes are written about a second after you make them. If
  that file cannot be read, history is kept for the session only and the file
  is left alone. Two windows writing history at the same time keep the later
  one's copy. That holds across a disconnect too: a window whose changes wait
  for the account to come back writes the history it read before the
  disconnect plus those changes, so what another window wrote meanwhile is
  overwritten.
- History across a disconnect, a sign-out and an account switch:
  - after a disconnect or a sign-out, the last changes (the second before it)
    are kept and written once the same account is back. If the sidebar closes
    meanwhile (VS Code closes it on every disconnect), they wait in that window
    for up to 10 minutes;
  - after a switch to another account they are dropped, never written into
    the other account's file, and that account never sees them;
  - a run recorded in the moment after a switch, while the new account's
    history is still loading (usually under a second), is lost if the account
    changes again before the load finishes. It is never added to another
    account's history.
- Editor drafts and caption choices last for the session only.
- Results grid layouts (sort, column widths) are kept in memory: in
  rocket-ui until the page reloads, in VS Code until the document's panel
  closes. They are never written into the host's own preferences.
- A large graph is laid out by a worker. A panel that cannot start it (VS Code
  loads the app from the engine, a different origin) places the nodes on a
  grid, and a note says why.
- Where a panel does not allow the clipboard, Copy JSON shows the text to
  select and copy by hand.
- In VS Code the sidebar does not receive the server's error codes, so a
  statement interrupted by a pipeline restart is reported as failed instead of
  being retried once, and a stopped pipeline and an unreachable one are reported
  the same way. Refresh always checks every connection again.
- A result too large to send to a document (over 32 MB) is refused with a
  reason; lower the row limit.
- When the connection to the server drops, the editors close the tool's
  documents until it is back (VS Code shows that it is not connected, the
  RocketRide workspace asks you to connect), so an open document's editor text,
  results and graph do not survive a disconnect. Its history does (see above).
  A connection that is only checked again while the server stays connected (a
  pipeline restart, **Test connection**) keeps them, as in the full app.
- When the signed-in user, organization or team changes, every open workbench
  and write console closes.
- A document that cannot open yet says what it waits for: the server
  connection ("Not connected", or "Waiting for the server connection…" before
  the editor reports it), the sidebar ("Starting Graph Explorer…" while the
  document asks the editor to open the sidebar by itself, then "Open the Graph
  Explorer sidebar to connect" if nothing answers within a few seconds), or a
  sign-in ("Waiting for sign-in"). A document that already showed its
  workbench keeps it while the sidebar restarts, with a note to open the
  sidebar if it does not come back; after a sign-out it waits for sign-in
  instead.

## The write console

A connection whose node reports `allow_execute` and supports the graph result
shape has a **Write console** button. It is a separate document with its own
editor and an **Execute** button, and it always says what it is:

- Before anything is sent, a confirmation lists the statements that look like
  they change data, with their text, and says **This is a text check, not a
  database safeguard.** There is no "do not ask again". **Cancel** has the focus
  when it opens, so pressing Enter again sends nothing. A batch the check does
  not flag is sent when you press Execute, without a dialog.
- Statements go through `execute` with the graph result shape, so what a
  statement returned is drawn like any other result. The result line, the strip
  and History show the count the node reports as affected. There is no row-limit
  choice here: `execute` returns at most the node's own maximum.
- Each statement is its own request. A batch stops at the first error; statements
  that ran are not undone. The strip says how many ran and how many were not run.
- A write is never sent again by the app: no automatic retry.
- A failure that can come after the database ran the statement (the node could
  not return its answer, the answer was not understood, or the app stopped
  waiting) says **the write may have been applied**. Only a refusal before
  anything was sent (the node does not support it, the pipeline is not running,
  or execute is off) means nothing changed.
- Every write that may have changed data marks the graphs drawn from that
  connection out of date, in every tab, even when it finishes after the console
  was closed.

## Safety

- The browse editor, Ask, the sidebar previews and every graph action use
  `read_query`, which the node runs read-only whatever the node allows
  elsewhere. A node that cannot do that is not browsable.
- The text check that refuses writes in the browse editor is a convenience and
  can be wrong in both directions. It is not a boundary.
- **For Neo4j and FalkorDB, the boundary is the database account you connect
  the node with.** Use a user that can only read, and a statement the app should
  never send cannot do harm. On Neo4j the node reads in a read session, which is
  a routing hint, not access control; FalkorDB uses `GRAPH.RO_QUERY`.
- **`rocketride_graph` has no account to choose.** It connects to the managed
  database its Database setting names as the role that owns that database, so a
  read-only database role cannot be relied on there. Its reads are kept
  read-only by a read-only transaction and by the node's own check of each
  statement. Whether it can write at all is its **Allow direct query
  execution** setting.
- The drawer states which of these a connection has and whether the node
  verified its own permissions (`read_boundary_verified`).
- Nothing the app saves or shows contains a task token, a connection string or a
  password.

## Limits

- It reads and writes through the node's tool surface: no cancel of a running
  query, no server-side cursor, no streaming of a large result. A query is
  bounded by the row limit, the node's element and value budgets and its
  statement timeout.
- It does not edit the graph's schema, import or export data, or draw a result
  that has no nodes.
- Apache AGE 1.5.0 lacks `date()`, `duration()` and `EXISTS { }` subqueries; the
  node says so with its own text and the app shows it.
- FalkorDB and Neo4j refuse two columns with the same name; AGE keeps them, and
  the Table shows both.
- A label or relationship type the app cannot quote for the engine is listed in
  the sidebar, but its preview says so instead of running: on Apache AGE any
  name other than letters, digits and `_`, and on FalkorDB a name holding a
  backtick (FalkorDB cannot parse one inside a quoted name). Write the query by
  hand to browse it where the engine allows.
- Performance was checked with results of 100, 300 and 1,000 nodes, and with
  1,000 nodes drawn after **Show more nodes** (a 1,000-node result draws its
  first 300 until then). On an Apple-silicon laptop there were no long tasks
  panning or dragging at any of these. With the CPU slowed 4x in Chrome, as a
  stand-in for a slower device, panning a fully drawn 1,000-node graph stutters,
  which is one reason the first draw is capped at 300. No real low-end device
  was measured.
- Browsers: the production checks ran in Chrome 154, Firefox 141 and WebKit 26
  (Playwright). WebKit is the engine Safari uses, but it is not Safari, and
  Safari itself has not been tried. The build declares Safari 13 as its floor,
  but the canvas (React Flow 12.3.6) uses logical assignment (`??=`), which
  starts in Safari 14, so Safari 14 is the lowest version the canvas can run in.
  The declared floor has not been changed. The layout worker's cross-origin
  handling differs by browser.
- The code editor uses the platform's shared editor theme, so Cypher is shown
  in Monaco's standard colours. Some of them are below 4.5:1 in the Dark, Gray
  and RocketRide Light themes, and the line numbers are below it in RocketRide
  Dark (see
  [docs/contrast.md](https://github.com/rocketride-org/rocketride-server/blob/develop/apps/graph-ui/docs/contrast.md)).

## For developers

Notes on the code, its tests and the build are in
[apps/graph-ui/docs/development.md](https://github.com/rocketride-org/rocketride-server/blob/develop/apps/graph-ui/docs/development.md),
and how apps work in this repository is in
[docs/development/apps](https://github.com/rocketride-org/rocketride-server/blob/develop/docs/development/apps/index.md).
The browser lanes run with `ENGINE_URL=<engine> ./builder graph-ui:e2e-live` (opt-in, not part of `builder test` or CI; setup in [scripts/acceptance/graph-explorer/README.md](https://github.com/rocketride-org/rocketride-server/blob/develop/scripts/acceptance/graph-explorer/README.md)).
By default it runs the graph, SQL and line-number lanes. The contrast lane runs
only when named (`GRAPH_UI_E2E_LANES=a11y`, or `all`): some of the shell's own
theme colours are below 4.5:1 today, so it fails on text this app does not colour.
