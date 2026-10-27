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
teams shows only tasks that name no team. A card shows the node, its provider,
the engine and version the node reports (once it answered), the pipeline, and a
state: **Checking** while the node is being asked who it is, **Running** once it
answered, **Stopped**, **Unreachable**, **No access** (you can see a team
deployment but your role cannot call it), or **Needs upgrade**. Your own
development run and a team's deployment of the same pipeline are separate
connections, and two owners' runs never merge.

A card also carries chips, each from what the node itself reports:

- **Writes allowed** or **Read-only**: writes are allowed when the node has
  `execute` on and supports the graph result shape (the write console is
  offered only then).
- The size, such as **60 nodes (per label) · 92 relationships**, once the
  connection's schema was read in this session (opening its workbench reads
  it). No card asks the node for it. The node total adds up the per-label
  counts, so on Neo4j and FalkorDB a node with two labels counts twice; the
  relationship total counts each relationship once. When the node listed only
  part of a very large schema, both totals say *at least*. A count the database
  estimates (Apache AGE) says *about*. Where counts are missing (AGE before its
  tables were analysed), a part says *nodes not reported* or *relationships not
  reported* when it has none, and *some node counts not reported* (or
  relationship) when only some are missing; with no total at all, the card says
  *counts not reported* or *some counts not reported*. When the last refresh
  failed, the counts are the last successful read's and say *as of the last
  read*.
- **Empty graph**, only when a schema read in this session lists no label and
  no relationship type. A node that could not read its schema, or an older
  node, never shows it.

Selecting a card, or pressing Enter or Space on it, opens a drawer. Its summary
comes first: the state and the chips (with **Supported (Cypher)** for a node
that has `read_query`), the engine and version, the database or graph, and, once
the schema was read, its size in the same words as the card, and a line such as
"5 labels · 7 relationship types · 21 property keys (sampled)"; a fresh read
that lists nothing says **Empty**. A read that lists nothing and proves nothing
never says "0 labels": the Schema line says **Could not be read** when the read
failed, and **Not reported by this node** for a node too old to report one. **Connection details** opens the rest: the pipeline, the node, whose
run it is, whether writes are allowed, and a sentence on what the node's read
path guarantees. **Test connection** asks the node again; when nothing could be
sent (the pipeline is not running, or a check is already in progress) it says
"Not tested".

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

**Accounts in the full app.** The shell reads your workspace file once per page
and keeps it until the page reloads. So after another account signs in without
a reload, the app shows none of the first account's history, drafts, caption
choices, editor height, label styles or saved queries, and saves
none of them, nor anything of the new account's, until the page is reloaded (or
the first account signs in again). The new account's statements are recorded
for this session only, and the History panel says so. The saved queries say
`Signed in as a different account: reload the page to see your saved queries
and styles.`, and a change to them or to a style is refused with the same
advice. A write the shell itself makes in that time, such as switching to
another app or changing the theme, still writes the preferences it holds, the
first account's history, styles and saved queries among them, into the
signed-in account's file, so reload the page before working as another account.

**One page at a time.** Each page of the app holds the workspace file as it was
when the page loaded, and any change it saves (a keystroke in a draft, a run or a History change, the
editor height, a style, a saved query) writes all of it back. So with two pages of
the same account open, a change saved in the older page overwrites what the
newer one saved, saved queries included: change things in one page at a time;
the last page to save wins. The colours the app gives new labels are not saved
by themselves (opening a connection writes nothing): they are shown at once and
saved with the next draft, editor height, style or saved query you change in
that page. A run or a History change does not save them. Colours shown in a
page that saves none of those are not kept, so if the connection's labels
change before the next session, a label can get a different colour then.

**Captions from 1.2.** The caption choices the app kept before 1.3
(`graph.captions`) are shown as the labels' captions at once, and moved into
the styles once, with the next draft, editor height, style or saved query you
change, for labels that have no caption in their style yet. The old key is then
removed; a choice that does not fit because the styles are full stays in it,
still shown, and is tried again with a later change. Nothing is moved for
another account signed in without a reload.

## The workbench

Opening a connection gives it a workbench document. It opens on **Overview**,
beside **Query 1**, and nothing runs by itself. One row holds the tabs and, on
the right, the shown tab's run bar, or on Overview its actions: **Explore**,
**New query** and **Refresh schema** (read the schema again). **Explore** opens
an Explore tab and runs a sample of 25 relationships with their end nodes
(`MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 25`, a read every engine runs).
Pressing it again shows that tab without running it again; once you have
edited that tab's text, Explore opens a new one and runs the sample there.

