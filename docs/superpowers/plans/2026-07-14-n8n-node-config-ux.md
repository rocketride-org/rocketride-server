# n8n Node Configuration UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the n8n node configuration inside RocketRide lean and understandable by showing only relevant timeout/authentication fields and exposing schema descriptions through accessible information icons.

**Architecture:** Keep `services.json` as the source of field order, conditional branches, requiredness, and tooltip copy. Reuse one small `FieldLabelWithInfo` presentation component across the existing RJSF text, select, API-key, and checkbox widgets. Preserve every existing configuration key and all runtime behavior; do not touch the separate RocketRide community node inside n8n.

**Tech Stack:** RocketRide service JSON schema, Python/pytest, React 18, TypeScript, MUI, `@rjsf/utils`, pnpm, RocketRide builder.

---

## Baseline and constraints

- [ ] Work only in `.context/worktrees/rocketride-server-n8n-ux` on `feat/RR-1230-n8n-node`.
- [ ] Preserve the approved design in `docs/superpowers/specs/2026-07-14-n8n-node-config-ux-design.md`.
- [ ] Do not edit the separate `n8n-nodes-rocketride` community package.
- [ ] Do not add cards, section primitives, accordions, an Advanced group, or a React test framework.
- [ ] Baseline checks already established on 2026-07-14:
  - `python3 -m pytest -q nodes/test/test_tool_n8n.py` → 66 passed.
  - `python3 -m pytest -q nodes/test/test_contracts.py -k n8n` → 2 passed.
  - `./builder vscode:compile` → passed and compiled the shared canvas through the VS Code consumer.
  - Raw `pnpm exec tsc --noEmit -p packages/shared-ui/tsconfig.json` is not a supported standalone gate and has unrelated pre-existing errors; use `./builder vscode:compile`.

## Task 1: Lock down and implement conditional n8n fields

**Files:**

- Modify: `nodes/test/test_tool_n8n.py`
- Modify: `nodes/src/nodes/tool_n8n/services.json`

### Step 1: Add the failing schema regression test

- [ ] Add this helper and test near the imports/config tests in `nodes/test/test_tool_n8n.py`:

```python
_SERVICES_PATH = _NODES_SRC / 'nodes' / 'tool_n8n' / 'services.json'


def _conditional_properties(field):
    """Return each conditional value mapped to its child field names."""
    result = {}
    for conditional in field['conditional']:
        values = conditional['value'] if isinstance(conditional['value'], list) else [conditional['value']]
        for value in values:
            result[value] = conditional['properties']
    return result


def test_services_schema_only_shows_relevant_n8n_fields():
    service = json.loads(_SERVICES_PATH.read_text())
    fields = service['fields']

    assert fields['tool_n8n.apiKey']['optional'] is True
    assert _conditional_properties(fields['tool_n8n.mode']) == {
        'sync': ['tool_n8n.syncTimeout'],
        'async': ['tool_n8n.asyncTimeout'],
    }
    assert _conditional_properties(fields['tool_n8n.webhookAuth']) == {
        'none': [],
        'header': ['tool_n8n.webhookHeaderName', 'tool_n8n.webhookHeaderValue'],
        'basic': ['tool_n8n.webhookUser', 'tool_n8n.webhookPassword'],
        'bearer': ['tool_n8n.webhookToken'],
        'jwt': ['tool_n8n.webhookToken'],
    }

    conditional_fields = {
        'tool_n8n.syncTimeout',
        'tool_n8n.asyncTimeout',
        'tool_n8n.webhookHeaderName',
        'tool_n8n.webhookHeaderValue',
        'tool_n8n.webhookUser',
        'tool_n8n.webhookPassword',
        'tool_n8n.webhookToken',
    }
    top_level = set(service['shape'][0]['properties'])
    assert conditional_fields.isdisjoint(top_level)
    assert all(fields[field].get('optional') is not True for field in conditional_fields)
```

### Step 2: Prove the test fails for the intended reason

