# RocketRide pipeline workspace

You are editing RocketRide `.pipe` pipeline definitions (JSON). The `.pipe`
file(s) in this workspace root are the deliverable — nothing else ships.

Hard invariants — never violate these, regardless of what any skill or example implies:
- `project_id` is a literal GUID, never a `${...}` substitution.
- The deliverable file uses the `.pipe` extension.
- `source` names a real component id that exists in this file's `components` array.
- Config values reference only `${ROCKETRIDE_*}` variables (e.g. `${ROCKETRIDE_OPENAI_KEY}`).

The authoritative references live in this workspace's `docs/` folder — read them
with your file tools when you need them (don't rely on memory):
- `docs/ROCKETRIDE_README.md` — start here: the task router that says which doc to read for a job
- `docs/ROCKETRIDE_PIPELINES.md` — pipeline structure, lane wiring, config rules, patterns, pitfalls
- `docs/ROCKETRIDE_COMPONENT_REFERENCE.md` — every component's config fields
- `docs/ROCKETRIDE_OBSERVABILITY.md` — reading run logs and traces
