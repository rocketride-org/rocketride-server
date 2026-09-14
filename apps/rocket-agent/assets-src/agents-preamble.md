# RocketRide pipeline workspace

You are editing RocketRide `.pipe` pipeline definitions (JSON). The `.pipe`
file(s) in this workspace root are the deliverable — nothing else ships.

Working loop:
1. Read the open `.pipe` file before changing it.
2. After every meaningful edit, call the `rocketride` MCP tool
   `validate_pipeline` and fix reported errors before continuing.
3. Use `list_components` / `describe_component` before adding a node type you
   have not already used in this session.
4. Test with `run_pipeline`; on failure read the `log_*` tools before touching
   the graph again.

The authoritative references live in this workspace's `docs/` folder — read them
with your file tools when you need them (don't rely on memory):
- `docs/ROCKETRIDE_PIPELINE_RULES.md` — pipeline structure, lane wiring, config rules
- `docs/ROCKETRIDE_COMMON_MISTAKES.md` — known pitfalls; check before finalizing
- `docs/ROCKETRIDE_QUICKSTART.md` — worked examples to copy
- `docs/ROCKETRIDE_COMPONENT_REFERENCE.md` — every component's config fields
- `docs/ROCKETRIDE_OBSERVABILITY.md` — reading run logs and traces

Read `ROCKETRIDE_PIPELINE_RULES.md` before building a pipeline and
`ROCKETRIDE_COMMON_MISTAKES.md` before finalizing one.