- [ ] Run:

```bash
python3 -m pytest -q nodes/test/test_tool_n8n.py -k services_schema_only
```

- [ ] Expect a failure because the API key is not optional and the two controlling enums do not yet define `conditional` branches. Do not proceed if it fails for a syntax/import reason.

### Step 3: Implement the service-schema behavior

- [ ] In `nodes/src/nodes/tool_n8n/services.json`:
  - Add `"optional": true` to `tool_n8n.apiKey`.
  - Add `mode.conditional` branches for `sync` and `async`.
  - Rename timeout labels to `Response timeout (seconds)` and `Execution timeout (seconds)`.
  - Add `webhookAuth.conditional` branches for `none`, `header`, `basic`, and the shared `["bearer", "jwt"]` token branch.
  - Rename conditional credential labels to `Header name`, `Header value`, `Username`, `Password`, and `Token`.
  - Remove `"optional": true` from conditional credential fields so the active branch requires them.
  - Remove timeout and credential child fields from top-level `shape[0].properties`.
  - Keep all configuration keys, defaults, secure flags, widgets, and runtime code unchanged.

### Step 4: Prove the schema and runtime remain green

- [ ] Run:

```bash
python3 -m pytest -q nodes/test/test_tool_n8n.py -k services_schema_only
python3 -m pytest -q nodes/test/test_tool_n8n.py
python3 -m pytest -q nodes/test/test_contracts.py -k n8n
```

- [ ] Expect 1 schema test passed, 67 total `tool_n8n` tests passed, and 2 n8n contract tests passed.

### Step 5: Commit Task 1

- [ ] Review `git diff --check` and the scoped diff.
- [ ] Commit:

```bash
git add nodes/test/test_tool_n8n.py nodes/src/nodes/tool_n8n/services.json
git commit -m "feat(nodes): simplify n8n configuration fields"
```

## Task 2: Add a reusable accessible information label

**Files:**

- Create: `packages/shared-ui/src/components/canvas/components/rjsf-widgets/field-label-with-info/FieldLabelWithInfo.tsx`
- Modify: `packages/shared-ui/src/components/canvas/components/rjsf-widgets/base-input-template/BaseInputTemplate.tsx`
- Modify: `packages/shared-ui/src/components/canvas/components/rjsf-widgets/select-widget/SelectWidget.tsx`
- Modify: `packages/shared-ui/src/components/canvas/components/rjsf-widgets/api-key-widget/ApiKeyWidget.tsx`
- Modify: `packages/shared-ui/src/components/canvas/components/rjsf-widgets/checkbox-widget/CheckboxWidget.tsx`

### Step 1: Confirm the approved UI-test exception

- [ ] Do not introduce a React unit-test framework for this focused change. The repository has no component-test harness for `shared-ui`; use lint, the real consumer build, source review, and manual canvas QA as specified in the approved design.
- [ ] Preserve the current checkbox behavior as the reference: 16px neutral-gray info icon, MUI tooltip, immediately after the label.

### Step 2: Create `FieldLabelWithInfo`

- [ ] Implement a small component that accepts:
  - `label: ReactNode`
  - `description?: ReactNode`
  - `fieldTitle?: string`
  - `id?: string`
- [ ] Render the label without an icon when the description is empty.
- [ ] Otherwise render a MUI `Tooltip` with `placement="right"` around a focusable inline `span` containing `InfoIcon`.
- [ ] Give the focus target an accessible label such as `More information about ${fieldTitle}`.
- [ ] Keep the icon presentation centralized: `ml: 0.5`, `fontSize: 16`, neutral secondary text color, inline-flex alignment.
- [ ] Do not pass current field values into the component or tooltip.

### Step 3: Use the shared label in each widget

