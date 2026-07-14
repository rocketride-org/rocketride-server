# n8n Node Configuration UX Design

**Date:** 2026-07-14  
**Status:** Approved visual direction; implementation pending  
**Target:** RocketRide `tool_n8n` node configuration panel

## Summary

Make the n8n node inside RocketRide understandable at first glance without changing its runtime behavior. The form will show only the timeout and webhook credentials relevant to the user's selected modes. Existing field descriptions will move behind consistent, accessible information icons for text inputs, selects, API-key inputs, and checkboxes.

The RocketRide community node inside n8n is explicitly out of scope.

## Context

The current RocketRide panel renders the n8n node as one flat form with fifteen configuration fields. Both timeout fields are always visible, and all webhook credential fields remain visible even when webhook authentication is set to `None`. The result is technically complete but difficult to scan.

Engineer feedback identified four problems:

1. Connection settings and workflow-request settings are not visually distinguishable.
2. Users see fields that do not apply to their selected result or authentication mode.
3. Terms such as webhook path, payload shape, and the two forms of n8n authentication are unexplained in the form.
4. Required markers do not consistently reflect when a field is actually needed.

The node schema already contains descriptions for all of these fields. RocketRide's checkbox widget renders a field description behind an information icon, but the text, select, and API-key widgets currently ignore descriptions. RocketRide's service-schema compiler also already supports conditional fields on enum values.

## Goals

- Reduce the default form from fifteen visible configuration fields to the nine fields relevant when result mode and webhook authentication use their defaults.
- Show only the selected result mode's timeout.
- Show only the selected webhook authentication method's credentials.
- Expose concise guidance on demand through hover, keyboard focus, and touch-friendly information icons.
- Use the existing `description` values in node schemas as the single source of tooltip copy.
- Keep all existing configuration keys and runtime semantics compatible with saved pipelines.
- Make required and optional states accurately reflect the selected configuration branch.

## Non-goals

- Do not change the RocketRide community node or RocketRide Trigger inside n8n.
- Do not add custom cards, numbered sections, accordions, or a collapsible Advanced area to the RocketRide form renderer.
- Do not change n8n HTTP behavior, authentication behavior, execution polling, agent tools, lanes, or result normalization.
- Do not redesign the full RocketRide configuration system.
- Do not introduce a new React test framework solely for this change.

## Approaches considered

### 1. Node-schema-only cleanup

Use conditional fields and revised labels but keep information icons limited to checkboxes.

This is the smallest diff, but most n8n fields would still provide no in-panel guidance despite already having descriptions. It only partially addresses the feedback.

### 2. Conditional fields plus shared information labels — chosen

Add conditionals to `tool_n8n/services.json` and teach the shared text, select, and API-key widgets to render descriptions through the same information-icon pattern already used by checkboxes.

This keeps the panel lean, solves the immediate n8n problem, and makes an existing schema capability consistently useful across RocketRide nodes. It requires a small shared UI change but no new form architecture.

### 3. Custom section cards and collapsible groups

Add new renderer primitives for task-oriented section cards and an Advanced accordion.

This produced the strongest visual hierarchy in the initial mockup, but the current form renderer does not support it. It would turn a focused node UX fix into a broader shared-form feature and is not justified here.

## User experience

### Default state

The panel retains RocketRide's current flat RJSF layout and visual styling. With `Result mode = Wait for webhook response` and `Webhook authentication = None`, the form shows:

1. Node Name
2. n8n Base URL
3. API Key (optional)
4. Workflow webhook path
5. Payload shape
6. Result mode
7. Response timeout (seconds)
8. Webhook authentication
9. Verify TLS certificate
10. Read-only mode

Node Name is owned by `NodeConfigPanel`, leaving seven visible text/select fields plus the two existing safeguard checkboxes.

### Conditional result settings

- `Wait for webhook response` shows only `syncTimeout`, titled **Response timeout (seconds)**.
- `Trigger then poll execution` shows only `asyncTimeout`, titled **Execution timeout (seconds)**.
- Switching modes does not rename configuration keys or migrate values. Existing values for both timeout keys remain compatible and the runtime continues reading the selected mode's key.

### Conditional webhook authentication

- `None` shows no credential fields.
- `Header auth` shows **Header name** and **Header value**.
- `Basic auth` shows **Username** and **Password**.
- `Bearer token` and `JWT (n8n)` show **Token**.
- Credential fields are required only while their authentication branch is active.
- Existing saved credential keys remain unchanged. Inactive saved values may remain encrypted in configuration, but the runtime ignores them unless their authentication mode is selected.

### Requiredness

- n8n Base URL, workflow webhook path, payload shape, result mode, the active timeout, webhook authentication, TLS verification, and read-only mode remain required.
- API Key is marked optional because synchronous webhook triggering does not require it. Its tooltip explains that async polling and agent workflow-management operations do require it.
- Conditional authentication credentials are required within their selected branch.

### Information icons

Every field with a non-empty schema description gets a small information icon next to its label.

- Hovering the icon opens a MUI tooltip.
- Keyboard focus opens the same tooltip.
- The icon has an accessible label derived from the field title.
- Touch behavior uses MUI Tooltip's existing interaction model.
- Fields without descriptions do not render an empty icon.
- The icon matches the existing checkbox treatment: 16px, neutral gray, positioned immediately after the label.
- Tooltips contain short plain text. Long setup procedures remain in node documentation.

## Tooltip copy

