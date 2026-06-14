# Node Service Definitions (`services.json`)

A node lives in `nodes/src/nodes/<node>/` and is defined by one or more
**`services*.json`** files. That one file pulls triple duty:

1. **Registers** the node with the engine (protocol, class, executable).
2. **Declares how it connects** to other nodes (`lanes`).
3. **Describes its configuration UI**, which the visual canvas renders
   automatically (`preconfig`, `profiles`, `fields`, `shape`).

A directory may contain several definitions (`services.chat.json`,
`services.manager.json`, …); each registers a separate service/variant. The files
are **JSONC**: `//` comments and trailing commas are allowed, so they cannot be
read with a strict JSON parser.

> For the catalog of all nodes and how they wire together, see
> [README-nodes.md](README-nodes.md). For testing, see
> [README-node-testing.md](README-node-testing.md).

---

## Top-level keys

| Key             | Required | Purpose                                                                 |
| --------------- | :------: | ----------------------------------------------------------------------- |
| `title`         |    ✓     | Display name shown on the canvas tile.                                   |
| `protocol`      |    ✓     | Endpoint protocol, e.g. `llm_openai://`.                                 |
| `classType`     |    ✓     | What the node is, e.g. `["llm"]`, `["tool"]`, `["store"]`. Drives catalog grouping and behavior. |
| `capabilities`  |    ✓     | Engine behavior flags, e.g. `["invoke"]`.                               |
| `register`      |          | `filter`, `endpoint`, or omitted. Registers a factory of that type.      |
| `node` / `path` |          | Runtime (`python`) and module path (`nodes.llm_openai`).                |
| `prefix`        |    ✓     | Prefix added/removed when converting URLs ⇄ paths.                       |
| `description`   |          | Array of strings (joined) describing the node.                          |
| `icon`          |          | SVG filename next to the definition (auto-discovered, auto-themed).     |
| `tile`          |          | Rendering hints shown on the canvas tile.                               |
| `lanes`         |          | **Data-flow ports** (see below). Absent for `tool` nodes.              |
| `preconfig`     |          | Default profile + named `profiles` merged into config.                 |
| `fields`        |          | Config field schema the canvas renders (RJSF).                         |
| `shape`         |          | Layout of fields into UI sections.                                     |
| `test`          |          | Automated test cases (see README-node-testing.md).                     |

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

## `preconfig` and `profiles`: preset configurations

`preconfig` holds the default profile name and a map of named **profiles**. A
profile is a preset bundle of values (model, token limits, etc.) merged into the
node config unless the profile is `absolute`:

```jsonc
"preconfig": {
  "default": "gemini-2.5-flash",
  "profiles": {
    "gemini-2.5-flash": { "title": "Gemini 2.5 Flash", "model": "gemini-2.5-flash", "modelTotalTokens": 1048576, "apikey": "" },
    "gemini-2.5-pro":   { "title": "Gemini 2.5 Pro",   "model": "gemini-2.5-pro",   "modelTotalTokens": 1048576, "apikey": "" }
  }
}
```

---

## `fields`: the configuration schema (rendered by the canvas)

`fields` is a JSON-Schema-flavored description of every configurable value. The
canvas renders it with **RJSF (React JSON Schema Form)**, so each field becomes a
form control automatically. Supported per-field keys include `type`, `title`,
`description`, `default`, `format` (e.g. `textarea`), and `enum`:

```jsonc
"accessibility.spatialFormat": {
  "type": "string",
  "title": "Spatial Format",
  "default": "clock",
  "enum": [
    ["clock", "Clock positions (12 o'clock, 3 o'clock)"],
    ["relative", "Relative (left, right, ahead, behind)"]
  ]
}
```

Two dynamic features are used heavily:

- **Profile selector**: a field (commonly `<node>.profile`) whose options are
  generated from the profiles via a reference pattern, and which swaps the visible
  fields with `conditional`:

  ```jsonc
  "accessibility_describe.profile": {
    "title": "Vision Model",
    "type": "string",
    "default": "gemini-2.5-flash",
    "enum": ["*>preconfig.profiles.*.title"],          // options pulled from profiles
    "conditional": [
      { "value": "gemini-2.5-flash", "properties": ["accessibility_describe.gemini-2.5-flash"] },
      { "value": "gemini-2.5-pro",   "properties": ["accessibility_describe.gemini-2.5-pro"] }
    ]
  }
  ```

- **Property groups**: an entry whose `properties` array lists which fields to
  show together for a given profile/object.

---

## `shape`: UI layout

`shape` arranges fields into labeled sections in the node's config panel:

```jsonc
"shape": [
  { "section": "Pipe", "title": "Accessibility Describe", "properties": ["accessibility_describe.profile"] }
]
```

---

## How the canvas consumes this

The visual builder (`packages/shared-ui/src/components/canvas/`) turns these
definitions into the editor:

- The node graph is rendered with **ReactFlow**; config panels with **RJSF**.
- `NodeConfigPanel` renders `fields`/`shape` into the side panel, wires up custom
  widgets (API-key, select, OAuth, …) from `canvas/components/rjsf-widgets/`, and
  validates server-side.
- Field defaults are resolved from the schema (`getDefaultFormState`) rather than
  hardcoded, so `default` values in `fields`/`profiles` are what the user starts
  with.

You do **not** register nodes anywhere central: dropping a `services*.json` (plus
its SVG) under `nodes/src/nodes/<node>/` is enough for the build to discover it.

---

## Full example

`nodes/src/nodes/accessibility_describe/services.json` is a compact, complete
example: metadata + `lanes` (`image → text`) + three Gemini `profiles` + `fields`
with a conditional profile selector + a one-section `shape` + `test` cases. Read
it alongside this document.