- [ ] `BaseInputTemplate`: resolve `options.description ?? schema.description` and wrap the existing `labelValue(...)` output.
- [ ] `SelectWidget`: resolve the same description and wrap the existing `labelValue(...)` output without changing enum/value handling.
- [ ] `ApiKeyWidget`: destructure `schema` and `options`, wrap its existing label, and leave masking, deletion, secure values, and environment-variable autocomplete untouched.
- [ ] `CheckboxWidget`: replace its local `Box`/`Tooltip`/`InfoIcon` rendering with `FieldLabelWithInfo`; retain `descriptionId(id)`, checkbox requiredness, and all event handling.
- [ ] Keep all `TextField` props and input-label shrinking behavior unchanged.

### Step 4: Run the UI gates

- [ ] Run:

```bash
pnpm exec eslint \
  packages/shared-ui/src/components/canvas/components/rjsf-widgets/field-label-with-info/FieldLabelWithInfo.tsx \
  packages/shared-ui/src/components/canvas/components/rjsf-widgets/base-input-template/BaseInputTemplate.tsx \
  packages/shared-ui/src/components/canvas/components/rjsf-widgets/select-widget/SelectWidget.tsx \
  packages/shared-ui/src/components/canvas/components/rjsf-widgets/api-key-widget/ApiKeyWidget.tsx \
  packages/shared-ui/src/components/canvas/components/rjsf-widgets/checkbox-widget/CheckboxWidget.tsx
./builder shared-ui:test
./builder vscode:compile
```

- [ ] Expect ESLint, shared UI tests, the webview bundle, VS Code TypeScript compilation, and extension bundling to pass.

### Step 5: Commit Task 2

- [ ] Review `git diff --check` and the scoped diff.
- [ ] Commit:

```bash
git add packages/shared-ui/src/components/canvas/components/rjsf-widgets
git commit -m "feat(ui): show field descriptions in info tooltips"
```

## Task 3: Review, integration verification, and handoff

**Files:**

- Review all files changed by Tasks 1–2.
- Modify only the same files if review uncovers a defect.

### Step 1: Spec compliance review

- [ ] Verify every approved acceptance criterion against the diff, especially:
  - default n8n form hides irrelevant credentials and one timeout;
  - each mode reveals exactly its fields;
  - information icons cover text, select, API-key, and checkbox fields;
  - inactive saved values and configuration keys remain compatible;
  - `n8n-nodes-rocketride` is untouched.

### Step 2: Code-quality review

- [ ] Check accessible focus behavior, MUI label compatibility, tooltip suppression for empty descriptions, secure-value isolation, TypeScript typing, and absence of unrelated refactors.
- [ ] Apply only review fixes that are within the approved files and scope.

### Step 3: Run final verification from a clean status snapshot

- [ ] Run:

```bash
git diff --check origin/develop...
python3 -m pytest -q nodes/test/test_tool_n8n.py
python3 -m pytest -q nodes/test/test_contracts.py -k n8n
pnpm exec eslint \
  packages/shared-ui/src/components/canvas/components/rjsf-widgets/field-label-with-info/FieldLabelWithInfo.tsx \
  packages/shared-ui/src/components/canvas/components/rjsf-widgets/base-input-template/BaseInputTemplate.tsx \
  packages/shared-ui/src/components/canvas/components/rjsf-widgets/select-widget/SelectWidget.tsx \
  packages/shared-ui/src/components/canvas/components/rjsf-widgets/api-key-widget/ApiKeyWidget.tsx \
  packages/shared-ui/src/components/canvas/components/rjsf-widgets/checkbox-widget/CheckboxWidget.tsx
./builder shared-ui:test
./builder vscode:compile
git status --short
```

- [ ] Record exact pass counts and any environmental warnings. Do not claim manual live-canvas or live-n8n execution unless actually performed.

### Step 4: Final scoped-diff audit

- [ ] Confirm changed implementation files match the design's expected-file list plus the two design/plan documents.
- [ ] Confirm there are no files under `n8n-nodes-rocketride` and no unrelated generated artifacts.
- [ ] Summarize commits, verification, and the remaining manual canvas/live-n8n QA for the user.