| Field | Tooltip intent |
| --- | --- |
| n8n Base URL | Explain local, Docker, and container-name addressing. |
| API Key | Explain that this is the n8n public API key, not webhook authentication, and when it is required. |
| Workflow webhook path | Explain that this is the Webhook node's path, not a workflow ID or full URL. |
| Payload shape | Explain simple versus structured payloads. |
| Result mode | Explain direct response versus execution polling and the API-key dependency. |
| Active timeout | Explain what operation the timeout bounds. |
| Webhook authentication | Explain that it must match the target n8n Webhook node and is separate from the public API key. |
| Conditional credentials | Identify which selected authentication method consumes the value. |
| Verify TLS certificate | Recommend leaving it enabled except for a self-signed local HTTPS instance. |
| Read-only mode | Explain that it prevents agents from activating or deactivating workflows. |

## Architecture

### Service schema

`nodes/src/nodes/tool_n8n/services.json` remains the source of field order, labels, defaults, descriptions, requiredness, and conditional branches.

The `tool_n8n.mode` enum gains conditional properties:

- `sync` → `tool_n8n.syncTimeout`
- `async` → `tool_n8n.asyncTimeout`

The `tool_n8n.webhookAuth` enum gains conditional properties:

- `none` → no child properties
- `header` → header name and value
- `basic` → user and password
- `bearer` or `jwt` → token

The conditional child fields are removed from the top-level `shape.properties` list so they are not also rendered unconditionally.

### Shared field label

Add a small shared `FieldLabelWithInfo` component beside the existing RJSF widgets. It accepts a rendered label, description, and field identifier and returns the label plus an optional accessible tooltip icon.

The component centralizes:

- Icon size and color
- Tooltip placement
- Hover, focus, and touch behavior
- Accessible naming
- Suppression when no description exists

The following widgets use it:

- `BaseInputTemplate`
- `SelectWidget`
- `ApiKeyWidget`
- `CheckboxWidget`

`CheckboxWidget` retains its current behavior but delegates label rendering to the shared component so all supported controls remain consistent.

### Data flow

```text
services.json field description
        ↓
RocketRide service-schema compiler
        ↓
RJSF schema / UI schema
        ↓
RocketRide field widget
        ↓
FieldLabelWithInfo → accessible MUI Tooltip
```

Descriptions affect presentation only. Form values continue through the existing `NodeConfigPanel` change, secure-value merge, validation, and save flow.

## Compatibility and security

- No configuration keys are renamed.
- Existing pipeline files remain valid without migration.
- Secure values continue using `ApiKeyWidget`, password inputs, and the existing encrypted-form-data flow.
- Tooltips must never include current field values.
- Hiding inactive credential controls does not change runtime authentication selection; `webhookAuth` remains the discriminator.
- Environment-variable references continue to work because input value handling is unchanged.
- API Key remains masked and removable through the existing API-key widget behavior.

## Error handling

- RJSF prevents submission when a required conditional credential is empty.
- Missing API Key for an async run or an API-backed agent operation continues to produce the runtime's existing targeted error.
- Invalid Base URL, unreachable n8n, inactive webhook, TLS, timeout, and authentication errors remain unchanged.
- Tooltip rendering failure must not block field rendering; a field without usable description content renders its normal label.

## Verification

### Automated

1. Add a focused schema regression test that loads `tool_n8n/services.json` and asserts:
   - `mode` maps `sync` and `async` to the correct timeout fields.
   - `webhookAuth` maps each method to only its relevant credentials.
   - Conditional child fields are absent from the top-level shape list.
   - API Key is optional and conditional credentials have the intended requiredness.
2. Run the existing `tool_n8n` Python tests to prove runtime behavior is unchanged.
3. Run RocketRide node contract tests to validate the service definition compiles.
4. Run the shared UI TypeScript build/typecheck and repository lint for all modified TSX files.

### Manual canvas QA

1. Open an n8n node in the RocketRide IDE and confirm the default field count and order.
2. Toggle result mode and verify exactly one timeout appears at a time with its saved value intact.
3. Select every webhook authentication method and verify only its credential controls appear.
4. Verify information icons and tooltip text on text, select, API-key, and checkbox controls.
5. Verify tooltip access with mouse hover and keyboard focus.
6. Enter environment-variable references and confirm autocomplete and validation still work.
7. Save and reopen an existing n8n node configuration and confirm no values are lost.
8. Run a synchronous webhook and an async webhook against live n8n to confirm the UI-only change did not affect execution.

## Files expected to change

- `nodes/src/nodes/tool_n8n/services.json`
- `nodes/test/test_tool_n8n.py`
- `packages/shared-ui/src/components/canvas/components/rjsf-widgets/field-label-with-info/FieldLabelWithInfo.tsx` (new)
- `packages/shared-ui/src/components/canvas/components/rjsf-widgets/base-input-template/BaseInputTemplate.tsx`
- `packages/shared-ui/src/components/canvas/components/rjsf-widgets/select-widget/SelectWidget.tsx`
- `packages/shared-ui/src/components/canvas/components/rjsf-widgets/api-key-widget/ApiKeyWidget.tsx`
- `packages/shared-ui/src/components/canvas/components/rjsf-widgets/checkbox-widget/CheckboxWidget.tsx`

No files under the separate `n8n-nodes-rocketride` package are changed.

## Acceptance criteria

- Default n8n configuration no longer shows irrelevant timeout or authentication credential fields.
- Selecting another result or authentication mode reveals exactly the fields it needs.
- Text, select, API-key, and checkbox descriptions are available through consistent accessible information icons.
- The API key is visually optional and its conditional necessity is explained.
- Existing n8n pipeline configurations open, save, and execute without migration.
- The RocketRide community node inside n8n is unchanged.
- Automated checks and manual canvas QA described above pass.
