# SQL Explorer

SQL Explorer is the app for working with a database your pipelines already
talk to: browse the schema, read rows, write and run SQL, look at a query
plan, stage a table change. It is not a database client of its own. Every
statement travels through a database tool node inside one of your running
pipelines, so it reaches exactly the database that node is configured for,
with that node's permissions. If apps are new to you, read
[Apps](../../docs/public/product/concepts/apps.md) first. What the app deliberately does not do is under
[Limits](#limits); most of those gaps come from the tool protocol rather
than from the app.

## Before you start

- **A running pipeline with a database node.** Connections are discovered
  from running tasks, so a stopped pipeline has none. The supported nodes
  are [`db_mysql`](../../nodes/src/nodes/db_mysql/README.md), [`db_postgres`](../../nodes/src/nodes/db_postgres/README.md) and
  [`db_clickhouse`](../../nodes/src/nodes/db_clickhouse/README.md).
- **Direct execution, if you want to run statements.** Each of those nodes
  has an **Allow direct query execution** setting (`allow_execute`), off by
  default and worth leaving off until a caller truly needs it. With it off,
  schema browsing, the diagram and the Insights page still work; statements
  do not. The first refused statement raises a banner: `This node does not
  allow execute (allow_execute is off). Schema browsing works; statements
  cannot run.`

## Connections

The Connections page lists every database tool node in every pipeline task
you can see. Each card shows the pipeline, the dialect and a summary of the
schema; selecting one opens a drawer where you can probe the endpoint before
binding to it. An empty list means no running task has a database node.

Opening a connection gives it a workbench document and fills the sidebar
with that database's tables. Everything else hangs off a connection: query
documents, the data browser, the designer and the diagram are each pinned to
one for life, and two documents on two connections never see each other's
history or settings.

## The connection workbench

**Overview** counts the tables, columns and foreign keys, names the dialect,
and lists the tables. Selecting a table opens its record drawer; the header
carries **Refresh Schema**, **Diagram** and **New Query**.

**Insights** reads the same snapshot and says what shape it is in. See
[Insights](#insights).

Both pages read one schema snapshot. The node reflects the database when the
pipeline task starts and serves that reflection to every caller, so the
snapshot is a point-in-time reading, not a live view. Panels derived from it
say so: `from schema snapshot HH:MM`.

## Browsing a table

A table document pages rows through the grid: page size and page number go
straight into `LIMIT` and `OFFSET`, per-column filters and the search box
become a bound `WHERE` clause, and a column sort becomes `ORDER BY`.

With no sort of your own, the app orders by the primary key so paging is
repeatable. A table with no primary key and no sort has no `ORDER BY` at
all, and SQL promises nothing about row order between pages in that case, so
the browser says `No primary key — page order is not guaranteed by the
database` above the grid rather than letting you find out by seeing a row
twice.

## Writing and running queries

A query document is a SQL editor over the results grid.

### What a run sends

The node's `execute` tool takes one statement per call, so a buffer holding
several statements is split in the app before anything is sent. Three ways
to run:

- **Run** sends the selection if there is one, otherwise the statement your
  caret is in (`Ctrl/Cmd+Enter`).
- **Run all** sends every statement in the buffer, in order, and stops at
  the first error (`Ctrl/Cmd+Shift+Enter`).

Before you press anything, the line under the editor names what a run would
send: `Will run: statement 2 of 3 (lines 4–6)`, or `Will run: selection
(lines 2–3)`, or `Will run: nothing — editor is empty`. The editor highlight
and that line always agree. After a batch, a strip above the results carries
one entry per statement, and selecting an entry shows that statement's rows.

The splitter understands strings, quoted identifiers, line and block
comments, and PostgreSQL dollar-quoted bodies, so a semicolon inside any of
those is not a separator. Each dialect's own rules apply: MySQL needs
whitespace after `--` before it is a comment (`SELECT 1--2` is arithmetic),
and a `$tag$` that continues an identifier opens no PostgreSQL dollar quote.
MySQL's `DELIMITER` directive is **not**
supported: a buffer that changes the terminator mid-file splits wrongly, so
run stored-routine definitions through the MySQL client instead.

### Each statement commits on its own

Plain `execute` wraps every call in its own transaction. A batch that fails
on statement 3 therefore leaves 1 and 2 applied, and the error banner says
so. The outcome line names read statements as `ran` and write or DDL
statements as `committed`, for example `1 ran · 2 committed · 3 failed · 4–5
not run`.

For the same reason `BEGIN`, `COMMIT` and `ROLLBACK` are refused before
anything is sent: `Transaction statements have no effect here: each
statement runs and commits on its own.` The node does have a transaction
surface (`begin` / `commit` / `rollback` with a session id), but SQL
Explorer does not use it, and transaction control that quietly does nothing
would be worse than a refusal.

One statement can also arrive twice. If the pipeline task restarts while a
statement is in flight, a statement the app classifies as a read may be
sent once more; a write never is. The classification is by text, so a read
that changes something — `SELECT … INTO`, a `nextval` or another
volatile function — counts as a read here and can be re-sent.

### The row limit

The header toggle offers **200**, **1000** and **All**, applied to
row-returning statements. The results line states what was applied: `1,000
rows returned (limit 1000)` when SQL Explorer appended the limit, `N rows
returned (limit in statement)` when the statement's OUTERMOST query carries
its own `LIMIT` — one inside a subquery bounds that subquery, not the result,
so on **200** or **1000** the app still appends its own — or `N rows returned
(no limit applied)` when nothing bounds the result.

Read `no limit applied` literally, because **All** together with a `LIMIT`
that is not on the outermost query produces exactly that line. Only a
top-level `LIMIT` is recognised, so

```sql
SELECT o.*
FROM orders o
JOIN (SELECT customer_id FROM customers LIMIT 10) c
  ON c.customer_id = o.customer_id
```

run with **All** counts as carrying no limit: nothing is appended and the
line reads `no limit applied`. That is not a mistake in the reading — the
inner `LIMIT 10` bounds the customer subquery, and the statement can still
return every order belonging to those ten customers. The line describes the
RESULT, not the text. Choose **200** or **1000** to have a limit appended to
the outer query, or move the `LIMIT` to the top level, to bound what comes
back.

When the returned count equals an applied limit, a badge reads `Limit
reached — more rows may exist`, because a full page is not evidence the
result ended there.

Above the app's limit sits the node's own `max_execute_rows` cap. A
statement that exceeds it fails rather than returning a truncated answer,
and the banner adds `The node caps results at N rows; choose a lower limit
or add LIMIT.`

### Pattern checks

Before running `UPDATE` or `DELETE` with no `WHERE`, an `UPDATE` or
`DELETE` inside a `WITH` clause, or `TRUNCATE`, `DROP` or `ALTER`, the app
asks: `Pattern check: <kind> detected. This is a text check, not a database
safeguard.` Confirm with **Run statement**, or **Run and stop asking on this
connection**.

A statement that begins with `WITH` is checked on the verb the chain
carries: `WITH audit AS (SELECT id FROM orders) DELETE FROM orders` deletes
every row and is asked about like any other `DELETE` with no `WHERE`. A
`WITH` clause whose body LEADS with `UPDATE` or `DELETE` — even behind a
read-only `WITH` chain of its own — is reported as `UPDATE inside a WITH
clause` or `DELETE inside a WITH clause` instead, with no verdict on its
`WHERE`, because the text check cannot tell what a `WHERE` inside the clause
applies to. When both apply, the outer statement is the one named.

The verb has to be the statement's own, not a word inside one of its
clauses: `SELECT ... FOR UPDATE` locks rows, and an upsert's `ON CONFLICT
... DO UPDATE` belongs to its `INSERT`, so neither is asked about. `INSERT`
is never flagged, inside a clause or out.

`EXPLAIN ANALYZE` runs the statement it describes rather than only planning
it, so it is checked as that statement: `EXPLAIN ANALYZE DELETE FROM orders`
is asked about like the `DELETE` it would run. A plain `EXPLAIN` runs
nothing and is never asked about.

Read that sentence literally. The check reads the statement text; it never
consults the database, does not know what a `WHERE` clause actually matches,
and prevents nothing. It is not called a safe mode anywhere, and when it is
off the editor line carries a `Pattern checks off` control, so the state is
never invisible.

### When a statement fails

The banner leads with the database's own first line, prefixed `Database
reported: `. Any wrapper the node puts around that line is left out of the
headline, so what follows `Database reported: ` is the database speaking; a
collapsible **Database said** block holds the message verbatim, exactly as
it reached the app. It also names the statement, its lines, and which
earlier statements already ran or committed.

Whether the driver text arrives at all depends on the node version. Older
nodes swallow the database's message and return a generic string; in that
case the banner says so instead of inventing detail: `The database's message
was not returned by this node version. The pipeline node's log has it.` The
message is in the pipeline node's log either way.

### Stop waiting

Nothing in the tool protocol cancels a running statement. A second after a
statement reaches the database a **Stop waiting** button appears, and it
does exactly what it says: the app stops listening and discards the late
answer.

It is not offered while a confirmation is still open, because nothing has
been sent yet. In a run of several statements the second is counted from the
first one dispatched, so the button stays available for the rest of an
uninterrupted run; a confirmation between statements takes it away until the
next statement is sent.

The banner is explicit — `Stopped waiting after N.N s. The statement may
still be running on the database; this tool cannot cancel it.` To stop it,
stop it on the database.

### Autocomplete

Suggestions come from the schema snapshot: columns of the aliased or named
table after a `.`, table names after `FROM` / `JOIN` / `UPDATE` / `INTO`,
then columns of any table mentioned in the buffer, then keyword snippets
(`SELECT … FROM`, `JOIN … ON`, `INSERT … VALUES`, `UPDATE … SET … WHERE`,
`CREATE TABLE`, `EXPLAIN`). Identifiers are quoted per dialect. A table
created since the task started is not in the snapshot, so it is not
suggested.

## Results

Columns are typed, and the header tooltip says on what basis. When the app
can name the single source table and every returned column belongs to it,
the type comes from the schema and reads `BIGINT (schema)`; otherwise it is
inferred from the returned values and reads `number (inferred from N rows)`.
Numbers are right-aligned and sort numerically; leading-zero strings stay
strings. Selecting a row opens a cell inspector with every column's full
value, so a long JSON document is readable without widening the grid.

Export is the grid's own exporter, in the gear menu of the grid header, and
carries the rows that run returned under whatever limit was applied.

A precision note rides under any result with a numeric column: `Decimal
values arrive as floating point; integers above 2^53 lose precision.` That
is the node's value conversion rather than the grid's rendering, so it
applies to exports too.

## Query history

The history drawer lists what you ran on this connection, newest first, with
search and filters for reads, writes, errors and pins. Expanding an entry
shows the full statement, its outcome and its round trip, and lets you load
it into the editor, run it again, pin it, annotate it or delete it.

**Where it is stored matters.** History goes to your RocketRide workspace
preferences on the server, per user, not into the browser, and the drawer
says so whenever it is open: `Saved in your RocketRide workspace file on the
server, not in this browser. Statements are stored as typed, including
literal values.` A literal typed into a `WHERE` clause is stored as typed.
A failed statement is stored with its failure message as that message
reached the app — the node's own wrapper included, not just the sentence
the banner quotes — and such a message can carry a value from the
statement. Both stay in the preferences file until the entry is deleted,
the list is cleared, or the bounds below trim it. It is not a server audit
log, and not a place for secrets.

The list is bounded, because the preferences file is read and written on
every app switch: 100 entries per connection including pinned ones, 8 KB per
statement, 256 KB across all connections. Recording can be turned off per
connection, and **Clear** empties one connection's list, pins included.

Re-running an entry that changed data asks first and quotes what it did last
time; the rerun is a fresh run with its own entry.

## Relationships

The table record drawer shows the table's columns, primary key and declared
foreign keys, and adds:

- **Referenced by (n)** — the tables whose foreign keys point at this one,
  each opening its own drawer.
- **Query** — **Select top 100** and **Count rows**, which open a new query
  document with the statement written and nothing run.
- **Join path** — pick a second table and the app walks the declared foreign
  keys for the shortest paths, up to four joins. Where several equally short
  paths exist, or two tables are joined by more than one key, it lists them
  all rather than picking one silently; composite keys produce a
  multi-column `ON`.

Only **declared** foreign keys are used, anywhere: in the drawer, in join
generation and in the review rules. Two columns that look related because of
their names are not treated as related. ClickHouse declares no foreign keys
at all, so these sections say `ClickHouse declares no foreign keys; join
paths are unavailable.`

**Open as query** writes the join into a new query document. Generated SQL
is never run for you: the document opens under the banner `Generated preview
— review, then Run`, and the statement carries `-- generated from declared
foreign keys; review before running`. The banner clears on your first edit
or run.

## Insights

The Insights page orients you in an unfamiliar schema and reviews it. It
reads the snapshot only, queries nothing and changes nothing, so it works on
a connection where execution is off. The orientation strip names hubs (the
most-referenced tables, with their inbound count), leaves (tables that only
reference others) and isolated tables; every name opens that table's drawer.

Three rules produce findings:

| Rule | What it reports |
| --- | --- |
| R1 | The table has no primary key, so rows cannot be addressed individually and the data browser cannot page in a guaranteed order. |
| R2 | The two sides of a foreign key spell their type differently. Informational — the comparison is textual after normalisation, and the engine may accept both. |
| R3 | A foreign key names a table or column that is not in this snapshot. |

The limitations footer is the scope of every claim on the page: the rules
read columns, primary keys and declared foreign keys and nothing else.
Indexes, other constraints and the data are not inspected, and a finding is
a reading of one snapshot rather than a verdict on the database.

## Query plans

The plan drawer (**Explain**, or `Ctrl/Cmd+Shift+E`) runs a plain `EXPLAIN`
for the same statement Run would send, including any limit the header
applied. The form is per dialect: `EXPLAIN FORMAT=JSON` on MySQL, `EXPLAIN
(FORMAT JSON)` on PostgreSQL, plain `EXPLAIN` on ClickHouse. On any other
dialect the drawer says `EXPLAIN is not available for <dialect> in SQL
Explorer`.

**The raw output is the default view**, because it is what the database
actually sent; an interpreted tree sits beside it as a second tab. A plan
shape the parser does not recognise is an informational note next to the raw
text — `Could not interpret this plan shape; raw output shown` — never an
error, because nothing went wrong on the database's side.

Every number in the tree is a planner estimate. Plain `EXPLAIN` does not run
the statement, so nothing on this page was measured; numbers are suffixed
`est.` under the legend `Planner estimates, not measurements.` There is no
`EXPLAIN ANALYZE`. The parsers are tested against recorded fixtures rather
than a live database.

## Changing a table

The table designer stages changes rather than applying them as you type: you
edit columns, keys and types, and the view keeps a plan and shows the exact
DDL it will run. Nothing reaches the database until you apply.

The Apply confirmation names how many statements will run, lists the inbound
foreign keys that reference any column you are dropping, renaming or
retyping (`from schema snapshot HH:MM`), and carries the dialect's commit
note. Those notes never say "rollback", because nothing here rolls back:

- **MySQL** — each DDL statement commits implicitly. A failure mid-plan
  leaves earlier statements applied. Nothing here can be rolled back.
- **PostgreSQL** — each statement runs in its own autocommit transaction. A
  failure mid-plan leaves earlier statements applied.
- **ClickHouse** — some `ALTER` forms run as asynchronous mutations and may
  finish after the dialog closes.

A batch that stops part-way reports what committed, which statement failed
and what was not run, and the plan keeps the remaining statements.

**After a successful apply**, what the app can tell you depends on the node.
When the node offers a `refresh_schema` tool, the app re-reads the schema
and says `Applied HH:MM · schema re-read from the database.` When it does
not, the snapshot is still the one taken at task start, and the banner says
so: `Applied HH:MM. The node reflected its schema at task start; the tree
and diagram will not show this change until the pipeline restarts.` The
statements ran either way; only the app's picture of the schema is behind.

## Limits

- **No cancel.** **Stop waiting** stops the app waiting, not the database.
- **No transactions.** Every statement commits on its own, and transaction
  control is refused.
- **No `EXPLAIN ANALYZE`.** Plan numbers are estimates, never measurements.
- **No `DELIMITER`.** Buffers that change the terminator split wrongly.
- **Declared foreign keys only.** Nothing is inferred from column names, and
  ClickHouse declares no foreign keys at all.
- **The schema is a snapshot** from pipeline start, unless the node can
  re-read it.
- **The editor loads Monaco from a CDN.** An air-gapped browser gets the
  rest of the app without a working SQL editor.

## Next steps

- [`db_mysql`](../../nodes/src/nodes/db_mysql/README.md), [`db_postgres`](../../nodes/src/nodes/db_postgres/README.md) and
  [`db_clickhouse`](../../nodes/src/nodes/db_clickhouse/README.md): the nodes behind every
  connection, including the tool surface and the direct-execution setting.
- [Apps](../../docs/public/product/concepts/apps.md): what an app is and how it reaches your engine.
- [Shell API](../../docs/public/product/guides/apps/index.md): the framework SQL Explorer is built on, when
  you want to build one of your own.