- **Query tabs.** Each query tab has its own editor, row limit, runs, results
  and graph, and a tab you are not looking at keeps them; only the tab shown
  draws its results, so when you come back to a tab its graph is laid out
  again: nodes you moved go back to a computed place and the canvas search
  starts over, while the tab keeps its layout choice, **Keep dragged nodes
  pinned** and whether the legend is open. **+ New query** opens
  an empty tab. Text that comes from elsewhere opens a tab of its own, so the
  text in your other tabs is never replaced:
  - a label or relationship type clicked in the sidebar: its 25-row preview,
    run; the sidebar's **New query with this label** (or type): the same
    statement, not run;
  - an Ask draft, History's **Open in new tab**, a saved query, a starter
    template, and the graph's **New query from here**: not run;
  - History's **Run again**: run.

  Only History's **Load into editor** and Saved's **Insert** change a tab you
  already have: the query tab you were in last. In the code editor that is an
  edit, so Ctrl/Cmd+Z brings the previous text back. Arrow keys move between
  tabs, and Delete (Backspace on a Mac keyboard) closes the focused query tab;
  closing a tab whose text you edited asks first, except Query 1, whose text is
  kept as its draft (as a dev tool, only until the document closes). A workbench holds at most 8
  query tabs; past that, a line says to close one, and nothing is opened or
  closed for you. Query 1 keeps the draft the workbench has always kept for the
  connection; the text of the other tabs lasts until the tab or the document is
  closed. Tabs are not restored when the document opens again.
- **One request at a time.** A workbench sends one request at a time across
  all its tabs: statements, the graph's actions and Ask alike. A request you
  stopped waiting for still counts until the node answers it, or until the app's
  own wait for it runs out (the statement timeout plus 10 seconds; two minutes
  for Ask), because it may still hold a database connection (Apache AGE's node
  has four). Meanwhile **Run** waits
  and says so, and anything asked for is not sent and says why; a statement
  that was not sent is not recorded in History. **Refresh schema** is not
  counted: it reads the connection's schema for every document at once, not
  for one workbench.
- **Room for the results.** The divider under the editor sets its height: drag
  it, or reach it with Tab and use ArrowUp and ArrowDown (24 px at a time) or
  Home to hide the editor; a double click hides it too, and so does **Hide
  editor** in the run bar. A hidden editor leaves the run bar, with the
  statement's first line: click it, or **Show editor**, to bring the editor
  back. While you drag, only the divider's line moves; the editor and the
  results change size when you let go. The height is kept in your preferences
  (`graph.editorHeight`).
- **Full screen.** The graph's **Full screen** button fills the document with
  the graph, and the inspector stays. Everything else in the document (the
  header, the tabs, the run bar, Ask, the editor and its divider, an open
  History or Saved panel) is hidden while it lasts, from the keyboard and
  screen readers too, and a run key that reaches the hidden editor sends
  nothing. It is not the browser's full screen, so it works the same
  in VS Code and in the RocketRide workspace. **Exit full screen** leaves it, and
  so does Escape when nothing inside the graph used it; a new result that opens
  as a table, or another tab, leaves it too.
- **Notes.** What is worth knowing about a result besides its rows (integers
  that may have been rounded, malformed graph values, relationships not drawn
  because an end node was not returned) is one **Notes (N)** line under the
  result, with the headlines; open it for the full sentences.

Every query tab has an editor, a row limit, and three views of its result
(Graph, Table and Raw), switched in the run bar. A tab that has not run shows
**Run a query**.

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
- **The editor** highlights Cypher and Query 1 keeps a draft per connection (text only).
  It is the platform's shared code editor, which comes with the app (nothing is
  fetched from a CDN). If it has not loaded after ten seconds, a plain text box
  is used, with the same run keys, drafts and history, and a notice says so; it
  has no suggestions and no error marks.
  - **Suggestions** come from the schema the connection last loaded. After `(x:`
    it lists the labels, after `[x:` or `[:` the relationship types, and after
    `x.` the property keys of `x`'s label when `x` is bound in a pattern of the
    same statement, such as `(x:Person)` (or of the relationship type for
    `[x:KNOWS]`); if it is not, every property key the schema lists. At the start
    of a statement it offers the clause words and a few starter queries. It
    suggests nothing inside a string, a comment or a quoted name. Property keys
    are sampled, so the list can miss a key, and each suggestion says
    "sampled". Names that need quotes are inserted quoted, and Apache AGE is
    never offered a name it cannot take quoted. Until a schema has loaded there
    are no label, type or property suggestions.
  - **A failed statement is marked.** When the database's text gives a line and
    column, that place in the statement that failed is underlined until you edit
    the text. Neo4j, FalkorDB and Apache AGE are marked where the database gives a
    position (Apache AGE for a syntax error).
  - **A statement the read workbench would refuse is marked as you type**, from
    the same text check Run uses before it sends anything (see Browsing is
    read-only). It is a warning with the reason, not a database check.
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
columns with the same name both show; selecting a row opens it in full beside
the table, with **Copy row as JSON**. Integers beyond 2^53 are shown as the
exact text the node sent, never rounded, and a result that arrived with one as
a plain number says that it may have been rounded.

A result that hit a limit says which one: the row limit, the node's element
budget or its value budget.

