# SQL Explorer

Work with your SQL databases — MySQL, PostgreSQL and ClickHouse — right
inside RocketRide: browse the schema, page through rows, edit them, write and
run SQL, ask for a query in plain words, read a query plan, review the
schema's health, draw the relationship diagram, and stage table changes with
the DDL spelled out before anything runs.

<p align="center">
  <img src="./assets/screenshot.png" alt="SQL Explorer" width="900">
</p>

Every statement travels through a RocketRide database node, so it reaches
exactly the database that node is configured for, with that node's
permissions — whether that node lives in one of your pipelines or in a small
tool pipeline the app runs for you (see [Connections](#connections)). If
apps are new to you, read
[Apps](../../docs/public/product/concepts/apps.md) first. What the app
deliberately does not do is under [Limits](#limits); most of those gaps come
from the tool protocol rather than from the app.

SQL Explorer runs in the RocketRide shell as an app, and as a dev tool: in
rocket-ui's tool panel and inside the RocketRide VS Code extension, where
the connection list sits in the sidebar and each connection opens as its own
document. It is the same app either way, and your connection list follows
you between them; what differs in a dev tool is under
[As a dev tool](#as-a-dev-tool).

## Before you start

- **A reachable database.** The supported engines are the ones with database
  nodes: [`db_mysql`](../../nodes/src/nodes/db_mysql/README.md),
  [`db_postgres`](../../nodes/src/nodes/db_postgres/README.md),
  [`db_clickhouse`](../../nodes/src/nodes/db_clickhouse/README.md) and
  [`rocketride_sql`](../../nodes/src/nodes/rocketride_sql/README.md), plus
  `db_supabase`, the Supabase preset of the `db_postgres` node (see its
  [Supabase section](../../nodes/src/nodes/db_postgres/README.md#supabase-preset)).
  You either point the app at a database node already running in one of your
  pipelines, or give it the connection details directly.
- **Direct execution, if you want to run statements.** Each database node
  has an **Allow direct query execution** setting (`allow_execute`), off by
  default and worth leaving off until a caller truly needs it. With it off,
  schema browsing, the diagram and the Insights page still work; statements
  do not. The query page says `This node does not allow execute
  (allow_execute is off). Schema browsing works; statements cannot run.` For
  a pipeline connection the setting belongs to that pipeline's node; for a
  direct connection it is part of the configuration you enter.

## Connections

The sidebar carries your connection list. Each saved connection is a row;
hovering one offers edit and delete, **+ New Connection** opens the add
dialog, and clicking a row opens that database's workbench. The list is
saved per user on the server you are connected to, so the same connections
appear in the shell, in the App Builder preview and in VS Code. Change
connections in one window at a time: each window writes the whole list it
holds, so the last to save wins, an older safety level included.

<p align="center">
  <img src="./assets/new-connection.png" alt="Adding a connection" width="700">
</p>

**New Connection** offers two paths:

- **From pipeline** finds the database nodes in the pipelines you are
  running yourself (your own development runs) and lets you pick one. The
  connection stays bound to that node: it works while that pipeline runs and
  goes dark when it stops, and statements run with exactly that node's
  configuration and permissions. A team deployment of a pipeline is not
  offered. An empty list means none of your running pipelines has a database
  node.
- **Direct** takes the connection details itself — you pick the engine and
  fill in the same configuration form the pipeline editor uses. When you open
  a direct connection, the app starts a small temporary pipeline holding just
  that database node, and stops it when you close the connection's last
  document (an idle one is stopped after 15 minutes either way; the app
  restarts it the next time you run something).

A direct connection's configuration is stored as typed in your per-user file
on the server. For passwords and other secrets, use a `${ROCKETRIDE_*}`
environment reference instead of the literal value — the server stores those
encrypted.

A connection whose pipeline is not running says so instead of opening.
Signing in as another user, organization or team clears the connection list,
reads it again for the new sign-in, and closes every document that belonged
to a connection, so the previous account's results are not left on screen.
Signing out, or a dropped connection, closes nothing: open documents forget
the schema and wait until an account is signed in again. The app never saves
or shows a task token; a direct connection's configuration is saved as typed
(see above).

Each row says how its connection stands, from what the app already knows
(nothing is sent to find out):

- **Running** or **Stopped**, for a pipeline connection: whether your own
  run of that pipeline is running.
- **Direct**, for a direct connection, or **Open** while its temporary
  pipeline runs.
- **Unreachable**: the connection failed to open although its pipeline runs,
  or the database node does not answer.
- **No access**: its pipeline runs, but your role may not call the
  database node (a team deployment you can see but not use).

Hovering the word gives the reason. Until the app has first looked at your
running pipelines, a pipeline row says nothing.

## The connection workbench

Opening a connection gives it a workbench document, whose Overview page lists
that database's tables; the sidebar lists connections only. Query documents,
the data browser, the designer and the diagram are each tied to one
connection, and two documents on two connections never see each other's
history or settings. Press **?** anywhere outside a text field or the SQL
editor, or use the **Shortcuts** button, to list the keyboard shortcuts.

**Overview** counts the tables, columns and foreign keys, names the dialect,
and lists the tables in the connection's default schema. Clicking a table
row opens its Data page; **Details** opens its record drawer instead. The
header of Overview, Insights and Diagram carries **Refresh Schema**,
**Shortcuts** and **New Query**.

The app finds out once when a connection opens whether the node runs
statements: it sends `SELECT 1`. It goes straight to the node, so it is not in your
query history. If the node has `allow_execute` off, the connection is
**schema only**: the header says so, and Run, Run all, Explain, New Query,
**Select top 100**, **Count rows**, **Open data**, **+ Create Table** and
History's **Rerun** are off with the reason shown, and the Data page says it
cannot read rows. **Design** still opens, to read a table's structure and its
DDL, and says that Apply is off. The
run shortcuts send nothing either and say why, so no statement, and no row
estimate for a confirmation, reaches the node. Tables, columns, keys,
Diagram and Insights keep working. After you turn `allow_execute` on and
restart the pipeline, **Check again** on the Overview page (or **Refresh
Schema**) looks again. While the answer is not known yet, nothing is
disabled.

The schema is a point-in-time reading, not a live view: the node reflects
the database when the pipeline starts. Panels derived from it say so: `from
schema snapshot HH:MM`.

### Data

A table's Data page pages rows through a grid. The search box, filter chips
and column sorts all narrow what the database returns. A very large table is
slow on deep pages, because the pager can jump to any page.

**Search and filters.** The search box looks in the text columns and ignores
case; **contains** and **starts with** ignore case too; **equals** and **not
equals** compare exactly, as the database does (on PostgreSQL `NOTE 2` does
not match `note 2`; MySQL's usual collations ignore case). Until the app
knows the database, text matches follow the database's own `LIKE`. A `%`,
`_` or `\` you type matches itself. **+ Filter** adds a chip
above the grid: a column, an operator (equals, not equals, contains, starts
with, `>`, `<`, `≥`, `≤`, is null, is not null) and a value. What you type is
never pasted into the statement. On a number or yes/no column the value is
sent as a number or a boolean, so `5` compares as 5. Chips, header filters and
the search box apply together (AND). The grid's sorters show as chips too;
removing one clears that sort. Any change goes back to page 1.

**Counting rows.** The total in the pager is counted once per filter; paging
and changing the sort or page size reuse it. A write made elsewhere (a Query
statement that may have changed rows, a History rerun, a designer Apply) makes
the page count again; a read or a failed statement does not. On a table with no filter, the
app first reads the engine's own row estimate. Below 100,000 rows it then
counts exactly; from 100,000 rows up, the grid shows `About N rows (estimate)` with a **Count
exactly** button, and the estimate can be well off (MySQL's often is, by 40
to 50 percent). When the engine has no estimate, the app counts exactly. A
filtered search on a large table is not counted at all: the note says `More
rows match` and the pager offers a next page, until you press **Count
exactly**.

**Order.** With no sort of your own, the app orders by the primary key so
paging is repeatable. A table with no primary key and no sort has no
guaranteed row order between pages, and the grid says `No primary key: page
order is not guaranteed by the database` above the rows.

**The record drawer.** Click a row to open it. The drawer lists every column
in the table's own order, with its type, a `PK` mark where it applies, and a
copy button for each value and for the whole row as JSON. Prev and Next move
through the page. A value is shown as the browser received it (see
[Query](#query)): very large numbers and decimals may be shown rounded.

A value that belongs to a foreign key is a link that opens the referenced row
in a drawer on top, with a back arrow. If nothing matches, the drawer says
so; if more than one row matches, it shows the first and says that too. A
NULL key is not a link. A key that reached the browser as a number beyond
±9,007,199,254,740,991 was already rounded on the way, and could be another
row's key, so it is not looked up: the link is off and says `This key is too
large to look up exactly in the browser.` A key the node sends as text is
exact and is followed as usual. A binary key (the same types as under [Changing rows](#changing-rows)) is
sent as text that is not the stored key, so its link is off too and says `This key is binary, which the
node sends as text, so it cannot be looked up here.`

**Rows that reference this one** lists the tables whose foreign keys point at
the row's table. **Show rows** opens that table's data with a chip already set
to this row's key, and is off, with the same reason, for a key too large to
hold exactly, and for a binary key.

The table's own drawer (**Details** on the Overview, or a name in Insights)
offers **Open data**, **Design**, **Copy name**, **Copy SELECT**, **Select top 100** and **Count rows** (the last two open a
new query with the statement written and nothing run), and a **Join path**:
pick a second table and the app lists the shortest paths of declared foreign
keys between them, up to four joins. **Open as query** writes the join into a
new query. It opens under the banner `Generated preview: review, then Run`,
and nothing runs until you press Run. Only **declared** foreign keys are used,
anywhere; ClickHouse declares none, so these sections say `ClickHouse
declares no foreign keys; join paths are unavailable.`

### Changing rows

Rows are changed from the row drawer, and nothing is written until you
apply. **Edit** opens a form with one field per column and a **NULL** box
for each; key columns are shown but cannot be changed. **Delete** marks the
row, and **Undo** takes a staged change back. **Insert row**, above the
grid, opens the same form empty: a field left empty takes the column's
default, and NULL is sent only when its box is ticked. A value is checked
against the column's type when you stage it (a fraction for a whole-number
column is refused, and a number is never rounded on the way).

Staged rows are marked in the grid: a tint, plus ✎ before an edited value
(its tooltip says what it was) and **Deleted** on a deleted row, which is
struck through. New rows are not shown in the grid. The bar above it counts
every change, for example `3 pending changes to orders: 1 edited row, 1 new
row, 1 deleted row. Nothing is saved yet, and closing this tab discards
them.` **Discard** drops them all (it
asks first when there are two or more), **Review SQL** shows each
statement with its values written in place (Apply sends the values
separately, never in the text), and **Apply** asks first, then sends them. Opening another
table's data while changes are staged asks first (`You have 3 staged
changes. Discard them and open customers?`).

Each change is one statement that must change exactly one row. It names the
row by its full primary key and, for an edit, by the old values of the
columns you changed (for a delete, of every column). So a row someone else
changed or deleted since you loaded it matches no row, and the apply stops:
`This row was changed by someone else since you loaded it. Reload, then edit
again.` Only values that come back exactly are compared: whole numbers,
decimals declared with up to 15 digits, text and booleans. Floating-point,
date and time, JSON and binary columns, and longer or unconstrained
decimals, are matched by key only, so a change someone else made to them is
not detected; Review SQL names those columns, for edits and deletes alike
(`Changes to price can't be checked for conflicts`). On a case- or
accent-insensitive collation (MySQL `_ci` and `_ai` collations, PostgreSQL
`citext`), the database calls two values equal when they differ only in case
or accents, so a change of that kind alone is not detected.

On PostgreSQL, and on a MySQL table whose storage engine keeps transactions
(InnoDB or NDB), the changes run as one transaction: all are saved, or none, and the
confirmation says so. On a MySQL table whose engine keeps none (MyISAM, for
one) each change commits on its own, and the confirmation says that instead;
when the app cannot read the engine, or does not know it, the confirmation
hedges. Where the node has no transaction tools (an older node), nothing is
sent: the app asks again, saying that each change will commit on its own and that a failure
leaves earlier changes saved, and sends the statements one by one only if you
agree; the first failure stops the rest.

Inside the transaction, each statement may take up to 5 minutes (less if the
node publishes a shorter deadline), the time the node keeps an idle
transaction open. A statement still running after that stops the apply: the
app stops waiting and rolls back, and the statement keeps its locks on the
server until it ends. A statement committed on its own waits like a Query-page
statement.

An apply says what it cannot know. A failure counts as "nothing saved" only
when the database or the node answered with a refusal. When an answer never
arrives (a dropped connection, a wait that ran out), the result says the
change, or the commit, may or may not have been saved, and asks you to check
the data; a row change in that state leaves the bar rather than being sent
again. When the rollback itself is not confirmed, the result adds that the
database may hold locks on the table for up to 5 minutes, until the node
rolls the transaction back. If an apply's answer never arrives at all, the
changes stay staged and the page is read again, but **Apply** waits until you
open **Review SQL**, which says some rows may already be saved and that a new
row could be inserted twice. After a successful apply, each statement is
recorded in [Query history](#query-history) (unless recording is off for the
connection), the saved changes leave the bar,
and the page and its row count are read again.

Rows cannot be changed in a table without a primary key, on ClickHouse (no
unique row keys, and its updates run as background mutations), on a
connection that cannot run statements, in a table whose primary key is a
binary column (`binary`, `varbinary`, the blob types, `bytea`, `bit` or
`varbit`), or while the connection (in the dev tool, the sidebar) cannot be
reached. The buttons are off, and the drawer says why. A MySQL
`VARCHAR(n) BINARY` key is not one of these: the database reports it as text
with a `_bin` collation, so it stays editable. A key beyond ±9,007,199,254,740,991 that the browser received as a
number may already have been rounded, so that row cannot be changed here.

### Structure and Design

The table designer stages changes rather than applying them as you type: you
edit columns, keys and types, and the view keeps a plan and shows the exact
DDL it will run. Nothing reaches the database until you apply.

The Apply confirmation names how many statements will run, lists the inbound
foreign keys that reference any column you are dropping, renaming or
retyping (`from schema snapshot HH:MM`), and carries the dialect's note on
what happens to a plan that stops half-way:

- **PostgreSQL** — Apply asks for one transaction, so a failure rolls back
  the whole plan and the plan stays as it was. The result says `The plan
  runs as one transaction: a failure rolls back the whole plan` only when
  the node confirms the plan ran as one. A node without the transaction
  tools gets nothing: the app asks again, saying each statement would commit
  on its own, and runs the plan that way only if you agree.
- **MySQL** — each DDL statement commits implicitly. A failure mid-plan
  leaves earlier statements applied. Nothing here can be rolled back.
- **ClickHouse** — some `ALTER` forms run as asynchronous mutations and may
  finish after the dialog closes.

A plan that runs statement by statement and stops part-way reports what
committed, which statement failed and what was not run, and the plan keeps
the remaining statements. When the answer to a statement never arrives, the
result says it may have run and takes it out of the plan, so it is not run
twice by accident; when the commit's answer never arrives, the result says
the plan may or may not have been saved. Either way the schema is read
again. On PostgreSQL, each statement of the transaction may take up to 5 minutes; one
still running after that stops the apply and the plan is rolled back. On
MySQL, on ClickHouse, and on a PostgreSQL node without the transaction tools,
each statement commits on its own and waits like a Query-page statement, so a
long `ALTER` is not cut off. The designer's Apply records its statements in
[Query history](#query-history), like the grid's.

After a successful apply, the schema is re-read when the node can do that,
and the banner says `Applied HH:MM · schema re-read from the database.`
(`Applied HH:MM as one transaction · …` on PostgreSQL). When it cannot, the
banner says so: `Applied HH:MM. The node reflected its schema at task start;
the tree and diagram will not show this change until the pipeline restarts.`
The statements ran either way; only the app's picture of the schema is
behind.

### Query

A query document is a SQL editor over the results grid.

<p align="center">
  <img src="./assets/query.png" alt="Running a query" width="900">
</p>

**Run** sends the selection if there is one, otherwise the statement your
caret is in (`Ctrl/Cmd+Enter`). **Run all** sends every statement in the
buffer, in order, and stops at the first error (`Ctrl/Cmd+Shift+Enter`). The
line under the editor says what a run would send before you press anything:
`Will run: statement 2 of 3 (lines 4–6)`, `Will run: selection (lines 2–3)`
or `Will run: nothing (editor is empty)`. After a batch, a strip above the
results has one entry per statement; selecting one shows that statement's
rows. Semicolons inside strings, quoted names, comments and PostgreSQL
`$$` bodies do not split a statement. MySQL's `DELIMITER` directive is not
supported: run stored-routine definitions through the MySQL client.

**Each statement commits on its own.** A batch that fails on statement 3
leaves 1 and 2 applied, and the error banner says so. The outcome line names
reads as `ran` and writes or DDL as `committed`: `1 ran · 2 committed · 3
failed · 4–5 not run`. `BEGIN`, `COMMIT` and `ROLLBACK` are refused before
anything is sent, because they would do nothing here: `Transaction
statements have no effect here: each statement runs and commits on its own.`
Only Apply runs as one transaction: staged row changes on PostgreSQL and on
MySQL tables whose engine keeps transactions, and a designer plan on
PostgreSQL.

**Row limit.** The header toggle offers **200**, **1000** and **All**. The
results line says what applied: `1,000 rows returned (limit 1000)` when the
app added the limit, `N rows returned (limit in statement)` when your
statement has its own `LIMIT` (or `FETCH FIRST … ONLY`) on the outermost
query, and `N rows returned (no limit applied)` when nothing bounds the
result. A `LIMIT` inside a subquery bounds only that subquery, so on **200**
or **1000** the app still limits the outer query, and with **All** the line
reads `no limit applied`. A statement that ends in a locking clause (`FOR
UPDATE`, `FOR SHARE`, MySQL's `LOCK IN SHARE MODE`) gets the limit in front of
that clause, which both MySQL and PostgreSQL accept; ClickHouse `SETTINGS` and
`FORMAT` clauses are handled the same way. A `SELECT … INTO` returns no rows,
so it gets no limit, and it counts as a write. When the count equals the
limit, a badge says `Limit reached — more rows may exist`. On PostgreSQL,
where `#` is an operator, and before the dialect is known, a locking or `LIMIT`
clause behind a `#` on the same line is left alone: the statement goes out as
typed and the line reads `no limit applied`. Before the dialect is known, the
same holds for `SETTINGS` and `FORMAT`. On MySQL and ClickHouse that text is a
comment, and the limit goes on a new line.

Above the app's limit sits the node's own `max_execute_rows` cap. A statement over
it fails rather than returning a truncated answer, and the banner adds `The
node caps results at N rows; choose a lower limit or add LIMIT.` **All** says
so before anything runs: `All asks for every row. The node refuses results
over its cap (25,000 unless the pipeline sets max_execute_rows) and may be
slow.`

**When a statement fails.** The banner leads with the database's own first
line, prefixed `Database reported: `; a collapsible **Database said** block
holds the message verbatim. It also names the statement, its lines, and which
earlier statements already ran or committed. Older nodes return a generic
string instead of the database's message; the banner then says `The
database's message was not returned by this node version. The pipeline node's
log has it.`

**Stop waiting.** Nothing in the tool protocol cancels a running statement. A
second after a statement reaches the database a **Stop waiting** button
appears: the app stops listening and discards the late answer. The banner is
explicit — `Stopped waiting after N.N s. The statement may still be running
on the database; this tool cannot cancel it.` To stop it, stop it on the
database. A read you stopped waiting for, or a plan or table page you
navigated away from, is not sent again and its answer is not shown. Closing
the query tab or switching away from the app during a run also ends the run:
nothing after the statement already sent goes out, and that statement's
result is neither shown nor added to History.

**Autocomplete** reads the schema snapshot, so a table created since the
pipeline started is not suggested.

**Results.** Columns are typed, and the header tooltip says on what basis:
`BIGINT (schema)` when the single source table is known, `number (inferred
from N rows)` otherwise. Selecting a row opens a cell inspector with every
column's full value. A precision note shows on the results' header line when
a value may not be the number the database holds: `Decimal values arrive as floating
point; integers above 2^53 lose precision.` It applies to exports too. Rows
arrive keyed by column name, so two columns with the same name merge into
one; when a statement projects `*` over a join, or names the same output
column twice, the results say `Columns with the same name are merged; alias
them`. The check is narrow: an unaliased expression (`count(*)` twice) is not
caught.

### Diagram

The **Diagram** page shows the declared foreign keys as a graph. Clicking a
table opens its Data page. While the schema is being read the page says
`Reading the schema…`; if the read fails it says `Could not read the schema`
and offers Retry.

### Insights

Insights reviews the schema from the snapshot only. It queries nothing and
changes nothing, so it works on a connection where execution is off. The
orientation strip names hubs (the most-referenced tables), leaves (tables
that only reference others) and isolated tables; every name opens that
table's drawer. Three rules produce findings:

| Rule | What it reports |
| --- | --- |
| R1 | The table has no primary key, so rows cannot be addressed individually and the data browser cannot page in a guaranteed order. |
| R2 | The two sides of a foreign key spell their type differently. Informational: the engine may accept both. |
| R3 | A foreign key names a table or column that is not in this snapshot. |

The rules read columns, primary keys and declared foreign keys and nothing
else. Indexes, other constraints and the data are not inspected, and a
finding is a reading of one snapshot rather than a verdict on the database.

**Explain** (`Ctrl/Cmd+Shift+E`) opens the plan drawer, which runs a plain
`EXPLAIN` for the statement Run would send. The raw output is the default
view; an interpreted tree sits beside it. Every number in the tree is a
planner estimate, suffixed `est.`, under the legend `Planner estimates, not
measurements.` On a dialect other than MySQL, PostgreSQL and ClickHouse, the
drawer says `EXPLAIN is not available for <dialect> in SQL Explorer`.

## Confirmations and safety levels

Each saved connection has a **safety level**, set in its connection editor
under **Safety level for this connection**, or on the Query page:

- **Don't ask**: a statement you run from the editor is sent without asking.
  (History's rerun of a write still asks, and Apply always confirms.) The row
  limit still applies (see [Query](#query)).
- **Ask before risky writes** (the default): asks before `UPDATE` or
  `DELETE` with no `WHERE`, an `UPDATE` or `DELETE` inside a `WITH` clause,
  `TRUNCATE`, `DROP` and `ALTER`, and before an `EXPLAIN ANALYZE` of
  anything but a read. An `INSERT`, and an `UPDATE` or `DELETE` that has a
  `WHERE`, do not ask at this level.
- **Ask before every write**: asks before anything that is not a read.
  Reads are `SELECT` (a `WITH … SELECT` included), `EXPLAIN`, `SHOW` and
  `DESCRIBE`. Everything else asks: `INSERT`, a bounded `UPDATE` or
  `DELETE`, `MERGE`, `SELECT … INTO`, `CREATE`, and also `CALL`, `GRANT`,
  `SET`, `DO` and `VALUES`, because a procedure can change rows and the app
  cannot tell. `EXPLAIN ANALYZE` counts as the statement it runs.

A write made inside a function or procedure is not seen at **Ask before
risky writes**: `SELECT my_fn()`, `DO`, `CALL` and `COPY … PROGRAM` run
without asking there, whatever they change. And a `SELECT` that calls a
function counts as a read even at **Ask before every write**, so a function
that writes (`SELECT pg_terminate_backend(…)`, `SELECT nextval('s')`) never
asks.

The level is stored on the saved connection, so it is the same in the app and
as a dev tool. A connection saved before levels existed reads as **Ask before
risky writes**. The line under the editor names the level and changes it in
place: only the level is sent, so a direct connection's password is neither
re-typed nor sent again. Lowering the level asks first, from the Query page
or the connection editor. The dialog has no answer that turns asking off;
change the level there or in the connection editor instead.

The dialog says what the statement does, quotes it, and says how it runs
(at once, committing on its own) and why it asked: `<connection> is set to
ask before risky writes. This is a check on the statement text, not a
database permission.` For a statement that changes rows it adds **Rows that
change**: `about N rows (planner estimate)` on PostgreSQL and MySQL, from a
plain `EXPLAIN` (no `ANALYZE`, so nothing runs). It reads `Estimating…` while
that runs, and `No estimate` on ClickHouse, for a `WITH` chain, or when the
plan gives no number; for `TRUNCATE` it reads `Every row`. Once an `UPDATE` or
`DELETE` on one table with a `WHERE` has an estimate, the title and the button
name the rows: `Update about 20 rows in orders?` and **Update 20 rows**. With
no `WHERE`, they say every row instead (`Delete every row from orders?`). A
`LIMIT` or a join bounds what the statement reaches, so then the body says `No
WHERE clause: this can delete every row the statement reaches.`, the title
names no count, and the estimate is marked as one that may be wrong. **Cancel**
works at any time. The estimate is not recorded in History.

`DROP` and `TRUNCATE` ask for the name to be typed: `Type orders to confirm`.
The name is the object's own name as the statement spells it, without quotes
or schema (`DROP TABLE "public"."Order Items"` asks for `Order Items`). The
match is exact, and the confirm button stays disabled until the text matches.
A statement with several targets (`DROP TABLE a, b`), or one whose name the
app cannot read (`DROP FUNCTION f(int)`), asks for the verb instead.

`WITH audit AS (SELECT id FROM orders) DELETE FROM orders` is asked about like
any other `DELETE` with no `WHERE`. A `WITH` clause whose body leads with
`UPDATE` or `DELETE` is reported as `UPDATE inside a WITH clause` or `DELETE
inside a WITH clause`, with no verdict on its `WHERE`. `SELECT ... FOR UPDATE`
and an upsert's `ON CONFLICT ... DO UPDATE` are not risky writes.

`EXPLAIN ANALYZE` runs the statement it describes, so both asking levels ask
before one that runs anything but a read, even when that statement alone would
not ask: `EXPLAIN ANALYZE DELETE FROM orders WHERE id = 7` deletes the row.
That covers PostgreSQL's `ANALYSE` and option lists (`EXPLAIN (ANALYZE)`), and
MySQL's `DESCRIBE ANALYZE` and `DESC ANALYZE`. A plain `EXPLAIN`, `DESCRIBE` or
`DESC` runs nothing and never asks. The plan drawer never sends `EXPLAIN
ANALYZE`.

Read "a check on the statement text" literally. It does not use database
permissions, does not know what a `WHERE` clause actually matches, and
prevents nothing; the node's `allow_execute` switch is the real gate.

## Query history

The history drawer lists what you ran on this connection, newest first, with
search and filters for reads, writes, errors and pins. Expanding an entry
shows the full statement, its outcome and its round trip, and lets you load it
into the editor, run it again, pin it, annotate it or delete it. Re-running an
entry that changed data asks first and quotes what it did last time, whatever
the connection's safety level; the rerun is a fresh run with its own entry,
and the safety level can ask again before it is sent. 

**Where it is stored matters.** In the app, history goes to your RocketRide
workspace preferences on the server, per user, not into the browser, and the
drawer says so: `Saved in your RocketRide workspace file on the server, not in
this browser. Statements are stored as typed, including literal values.` As a
dev tool it goes to a history file in your user storage on the server (see
[As a dev tool](#as-a-dev-tool)). A write whose outcome is not known (you stopped waiting, or a commit's answer
never arrived) is shown as `outcome unknown`, because it may have been saved.
A failed statement is stored with its
failure message as it reached the app, and such a message can carry a value
from the statement. Both stay until the entry is deleted, the list is cleared,
or the bounds below trim it. It is not a server audit log, and not a place for
secrets.

The list is bounded: 100 entries per connection including pinned ones, 8 KB
per statement, 256 KB across all connections. Recording can be turned off per
connection, and **Clear** empties one connection's list, pins included.

**Accounts.** History belongs to the account that ran it. When you sign out, or
another account signs in, the app forgets the history it was holding before it
shows anything for the next account. As a dev tool, each account has its own
section of the history file. In the app there is a gap: the shell reads your
workspace preferences once per page and keeps them until the page reloads, so
after another account signs in without a reload the app shows that account no
history, records none of its statements, and saves nothing to the workspace
preferences (no history, saved query, grid layout or drawer width) until the
page is reloaded. The History drawer says `Signed in as a different account:
reload the page to see your history.` A write the shell itself makes in that
time, such as switching to another app or changing the theme, still writes the
preferences it holds, the first account's history and saved queries among
them, into the signed-in account's file, so reload the page before working as
another account.

## Saved queries

A statement you want to keep can be saved under a name, for one connection.
**Save as query** sits in the query header, for the editor's text, and on
every History entry, for that statement; the name starts as the statement's
leading `--` comment or its first line. **Saved**, also in the query header,
opens the connection's saved queries, where you can search, open, rename and
delete them. **Open** puts the statement into a new query and runs nothing: it
waits there for Run.

A saved query keeps the statement's text as typed, literal values included,
never its results. In the app it goes to your RocketRide workspace preferences
on the server, per account, not into the browser. As a dev tool it goes to
`.workspace/rocketride.sql.queries.json` in your user storage on the server,
beside the history file, one section per signed-in account. If the dev tool
cannot read that file it never writes it, and saved queries are kept for that
session only. Two windows that change saved queries at the same time each
write the file from what they read, so the last one to save wins. Saved
queries belong to the account that saved them, and signing out, or another
account signing in, stops showing them at once. As a dev tool, each account
has its own section of the file, so one account's saved queries are never
shown to or written for another. In the app, another account signing in
without a reload sees no saved queries and can save none until the page is
reloaded; the drawer says `Signed in as a different account: reload the page
to see your saved queries.` What the shell itself may still save in that time
is under [Query history](#query-history).

Change saved queries in one window at a time: if two windows change them,
the one that saves last overwrites the other's change.

Saving refuses rather than drops. A connection keeps up to 50 saved
queries; a saved query holds up to 16,384 characters of statement and 120 of
name; and all saved queries together stay within 256 KB. A save past one of
these says which and saves nothing, and nothing already saved is removed to
make room.

## Ask

**Ask**, above the query editor, turns a question in plain words into SQL
for you to review. It sends the question to the database node's `get_sql`
tool, which needs an LLM connected to that node in its pipeline. The node's
LLM writes the query, the node checks it with `EXPLAIN` (which does not run
it), and the SQL comes back unexecuted. It opens in a new query under the
editor's `Generated preview: review, then Run` banner, with your question as a
comment above it. Nothing runs until you press Run.

What goes to the model: your question; the node's schema as the node reflects
it (table and column names, their types, primary and foreign keys); and the
database description set on the node, if any. No rows are sent. When the
database rejects a draft, its error message goes back to the model for another
try, up to the node's validation attempts (five by default). The bar says this
too.

When the node does not return SQL, the bar shows the node's own words: its
refusal, the database's error, the model's answer when the question is not one
for the database, or that no LLM is connected to the node. The node's safety
check refuses queries that start with `WITH`: it returns only statements that
start with `SELECT` or `EXPLAIN`. A direct connection's pipeline holds just the
database node, so it has no LLM: there the bar is disabled and says `Ask needs
a pipeline whose database node has an LLM connected.` Ask waits up to 120
seconds for the node's answer.

## Export

**Export** on the results card offers **Download CSV**, **Download JSON** and
**Copy as Markdown**, for the rows the statement returned under whatever limit
was applied. In CSV a NULL is an empty field and an empty string is `""`, and
objects are written as JSON text. A spreadsheet runs a CSV cell that starts
with a formula character, so in CSV, text that starts with `=`, `+`, `-` or `@`
(or a tab or a carriage return) gets a leading `'`. Numbers keep their sign,
and JSON and Markdown keep the text as it is. In VS Code, which does not allow
downloads from a tool panel, CSV and JSON are copied to the clipboard instead,
and the menu says **Copy as CSV** and **Copy as JSON**. Elsewhere the app
announces that the download started; a browser that blocks it quietly cannot be
told apart.

## As a dev tool

As a dev tool, SQL Explorer is split in two. The sidebar is the connection
list and holds the tool's one connection to the RocketRide engine; each saved
connection (and the connection editor) opens as its own document, and a
document reaches the engine only through the sidebar. The same features are
there, with these differences:

- **History lives in a file.** The tool keeps query history in
  `.workspace/rocketride.sql.history.json` in your user storage on the server,
  beside the saved connections, one section per signed-in account. It is read
  before anything is recorded, so it is never overwritten by an empty list. If
  the file exists but cannot be read, history is kept for that session only and
  nothing is written to it. Two windows that change history at the same time
  each write the file from what they read, so the last one to save wins. What
  survives a change:
  - **Sign-out, the connection drops, or the organization changes:** the
    last unsaved statements are held, and nothing is written while nobody is
    signed in. They are written when the same account is known again while
    the sidebar is open. They are dropped if the sidebar closes while nobody
    is signed in (in VS Code it closes when the connection drops).
  - **Another account signs in** (or the organization or team changes): the
    previous account's last unsaved statements are dropped. They are never
    written into another account's file.
  - **A statement run while the history file is still being read** is saved
    once the read ends; if the account changes or the sidebar closes before
    that, it is lost.
  - **More than 128 history views open at once:** the oldest views stop
    updating until they are opened again.
- **The safety level is the connection's.** It is stored on the saved
  connection, so it is the same as in the app (see
  [Confirmations and safety levels](#confirmations-and-safety-levels)).
- **The connection is the sidebar's.** When the engine connection drops, run
  and apply are disabled in every document, and a statement that was waiting
  is reported as possibly still running. An action taken while the connection
  is down is not sent at all. A document restored before the SQL Explorer
  sidebar was opened asks the host to open the sidebar for it, and says
  "Starting SQL Explorer…" meanwhile. Only if no sidebar answers within a few
  seconds does it ask you to open it. A document that is already open stays
  open, with run and apply disabled, while the sidebar is closed. While nobody
  is signed in, a document says it is waiting for sign-in.
- **Grid layouts are kept for the session.** A grid's sort, page size and the
  widths of fixed-size columns are kept in memory (a column that stretches to
  fit is not kept at a width, and neither is a width under 60 px): in
  rocket-ui until the page reloads, in VS Code
  until the document's panel closes. The full app keeps them in its workspace
  preferences.
- **Account changes close documents.** A document opened under one account
  closes itself when another account signs in; while nobody can be vouched for
  (signed out, connection dropped) it only forgets the schema, and it opens or
  reads nothing on its own until an account is signed in again.
- **Engine error codes.** In VS Code a statement refused while its pipeline
  restarts is not sent again (see [For contributors](#for-contributors)); the
  refusal is shown as the engine worded it.
- **Waits.** A statement on a node that publishes no deadline is waited for up
  to 24 hours (the longest wait the tool sets on any request), or twice that
  when a read is sent again after its pipeline restarted, plus the few minutes
  it may take to reach the connection, after which the document stops waiting;
  the statement itself is not stopped.

## Limits

- **No cancel.** **Stop waiting** stops the app waiting, not the database.
- **No client timeout on a statement** unless the node publishes a statement
  deadline: today's SQL nodes publish none and the engine sets none, so a long
  query is allowed to run until you stop waiting. Reading the schema waits up
  to 60 seconds, re-reading it 135, and the engine check 15.
- **Transactions only through Apply.** A statement you run commits on its own,
  and transaction control you type is refused. Only Apply (staged row changes
  on PostgreSQL and on transactional MySQL tables, and designer plans on
  PostgreSQL) runs as one transaction. Elsewhere each statement commits on its
  own, and the confirmation says so before anything is sent: a MySQL table
  whose engine keeps no transactions, and every MySQL or ClickHouse designer
  plan. A node without the transaction tools sends nothing until you agree to
  that.
- **Closing a connection's tab discards its staged changes.** Neither the app
  nor the dev tool can ask before a tab closes, so the pending-changes bar says
  so instead. Reloading the page discards them too. Apply or Discard first.
- **Conflict checks are partial.** Edits compare only exactly-comparable
  columns, and case- or accent-only changes on insensitive collations go
  undetected (see [Changing rows](#changing-rows)).
- **The plan drawer never runs `EXPLAIN ANALYZE`.** Its numbers are estimates,
  never measurements. An `EXPLAIN ANALYZE` typed into a query runs like any
  statement, and is checked as the statement it runs.
- **Accounts in the full app.** A write the shell makes itself, such as
  switching to another app or changing the theme, can still copy the previous
  account's history and saved queries into a new account's file until you
  reload (see [Query history](#query-history)).
- **A pipeline connection needs its pipeline running**, and opens your own
  development run: a team deployment of the same pipeline cannot be saved or
  opened as a connection. A direct connection's temporary pipeline is the app's
  to start and stop.
- **A direct connection's new settings apply once its pipeline restarts.**
  Editing its configuration (host, database, credentials) without changing its
  engine leaves the temporary pipeline already running with the settings it
  started with, until every document of the connection is closed or the
  pipeline idles out (15 minutes); the next document then starts it with the
  new settings. Changing the engine starts a new pipeline right away.
- **Tables from the connection's default schema only.** Tables in other
  schemas, and views, do not appear in the Overview, the Diagram or
  autocomplete.

## For contributors

How the pieces behave underneath, for people changing the code.

- **A statement is sent a second time in one case only.** When the pipeline
  task is stopping or restarting, the engine refuses a statement with
  `TASK_STOPPED` before it reaches the database, so nothing has run. A
  statement the app classifies as a read is then sent once more, after the same
  connection is running again within 15 seconds; a write never is. The
  classification is by text: a `SELECT … INTO`, which fills a new table, a file
  or variables (see [Query](#query)), counts as a write and is never re-sent, but a read that changes
  something through a function counts as a read here. It is still never run
  twice, because the refusal comes before the database sees it. A statement
  that reached the database is never re-sent, whatever happens to its answer.
  As a dev tool the sidebar checks this again for every statement it is sent,
  with the dialect the database node reports (it asks the node when it does not
  know yet). If the node cannot say which dialect it speaks, the statement is
  sent once and never repeated.
- **The classifier reads text, not server settings.** A setting that changes
  how the server reads text (MySQL's `NO_BACKSLASH_ESCAPES` or `ANSI_QUOTES`,
  PostgreSQL with `standard_conforming_strings` off) is not taken into account,
  and a read that changes something through a function (`SELECT
  nextval('s')`) still counts as a read. Until the dialect is known, a
  statement is read with every engine's comment rules (`#` is a comment on
  MySQL and ClickHouse, `/*! … */` is code on MySQL) and asks if any reading
  says it should.
- **An atomic apply runs through the node's transaction tools:** `begin`, the
  statements on that one connection, then `commit`; any failure sends
  `rollback`. A per-statement apply (no transaction tools, a table whose engine
  keeps none, a MySQL or ClickHouse designer plan) sends each statement on its
  own and stops at the first failure. The
  whole list is checked before anything is sent: each entry is exactly one
  statement, transaction control is refused, and on MySQL one transaction holds
  only `INSERT`, `UPDATE`, `DELETE` and `REPLACE`. Values are always bound,
  never written into the statement text, and nothing in an apply is sent twice.
- **Limit placement.** The app only recognises a top-level `LIMIT` or `FETCH {
  FIRST | NEXT } … ONLY`, and `WITH TIES` still counts as the statement's own
  bound. A statement ending in its own `OFFSET` keeps the appended `LIMIT`. A
  `WITH` chain containing `FOR UPDATE` or `FOR NO KEY UPDATE` is read as a
  write and gets no limit. ClickHouse's `LIMIT n BY` is not a statement limit.
  On ClickHouse, and on a connection whose dialect could not be probed, the
  limit goes in front of `SETTINGS` and `FORMAT`.

## Next steps

- [`db_mysql`](../../nodes/src/nodes/db_mysql/README.md), [`db_postgres`](../../nodes/src/nodes/db_postgres/README.md)
  (including its [Supabase preset](../../nodes/src/nodes/db_postgres/README.md#supabase-preset), provider `db_supabase`),
  [`db_clickhouse`](../../nodes/src/nodes/db_clickhouse/README.md) and
  [`rocketride_sql`](../../nodes/src/nodes/rocketride_sql/README.md): the nodes behind every
  connection, including the tool surface and the direct-execution setting.
- [Apps](../../docs/public/product/concepts/apps.md): what an app is and how it reaches your engine.
- [Shell API](../../docs/public/product/guides/apps/index.md): the framework SQL Explorer is built on, when
  you want to build one of your own.
