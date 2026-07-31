# Node Service Definitions (`services.json`)

A node lives in `nodes/src/nodes/<node>/` and is defined by one or more
**`services*.json`** files. That one file pulls triple duty:

1. **Registers** the node with the engine (protocol, class, executable).
2. **Declares how it connects** to other nodes (`lanes`).
3. **Describes its configuration UI** via `propertyDefinitions` and
   `properties`.

A directory may contain several definitions (`services.chat.json`,
`services.manager.json`, …); each registers a separate service/variant. The files
are **JSONC**: `//` comments and trailing commas are allowed, so they cannot be
read with a strict JSON parser.

> For the catalog of all nodes and how they wire together, see
> [README-nodes.md](README-nodes.md). For testing, see
> [README-node-testing.md](README-node-testing.md).

---

## Top-level keys

| Key                    | Required | Purpose                                                                 |
| ---------------------- | :------: | ----------------------------------------------------------------------- |
| `title`                |    ✓     | Display name shown on the canvas tile.                                   |
| `protocol`             |    ✓     | Endpoint protocol, e.g. `llm_openai://`.                                 |
| `classType`            |    ✓     | What the node is, e.g. `["llm"]`, `["tool"]`, `["store"]`. Drives catalog grouping and behavior. |
| `capabilities`         |    ✓     | Engine behavior flags, e.g. `["invoke"]`.                               |
| `register`             |          | `filter`, `endpoint`, or omitted. Registers a factory of that type.      |
| `node` / `path`        |          | Runtime (`python`) and module path (`nodes.llm_openai`).                |
| `prefix`               |    ✓     | Prefix added/removed when converting URLs ⇄ paths.                       |
| `description`          |          | A string, or an array of strings concatenated as-is (embed `\n` where a line break is wanted). |
| `icon`                 |          | SVG filename next to the definition (auto-discovered, auto-themed).     |
| `lanes`                |          | **Data-flow ports** (see below). Absent for `tool` nodes.              |
| `propertyDefinitions`  |          | Named property definitions, global and/or local (see below).           |
| `properties`           |    ✓     | Ordered list of properties shown in the node's config panel (see below). |
| `test`                 |          | Automated test cases (see README-node-testing.md).                     |

---

## `lanes`: how the node connects (data flow)

`lanes` maps each **input** lane to the list of **output** lanes it produces:

```jsonc
"lanes": {
  "image": ["text"]   // consumes `image`, produces `text`
}
```

Two nodes are wire-compatible when an upstream **output** type matches a
downstream **input** type. Nodes with **no `lanes`** (most `tool` nodes) do not
flow data, they **bind to an agent's tool channel** instead. The full lane-type
ontology and the wire-vs-bind rule live in
[README-nodes.md → How nodes connect](README-nodes.md#how-nodes-connect).

---

## `propertyDefinitions`: named property definitions

`propertyDefinitions` is a map of name → property definition. The name is the
map key; it is never repeated inside the definition itself.

- **Global** definitions live in `nodes/src/nodes/core/services.common*.json`
  and are available to every node.
- **Local** definitions live in the node's own `services*.json`, under its own
  `propertyDefinitions`, and are only visible to that node.

On a name collision, the **local** definition wins.

A definition may be a plain field, or one of the structural forms described
under [Property notations](#property-notations) below.

---

## `properties`: the config panel

`properties` is the ordered list of what's shown in the node's config panel.
Each entry is one of:

- **a bare string** — a reference to a `propertyDefinitions` entry by name.
- **`{"use": "name", ...overrides}`** — same, with the listed members merged
  on top of the referenced definition (overrides win).
- **an inline object carrying its own `"name"`** — a fully authored property,
  not resolved via lookup.

A `propertyDefinitions` entry may itself be written as `{"use": "name",
...overrides}` to alias another property under a locally unique name, e.g.:

```jsonc
"propertyDefinitions": {
  "qdrant.cloud.host": { "use": "vector.host", "description": "Enter the server IP address e.g. <your-instance-name>.<region>.qdrant.io" }
}
```

The final property name is always the **last dot-separated component** of
whatever reference produced it (`vector.host` → `host`, `qdrant.cloud.host` →
`host`) — the dotted prefix exists only to keep `propertyDefinitions` keys
globally unique, and is dropped for the name shown in the final schema. Names
must be unique among siblings within the same `properties` list (or the same
group/branch — see below).

---

## Property notations

- **Plain field** — `type`, `title`, `description`, `default`, plus the flags
  `hidden`, `secret`, `readonly`, `required`. Standard constraints also apply:
  `minLength`/`maxLength` for strings, `minimum`/`maximum` for numbers.
- **Enum** — `"enum": [["value", "Label"], ...]`.
- **Enum with property sets** — when different values expose different
  sub-properties, `"enum"` is an object keyed by value instead of an array:
  ```jsonc
  "enum": {
    "cloud": { "title": "Cloud", "properties": ["vector.host", "vector.port"] },
    "local": { "title": "Local", "properties": ["vector.host"] }
  }
  ```
- **Grouped subsection** — `{"name": "...", "properties": [...]}`, groups
  related fields together.
- **Array** — `{"name": "...", "type": "array", "item": <property specifier>}`,
  a repeatable list of a single field (the item can itself be a reference or
  an inline definition). `"type": "array"` is required.
- **`type: "constant"`** — a fixed, non-editable value baked into the schema
  (e.g. a discriminator field).
- **`type: "oauth2"`** — an OAuth login action; the UI drives the flow and
  supplies the resulting credentials. `"options"` may carry hints such as
  `scopes`.
- **`type: "upload"`** — a file upload; `"options": {"accept": "..."}`
  restricts the accepted file type.

---

## Full example

`examples/services.example.json` demonstrates every notation above in one
file. `nodes/src/nodes/store_qdrant/services.json` is a complete real-world
example: metadata + `lanes` + local `propertyDefinitions` that alias global
`vector.*` properties under node-specific names + a `properties` list built
around an enum-with-property-sets profile selector.