**Export** on the Table and Raw cards offers **Download CSV** and **Download
JSON** (in VS Code, which does not allow downloads from a tool panel, **Copy as
CSV** and **Copy as JSON**, which put the text on the clipboard). They hold the
rows the query returned under the limit that was applied, and the menu says how
many and says when the limit cut the result short; they are not the whole
result. They are built from the result itself, not from the table on screen, so
a search or a column filter in the table does not change them. Where a download is not possible and the text is over 5 million characters, nothing is copied and the menu says so; lower the row limit.
- **JSON** is an array of objects keyed by the Cypher column names. A name that
  repeats gets ` (2)`, ` (3)`, so both values are kept; a column with no name
  is `(column 2)`. Graph values and integers beyond 2^53 keep the exact form the
  node sent.
- **CSV** has a header row, and a field with a comma, a quote or a line break is
  quoted. A null is an empty field and an empty string is `""`. Lists, maps and
  graph values are written as JSON text. A spreadsheet runs a cell that starts
  with a formula character, so in CSV text that starts with `=`, `+`, `-` or `@`
  (or a tab or a carriage return) gets a leading `'`. Numbers keep their sign.


The Table keeps its sort and shown columns only while it stays on screen: switching to Graph or Raw, to another tab, or opening the result again starts from the statement's own order. Nothing about the Table is saved, and column widths always fill the space.

### Errors

A statement that fails shows its banner above the results: the headline, which
statement it was (and its line and column when the database's text gave them),
what ran before it, and what was not run after it. The database's own text is
in the banner itself, six lines at a time with the rest scrolling, not behind a
button. **Copy error** copies the headline, where it was and that text. When a
batch stopped part way and the workbench offers it, **Run from statement N** runs
the batch again from the statement that failed. A hint, where the app knows what
to do next, sits under the text. In the write console, a failure that can come
after the database ran the statement also says the write may or may not have
been applied. When the database's own text says the transaction was rolled back,
or that it hit the transaction memory limit, it says the statement was probably
not applied instead.

## Overview

A connection's Overview is drawn from the schema it last loaded. Opening it
runs no query: it is drawn from the schema the connection already read (opening
a workbench reads it once if it has not been read). It holds:

- **Counts**: nodes, relationships, labels, relationship types and property
  keys. A count the engine estimated reads "about N" and one it did not report
  reads "not reported" (Apache AGE may report none). A total is shown only
  when every label, or every type, has a count, and the node total says it is
  added up per label, so a node with two labels is counted twice.
- **The schema graph**: a circle for each label, in the label's colour, and an
  arrow for each pattern the schema observed, such as `Person` to `Company`
  through `WORKS_AT`. The patterns come from a sample of the data, so it shows
  what was seen, not every pattern the data allows; a dashed arrow is one the
  node inferred without seeing it. It is drawn for up to 30 labels; above that
  the cards below list them.
- **Relationship types**: each type with its patterns, count and sampled
  properties, and **Preview**.
- **Size and chips**: a Size line and the Supported, Writes allowed or Read-only chips, worded exactly as on the connection cards and in the connection details, plus a line on whether counts are exact and that property keys are sampled. A listing the node cut short says "at least"; a schema that could not be read says so instead of showing zeros.
- **Label cards**: the label's colour and count, its sampled properties with
  their types, **Preview** and **New query**.

An empty graph is reported only when the read succeeded and found no labels and
no relationship types. A failed read, or an old node that cannot say, is not
called empty.

## The graph

Nodes are coloured by their first label, with the label's badge inside, and the
legend (**View** > Legend and styles) lists every drawn label next to its colour. Colour is never the only carrier of
meaning. How colours were chosen, and the contrast measured
against every shipped theme, is in
[docs/contrast.md](https://github.com/rocketride-org/rocketride-server/blob/develop/apps/graph-ui/docs/contrast.md).

A click selects a node or a relationship on its own, and the inspector follows
it. Shift, Ctrl or Cmd-click adds a node to the selection or takes it out (Find
path needs two); Space does the same for the focused node. Relationships are drawn
by the app, not by the canvas library, so each one has an invisible, wider band
along its line that takes the click. The band is at least 12 screen pixels wide at
any zoom, so relationships can still be clicked when a large graph is zoomed out.

| Action | What it does |
|---|---|
| Expand | Double-click a node, or `E`. Fetches up to 100 neighbours that are not already drawn. The node's relationships already on the canvas are left out of the request, so expanding again fetches the next ones, whatever the node's row limit. On Apache AGE only the first 200 drawn relationships of a node can be left out; past that, the node's row limit can stop an expansion, and it then says that expanding again returns the same rows. |
| Expand by type | Fetches up to 100 neighbours over one relationship type, leaving out the node's relationships of that type already drawn. The type is written into the query the way the engine accepts it; a type the app cannot quote on that engine (on Apache AGE anything but letters, digits and `_`, on FalkorDB a name holding a backtick) is refused with the reason, and nothing is sent. |
| Collapse | Removes what hangs only from this node, including what Expand by type added. |
| Dismiss | Removes the node from the canvas. |
| Inspect | Opens the node's labels, id and properties, exact and complete, with Copy JSON. |
| Connect nodes | Draws the relationships among the nodes already on the canvas. When the node returns only part of them (it stops at its own row limit), it says that more may exist; connect fewer nodes to see the others. |
| Find path | Between two selected nodes. On Neo4j (when the node reports that the engine has `shortestPath`), one call asks for a shortest path of up to 10 relationships in either direction; an empty answer means there is none within 10, and if the call fails the app falls back to the search below. FalkorDB and Apache AGE try depth 1, 2 and so on up to 10, one call each, and stop at the first depth that has a path, so it is a shortest one. (AGE has no `shortestPath`. FalkorDB's follows one direction only: probed on FalkorDB 4.22.2, it returned a 5-relationship path where a 3-relationship one exists.) "No path" names the depth searched. The path found is laid out left to right on a row above the rest of the drawing, everything else is dimmed, and the status line says how it was found. Clear path (or Escape, once nothing is selected) puts its nodes back where the layout had them. |
| Show more nodes | Adds nodes the first draw left out. |

The graph sends one request at a time. While Expand, Expand by type, Connect,
Find path or an inspector Refresh is waiting, **Stop waiting** lets go of it: the
node may still be working on it, and its late answer is ignored.

**Relationship labels.** The type of a relationship is drawn along it when the canvas is at normal size or larger, or (at 60% zoom and above) when no more than 200 relationships are drawn. In a crowded, zoomed-out graph the labels would be unreadable and are the most expensive thing to repaint, so they are not drawn; every relationship still shows its type as a tooltip and in its accessible name ("KNOWS from Ada to Charles"), the inspector shows it, the Table lists it, and zooming in brings the labels back. All relationships are drawn into one SVG behind the nodes, so panning and zooming cost the page nothing beyond moving it.

**Ids are live handles, not identities.** Every action that asks the database about a
drawn element (Expand, Refresh in the inspector, Connect, Find path) sends the
element's id. A database may hand an id out again after a delete: FalkorDB does (it
also numbers nodes and relationships separately, both from 0, so the app keeps the two
apart in the selection, the inspector and the out-of-date marks). So an answer is
merged only when every element it shares an id with has the same labels (a
relationship: the same type, start and end); otherwise nothing from the answer is
added, the drawn copy is dashed and marked out of date, and you are told. A statement
run in the write console marks the whole drawing out of date, whatever it was: Expand,
Connect and Find path stop sending until the query is run again, and each says "Not
sent: this drawing is out of date. Run the query again." **This cannot catch
everything:** if an element is deleted and another with the same labels (or the same
type and ends) is created, the app cannot tell them apart and the old drawing may show
the new element's properties after a Refresh. Refresh re-reads the database, but it
only shows what is there under that id now. Run the query again to be sure.

The canvas holds at most 1,000 nodes and 2,000 relationships; a result opens with
the first 300 nodes and says how many it left out. Every query the app writes
and sends itself (a label preview, expand, expand by type, connect, path) passes
values as parameters, never spliced into the text, and uses the form each engine
proves to work. The one exception is text the app puts into the editor for you to
read and run ("New query from here", a path's "Open as query"): the editor sends no
parameters, so the element's id is written into the text, and only when it can be
written safely (an integer on FalkorDB and Apache AGE; on Neo4j an id with no
quote, backslash or control character). Otherwise there is no such text. Its first
line is a comment saying the ids are live handles: History and Saved queries keep
the text after the element may be gone, and a database can give a deleted
element's id to another.

**Image export.** The drawing can be saved as SVG or PNG. The picture is written
from the canvas's own positions, colours, badges, captions and relationship
geometry, not taken from the screen, so it covers the whole drawing rather than
the part in view, on the canvas background, in the colours of the current theme
and in the system font. Captions are cut at 24 characters, and relationship labels
are written when no more than 200 relationships are drawn. A PNG is twice the
drawing's size, or smaller for a very large drawing, so that it stays within what
a browser canvas can hold (16.7 million pixels, Safari's limit). A drawing so large
that its PNG would be under a quarter of its size (more than 65,536 units on a
side, or more than about 16,000 by 16,000) gets no PNG: save the SVG, which has no
such limit. A very wide Tree level (a few hundred neighbours of one node) can be
that large.

**Layout.** There are three: Force (the default), Tree (top down) and Left to
right. Force is computed off the main thread, in a Web Worker running d3-force
with a fixed seed, so the same result lays out the same way, and the worker is
stopped when a newer layout replaces it. If the worker cannot run (a VS Code
webview has none), Force places the nodes on a grid and a notice says so; the
page never computes the force layout on the main thread. Tree and Left to right
are the app's own layered layout: the selected node (else the node with the most
relationships) is the root, and each step away from it is one level further down
(Tree) or to the right (Left to right). Relationships that close a cycle are still
drawn but do not move nodes, each connected part of the graph gets its own tree,
and nodes with no relationship go in a block beside the trees. In the tests it
lays out the canvas maximum (1,000 nodes, 2,000 relationships) in under 50 ms
(measured in Node, not in a browser), so it runs on the main thread and works the same in a browser and in VS Code. Tree and Left
to right lay the whole drawing out again when nodes are added; Force places only
the new ones. **Re-run layout** lays out every node again; a node you dragged
stays where you dropped it while **Keep dragged nodes pinned** is on. The view is
fitted to the drawing when a layout lands and with the fit button, not when the
canvas changes size: opening the inspector beside it, or moving the divider, keeps
the view where it is, and only pans as far as it takes to keep the focused node in
sight.

**Keyboard.** The canvas is a single tab stop with roving focus: arrow keys move
to the connected node in that direction, Enter inspects, Space selects, `E`
expands, `C` collapses, Delete or Backspace (the Mac "delete" key) dismisses,
`P` finds a path between two selected nodes, `R` shows the focused node's next
relationship in the inspector (relationships are not tab stops, so this is how a
keyboard reaches them), the Menu key or Shift+F10 opens the focused node's menu,
Escape clears the selection and then a shown path, `?` lists every key, Tab leaves
the canvas. With nothing left to clear, the canvas does not use Escape, so in full
screen it leaves full screen. Each node is spoken with its caption, labels and how many relationships
are shown, and each action is announced through one polite live region.
Animations respect the reduced-motion setting. The Table tab lists the same
result for anyone who would rather not use the canvas.

## Inspecting, menus and styles

**Inspector.** Selecting a node or a relationship opens the inspector in a
column to the right of the canvas. It is part of the page, not a drawer: it has
no overlay, takes no focus when a click opens it (a click moves keyboard focus to the
clicked node, so the canvas keeps panning and the keys keep working), and Escape closes it while focus is inside it. Enter,
Inspect and the menu's Inspect are explicit requests, and they move focus to its
heading. A node shows its labels, id, properties (each with the kind of value that
was received: string, integer, float, boolean, list, map and so on; a whole number
is "integer" because JSON does not tell 1 from 1.0, and a null shows the schema's
sampled type as a sample) and the relationships drawn for
it ("N drawn"; the database's own count of relationships is not known to the
app); a relationship shows its type, ends and properties, with Select start and
Select end; a found path lists its steps and says how it was found (one shortestPath call on Neo4j only; FalkorDB and Apache AGE try depth 1 to N, one call each), with Open as query, Clear path and Copy JSON.
**New query from here** opens a new query tab when the workbench offers one.

**Right-click menus.** A node, a relationship and the empty canvas each have a
menu, drawn inside the canvas. It follows the WAI-ARIA menu pattern: focus moves
to the first item, Up, Down, Home and End move through it, a letter jumps,
Enter or Space chooses, Right opens **Expand by type** and Left goes back,
Escape closes it and returns focus to the node, and Tab closes it. Shift+F10 or
the Menu key opens it at the focused node. Anything that asks the database is
off while this graph's own request is running or the drawing is out of date, and
says so in its title; one asked for while another tab's request runs is refused
with a sentence. **Expand by type (sampled)** lists the relationship types the schema says
can start or end at one of the node's labels; the schema is sampled, so the list can be incomplete. **Find path to...** then waits for
you to click the second node (Escape cancels). **Connect the drawn nodes**
connects every drawn node, as the toolbar button does.

**Search.** The box above the canvas (focus it with `/`) looks only at the drawn
nodes, never at the database: a node matches when the text is in its caption,
one of its labels or any property value, ignoring case. Matching captions come
first. The canvas dims the other nodes; Enter selects the current match and
centres it, Down and Up step to the next and previous.

**View and Export.** The toolbar never wraps. When the width it has cannot hold
every action (the inspector and the legend each take 320 px beside the canvas, and a
VS Code panel is narrow), the focused-node label is hidden first, then the least needed
actions move into a **More** menu, one at a time and always in the same order: Show more nodes,
Clear selection, Connect nodes, Dismiss, Collapse, Fit, Inspect, Find path and Expand;
Stop waiting stays longest while a request runs. Search, **View** and **Export** never
move. **More** follows the same menu keys as the others, and every menu is moved back inside the window when it would run past its edge. On a closed menu button, Down Arrow opens the menu on its first item and Up Arrow on its last. **View** holds Layout (Force, Tree (top down), Left to
right), Re-run layout, whether nodes you dragged stay pinned, the legend, the
keyboard shortcuts and Full screen (while full screen is on, **Exit full screen**
is also a button on the toolbar). Export offers PNG and SVG images and the drawn
graph as JSON, and waits until the canvas has loaded. Where the host cannot
download files (VS Code), it offers Copy SVG and Copy as JSON instead and says why
PNG is not there; if the clipboard refuses, text up to 5 million characters is left on
screen to copy by hand. When no PNG can be made it says why: too large (save the SVG), still
loading, or the image could not be made. The canvas does not refit when the
inspector opens or the window resizes, only on Fit, a new layout and full screen.
Each query tab, and the write console, keeps its layout choice, pinning and
whether the legend is open while its document is open.

**Status line.** One line under the graph replaces the notices that floated over
it. It is one fixed line high, so a notice never resizes the canvas. It holds at most
one item of each kind (out of date, the session's notice, what is running, the
canvas budget, the layout, a path pick, a shown path and the selection); the most
important sits on the line and the others are behind **N more**. A long text shows
its first sentence and the rest behind **Details**. Both open one panel over the
canvas, never two.
An out of date drawing says so once, offers **Rerun**, and keeps the full
explanation in its Details. The result line (rows, time) is on the right.

**Legend and styles.** The legend is closed by default and opens from **View** in the column to the right of the canvas, with the inspector, so it takes 320 px of width and no height: opening it (or the inspector) narrows the canvas and moves actions into **More** when the row is full. Labels are still coloured on the canvas, and in the sidebar, without it. It lists the labels and relationship types that
are drawn, with how many of each (drawn, not in the database). Clicking a label
selects its drawn nodes. **Style** opens an editor under the legend: a label
takes one of the six measured chart colours (or its automatic one), a size (S,
M or L), a caption property and a badge (initials, a dot or none); a
relationship type takes a colour from the four that are at least 3:1 against the
canvas in every shipped theme (yellow and orange are below that in the light
themes, so they are not offered). There is no free colour picker. A label keeps
the colour it was first given, so a label added to the graph later never moves
another label's colour, and up to six labels never share a colour unless you
choose it (the editor says when two labels end up with the same one). Styles, captions included, are saved through the connection's user data; the legend
says where on this mount once the mount knows (the sentence comes from the mount,
not from this page). Until a connection's style has been read, labels are drawn in
one light neutral grey (lighter than an unlabelled node), at the default size and
with initials, rather than in colours that would change a moment later; relationship
types are drawn in the ordinary line colour.

**Badges.** The letters inside a node are the shortest start of its label that no
other label of the connection shares: Person and Product show "Pe" and "Pr",
Topic shows "T". Adding a label that starts the same way lengthens both badges;
colours do not move.

**Keys.** **View**, Keyboard shortcuts, or `?`, opens the shortcuts as another inline
column. Like the inspector it is not a dialog: Escape or Close ends it while
focus is inside.

## The sidebar

For the active connection the sidebar lists its **node labels** and
**relationship types**, with how many there are of each, and a count per label
or type where the node has one. A count marked *about* is the database's
estimate; where counts are missing (Apache AGE before its tables were
analysed), a line under the list says they are not reported. Each label has a
colour dot: the colour the label is drawn in on every screen. Colours are kept
per connection and per account:

- A label gets one of the six chart colours the first time a schema read lists
  it, and keeps it, so a label added to the graph later never changes the
  colour of another. New labels take the free colours in name order, so six
  labels or fewer never share one. The colours come from the connection's
  whole schema, not from what one screen happens to draw.
- When all six are taken, a further label gets a colour of its own from its
  name. A chart colour is given back only when a new label needs one and a
  complete schema read (fresh, not cut short) no longer lists the label that
  had it.
- The colour you choose for a label comes first. Resetting the styles clears
  your choices and keeps the given colours, so nothing else moves.
- Until the stored colours are read (the workspace file in the app, the styles
  file as a dev tool), the dots are grey rather than a colour that would change
  a moment later.

A relationship type shows a line in the colour chosen for it, or in the
relationship colour when none was chosen. A type can only be given one of the
four colours the canvas draws types in; a colour outside those four that an
older file still holds is ignored, and that type is drawn in the relationship
colour.

- Select a label or type, or press Enter on it, to show and run a preview of
  25 rows in a new tab of its workbench.
- The arrow before a name, or Right and Left, opens and closes what the schema
  holds about it: a label's properties with the types observed for them, a
  type's start and end labels (*seen* in data, or *inferred*) and its
  properties. **Collapse all** closes every one.
- Right-click a label or type, use its **…** button, or press Shift+F10 or the
  Menu key on it for its menu: **Preview 25 in a new tab**, **New query with
  this label** (or type: the same query, put in a new tab and not run), **Copy
  name**, and **Copy as pattern**, such as ``(:`Person`)``, quoted the way the
  connection's engine quotes a name. Apache AGE takes plain names only, so for
  any other name there is no pattern to copy. A line under the header says
  what was copied, or, where the window does not allow the clipboard, shows
  the text to copy by hand.
- Keys: Tab moves into the labels, then the relationship types; Up and Down
  move between rows (and through an open row's lines), Home and End jump.

**Refresh schema** asks the node to read the database again. A Refresh pressed
while the schema is first being read is sent once that read ends; one pressed
while the connection is being checked again sends nothing and says so.

The lines under the list say how far the schema can be trusted: how long ago it
was read, that property keys are **sampled** from a few nodes per label (so a
property can exist that is not listed), that a refresh failed and the last good
snapshot is shown, or that an older node reports a schema it cannot refresh. An
empty schema from a node that cannot report one is never presented as an empty
graph.

## Ask

**Ask** in the run bar shows the Ask box, which asks the node's language model
(`get_query`) to write Cypher. What comes back opens in a **new query tab** as a
draft, **not run**: the tab says it is a draft from Ask, quotes the question, and
offers **Back to** the tab you asked from, whose text and results are as they
were. You read the draft, edit it, and press Run. The node has already checked
that it reads only, and the text check runs on it again. When all 8 query tabs
are in use, the draft waits in the Ask box, with **Open the draft** for once a
tab is closed. An answer that arrives after you closed the tab you asked from
is dropped, and one that arrives after you moved to another tab opens behind
it. An answer in words is shown as an answer. A pipeline
with no language model gets a note that says so instead of an error. Any other
failure is shown as an error or a warning. An error leads with the text it came
with: the node's (a model that returned nothing, or the node's refusal of what
the model wrote), the SDK's (a lost connection), or the app's own (the pipeline
is not running, or the answer could not be read). The warnings include a node
that cannot answer Ask yet, which gets the upgrade notice, and a wait the app
gave up on, which says that the node may still be working on the question and
that nothing here can cancel it. An empty question, or one longer than 2,000
characters, is not sent. **Stop waiting** drops a late answer. An Ask counts as the workbench's request
(see One request at a time): Run waits until the node answers it, even after you
stop waiting, for up to two minutes.

## History

Each statement you run is recorded per connection in your RocketRide workspace
file on the server, not in this browser: its text as typed (including any
literal values), when, how long it took, how many rows, and how it ended.
**History** in the run bar shows it beside the tabs, as part of the document
rather than a drawer over it; **Saved** next to it switches to saved queries,
and its close button, or Escape inside it, hides it. You can search, pin, add a
note, load a statement into the editor (in place of the text of the query tab
you were in last), run it again in a new tab (an explicit action), open it in a
new tab without running it, delete entries, clear all, or turn recording off
per connection. Up to 100 entries per connection and 8 KiB of text per entry are
kept, and about 256 K characters of history across all your Graph Explorer
connections: past that, the oldest entries anywhere are dropped first, unpinned
before pinned. When a search or **Pinned only** hides every entry, the panel says
that nothing matches. Tokens and connection strings are never recorded.

## Saved queries and templates

**Saved** in the run bar shows this connection's saved queries beside the tabs.
**Save current query** keeps the text the query tab you were in last holds when
you press it, under a name you type; with no query tab open, or an empty one, it
says so and keeps nothing. A saved query opens in a new tab, not run (**Open in new tab**),
goes into the editor at the caret, replacing any selection (**Insert**), or is
renamed, or deleted after a confirmation. When a save is refused, the panel
shows the reason and keeps nothing. The panel's last line says where saved
queries are kept on this mount.

**Starter templates** are reads to start from. The ones that name a label or a
relationship type take the first one in this connection's schema that has data
and that the engine can quote:

- a sample of the graph (what Explore runs);
- 25 nodes of a label;
- a relationship type between two labels, or the type alone when the schema
  names no pair;
- on Neo4j and FalkorDB, nodes counted by label and relationships counted by
  type;
- on Neo4j, nodes with no relationships.

Apache AGE gets only the first three: the two counts sort by a returned name
(`ORDER BY` on an alias), which its node refuses, and its node does not parse the
pattern predicate in the last one (`WHERE NOT (n)--()` is a syntax error there). No template takes parameters (the
editor sends none).

## As a dev tool

Graph Explorer also runs as a dev tool beside the pipeline editor, in VS Code
and in the RocketRide workspace. There the sidebar lists your graph connections
and shows the active connection's schema, and each workbench and write console
opens as its own document. A connection's row shows its state as a dot and,
when it is not running, in words (**Checking**, **Stopped**, **Unreachable**,
**No access**, **Needs upgrade**); its tooltip names the engine and version,
the pipeline, whether it is **Read-only** or **Writes allowed**, and why it
cannot be browsed. There are no cards, so the counts and the other chips are in
the connection's details (see below) instead. Click a row, or press Enter or Space on it, to open its
workbench. **Refresh** is on the Connections header, and a line under the rows
says when discovery is running, found nothing, or failed. What a card's drawer
shows in the full app (engine, version, target, writes, **Test connection**)
shows inside the connection's own document instead (the size once the
sidebar has read the schema), under its header:
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
- Saved queries and label styles (the colours, sizes, captions and badges
  given to labels and relationship types) are kept in two more files in your
  user folder on the server, `rocketride.graph.saved.json` and
  `rocketride.graph.styles.json`, not in the history file, each with one
  section per account. The sidebar reads and writes them, about a second after
  a change; documents read and change them through the sidebar, for the
  account they were opened under only.
  - The saved-queries file is written only when you save, rename or delete a
    query. The styles file is also written when the sidebar gives new labels
    their colours, and only once it has read that file.
  - Two windows writing the same file at the same time keep the later one's
    copy, of the saved queries as of the styles. The colours the sidebar gives
    by itself only ever write the styles file, so they never cost a saved
    query.
  - If a file cannot be read, what it holds is kept for the session only, the
    file is left alone, and the Saved queries panel says so.
  - After a disconnect or a sign-out, the last changes are written once the
    same account is back while the sidebar is open; if the sidebar closes
    first (VS Code closes it on every disconnect), they are lost. After a
    switch to another account they are dropped, colours the sidebar was about
    to give the previous account's labels included, and that account never
    sees them.
- Query tabs belong to their document. Query 1's draft and the editor height
  last for the session only, and the other tabs' text until the tab or the
  document is closed. Caption choices are part of the label styles, so they
  are kept in `rocketride.graph.styles.json` (above).
- The results Table keeps its sort and shown columns only while it stays on
  screen, as in the full app; nothing about it is written anywhere.
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
shape has a **Write console** button. It is a separate document with one editor
(no query tabs) and an **Execute** button, its header says **Writes allowed**,
and it always says what it is:

- Before anything is sent, a confirmation lists the statements that look like
  they change data, with their text, and says **This is a text check, not a
  database safeguard.** There is no "do not ask again". **Cancel** has the focus
  when it opens, so pressing Enter again sends nothing. A batch the check does
  not flag is sent when you press Execute, without a dialog.
- Statements go through `execute` with the graph result shape, so what a
  statement returned is drawn like any other result. The result line, the strip
  and History show the count the node reports as affected. Apache AGE's node
  reports the number of rows the statement returned there instead (0 for a
  write with no `RETURN`), so on Apache AGE the result line says **Affected
  count not reported by Apache AGE**, and the strip and History show the rows
  returned. There is no row-limit choice here: `execute` returns at most the
  node's own maximum.
- History opens beside the editor here too. **Load into editor** and **Run
  again** only put the statement in the editor; nothing is sent until you press
  Execute.
- Each statement is its own request, sent one by one. A batch stops at the
  first error; a statement that already ran is not undone when a later one
  fails. The strip says how many ran and how many were not run, and the
  confirmation says so before anything is sent.
- A write is never sent again by the app: no automatic retry.
- The console sends one request at a time too, through its own gate (not the
  workbench's): a write you stopped waiting for counts until the database
  finishes it, and until then **Execute** waits and says so.
- A failure that can come after the database ran the statement (the node could
  not return its answer, the answer was not understood, or the app stopped
  waiting) says **the write may have been applied**. Only a refusal before
  anything was sent (the node does not support it, the pipeline is not running,
  execute is off, or the console was still waiting for an earlier statement) means
  nothing changed.
- Every write that may have changed data marks the graphs drawn from that
  connection out of date, in every tab, even when it finishes after the console
  was closed.

## Safety

- The browse editor, the sidebar previews, every graph action and Run on an Ask
  draft use `read_query` (Ask itself calls `get_query`, which writes Cypher and
  runs nothing), which the node runs read-only whatever the node allows
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

- A workbench holds at most 8 query tabs. When the document closes, the full
  app keeps only Query 1's text (as its draft); a dev tool keeps none.
- It reads and writes through the node's tool surface: no cancel of a running
  query, no server-side cursor, no streaming of a large result. A query is
  bounded by the row limit, the node's element and value budgets and its
  statement timeout.
- It does not edit the graph's schema, import or export data, or draw a result
  that has no nodes.
- Tree and Left to right are spanning trees: a node with hundreds of neighbours
  makes one very wide level (or a very tall column), and the tree is rooted at
  the first selected node when a layout runs, not whenever the selection changes.
  Re-run the layout after selecting a different root.
- Find path makes one `shortestPath` call on Neo4j only; FalkorDB and Apache AGE
  try depth 1 to 10, one call each, which takes longer when the path is long or
  there is none.
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
  was measured. Those checks were made before relationships could be clicked.
  Each relationship now also has an invisible hit path, so the browser tests
  the pointer against one more shape per relationship on every move. In a
  synthetic page shaped like the canvas (headless Chrome 156, Apple M4 Pro), one
  such hit test took 0.068 ms without the hit paths and 0.074 ms with them at
  1,000 nodes and 2,000 relationships (0.036 and 0.039 ms at 300 and 600), against
  the 16.7 ms of a frame. The app itself has not been re-measured.
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
