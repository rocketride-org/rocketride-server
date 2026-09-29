# Implementation Plan: Security Nodes

## Overview

Implement two security filter nodes for the RocketRide pipeline using the Python SDK (`rocketlib`). The Static Input Pre-Screen Node provides heuristic prompt injection detection and cryptographic nonce fencing. The Trust Boundary Evaluation Gate provides tool call authorization, rate limiting, argument schema validation, and run-level policy enforcement. Both follow the `IGlobal`/`IInstance` lifecycle, register as `filter`-type nodes, and expose `.pipe` JSON configuration with boolean toggles in the visual builder canvas.

## Tasks

- [x] 1. Set up project structure and shared data models
  - [x] 1.1 Create the `input_prescreen` node directory and boilerplate files
    - Create `nodes/src/nodes/input_prescreen/` directory with `__init__.py`, `requirements.txt`, `services.json`, and icon SVG
    - `services.json` must declare `"register": "filter"`, `"node": "python"`, `"path": "nodes.input_prescreen"`, lanes for `questions` and `documents`, and preconfig profiles (`strict`, `moderate`, `custom`)
    - Define fields for `block_ignore_instructions` (bool, default true), `enable_nonce_fencing` (bool, default true), `nonce_length` (int, min 16, max 128, default 16), `policy_mode` (enum: block/warn/log, default block), and `custom_rules` (array)
    - _Requirements: 14.1, 14.2, 14.3, 12.1_

  - [x] 1.2 Create the `trust_boundary` node directory and boilerplate files
    - Create `nodes/src/nodes/trust_boundary/` directory with `__init__.py`, `requirements.txt`, `services.json`, and icon SVG
    - `services.json` must declare `"register": "filter"`, `"node": "python"`, `"path": "nodes.trust_boundary"`, lanes for `questions`
    - Define fields for `enable_tool_interception` (bool, default true), `enable_run_policy` (bool, default false), `abort_on_unauthorized` (bool, default true), `audit_log` (bool, default true), `permission_scopes` (array, max 50), and `payload_schema` (object)
    - _Requirements: 14.4, 14.5, 14.6, 14.7, 12.2_

  - [x] 1.3 Create shared data model definitions
    - Create `nodes/src/nodes/input_prescreen/models.py` with `HeuristicRule`, `ScanResult`, `RuleMatch`, `FencedPayload`, and `PreScreenConfig` dataclasses
    - Create `nodes/src/nodes/trust_boundary/models.py` with `PermissionScope`, `AuthDecision`, `ToolCallHookContext`, and `TrustBoundaryConfig` dataclasses
    - Implement validation rules: severity enum, category enum, unique IDs, nonce_length range, max_calls_per_run >= 0
    - _Requirements: 1.2, 6.1, 7.5, 14.6_

- [x] 2. Implement Heuristic Scan Engine
  - [x] 2.1 Implement `HeuristicRuleset` class with `compile()` and `scan()` methods
    - Create `nodes/src/nodes/input_prescreen/heuristic_engine.py`
    - Implement `compile()`: iterate rules, compile regex with `re.IGNORECASE | re.DOTALL`, catch `re.error` on invalid patterns, log warning and disable the offending rule, continue with remaining rules
    - Implement `scan(text)`: skip empty/whitespace text (return passed=True immediately), iterate enabled compiled rules, record `RuleMatch` entries with rule_id, category, severity, matched_text (truncated to 100 chars), position; sort matches by position ascending; measure scan_time_us via `time.perf_counter_ns()`
    - Ensure compile is idempotent and disabled rules are skipped during scan
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x]* 2.2 Write property test: Heuristic Scan Correctness
    - **Property 1: Heuristic Scan Correctness**
    - **Validates: Requirements 1.1, 1.3, 1.4**

  - [x]* 2.3 Write property test: ScanResult Structural Invariants
    - **Property 2: ScanResult Structural Invariants**
    - **Validates: Requirements 1.2, 1.5**

  - [x]* 2.4 Write property test: Compile Idempotence
    - **Property 3: Compile Idempotence**
    - **Validates: Requirements 2.3**

  - [x]* 2.5 Write property test: Invalid Rule Isolation
    - **Property 4: Invalid Rule Isolation**
    - **Validates: Requirements 2.2**

  - [x]* 2.6 Write property test: Disabled Rules Excluded from Scan
    - **Property 5: Disabled Rules Excluded from Scan**
    - **Validates: Requirements 2.4**

- [x] 3. Implement Nonce Fencer
  - [x] 3.1 Implement `NonceFencer` class with `new_cycle()`, `fence()`, and `build_system_addendum()` methods
    - Create `nodes/src/nodes/input_prescreen/nonce_fencer.py`
    - `new_cycle()`: generate nonce via `secrets.token_hex(nonce_length)`, return hex string of length `nonce_length * 2`
    - `fence(content, nonce)`: return content unchanged if empty/null; check collision (nonce in content), retry up to 10 times, raise `SecurityError` if exhausted; wrap between `<<<UNTRUSTED_DATA_{nonce}>>>` and `<<<END_UNTRUSTED_DATA_{nonce}>>>` markers
    - `build_system_addendum(nonce)`: produce directive instructing LLM to treat fenced regions as data-only
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x]* 3.2 Write property test: Nonce Fence Unambiguity
    - **Property 6: Nonce Fence Unambiguity**
    - **Validates: Requirements 3.2**

  - [x]* 3.3 Write property test: Nonce Collision Resolution
    - **Property 7: Nonce Collision Resolution**
    - **Validates: Requirements 3.3**

  - [x]* 3.4 Write property test: Nonce Format Invariant
    - **Property 8: Nonce Format Invariant**
    - **Validates: Requirements 3.1, 3.6**

- [x] 4. Implement Pre-Screen Node IGlobal and IInstance
  - [x] 4.1 Implement `IGlobal` for the Pre-Screen Node
    - Create `nodes/src/nodes/input_prescreen/IGlobal.py`
    - In `beginGlobal`: load config via `Config.getNodeConfig`, validate required fields (emit warning and abort on invalid), load dependencies via `depends()`, instantiate `HeuristicRuleset` with built-in + custom rules, call `compile()`, instantiate `NonceFencer` with configured `nonce_length`
    - In `endGlobal`: release heuristic_engine and nonce_fencer references
    - Complete beginGlobal within 5 seconds
    - _Requirements: 12.3, 12.4, 12.7, 2.1_

  - [x] 4.2 Implement `IInstance` for the Pre-Screen Node with `writeQuestions` and `writeDocuments`
    - Create `nodes/src/nodes/input_prescreen/IInstance.py`
    - `writeQuestions`: extract text; if empty/whitespace forward immediately; run heuristic scan if `block_ignore_instructions` enabled; apply policy_mode logic (block → preventDefault + warnings, warn → warnings + forward, log → forward silently); if `enable_nonce_fencing` enabled, generate cycle nonce, fence each question text and context document with same nonce, append system_addendum; reject if nonce unavailable
    - `writeDocuments`: apply nonce fencing to documents if enabled, forward downstream
    - Handle unrecognized policy_mode by defaulting to "block" (fail-closed)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [x]* 4.3 Write property test: Block Mode Guarantee
    - **Property 9: Block Mode Guarantee**
    - **Validates: Requirements 4.1**

  - [x]* 4.4 Write property test: Non-Block Modes Forward
    - **Property 10: Non-Block Modes Forward**
    - **Validates: Requirements 4.2, 4.3, 4.4**

  - [x]* 4.5 Write property test: Fencing Integration Consistency
    - **Property 11: Fencing Integration Consistency**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**

- [x] 5. Checkpoint - Ensure Pre-Screen node tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement Authorization Engine
  - [x] 6.1 Implement `AuthorizationEngine` class with `evaluate()` and glob pattern matching
    - Create `nodes/src/nodes/trust_boundary/authorization_engine.py`
    - Implement `_matches_pattern_list(tool_name, patterns)` using `fnmatch.fnmatch` with case-sensitive matching for `*` and `?` wildcards
    - Implement `evaluate(tool_name, args, agent_id)`: find applicable scopes (agent_id match or wildcard "*"), return default-deny (`__default_deny__`) if no scopes apply; for each scope check denied_tools first (deny takes precedence), then allowed_tools; check rate limit; check args schema; return `__no_match__` if no scope grants access
    - Implement `_get_call_count` and `_increment_call_count` for per-run rate tracking; only increment on authorized calls
    - Implement `_validate_args_schema(args, schema)` using jsonschema; report property path and violated constraint on failure; handle malformed schema
    - `reload_scopes(scopes)` for dynamic reconfiguration
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4, 13.1, 13.2, 13.3, 13.4, 13.5_

  - [x]* 6.2 Write property test: Deny Precedence Over Allow
    - **Property 12: Deny Precedence Over Allow**
    - **Validates: Requirements 6.2, 13.1, 13.2, 13.3**

  - [x]* 6.3 Write property test: Default-Deny Enforcement
    - **Property 13: Default-Deny Enforcement**
    - **Validates: Requirements 6.4, 6.5**

  - [x]* 6.4 Write property test: Rate Limit Monotonicity
    - **Property 14: Rate Limit Monotonicity**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4**

  - [x]* 6.5 Write property test: Schema Validation Enforcement
    - **Property 15: Schema Validation Enforcement**
    - **Validates: Requirements 8.1, 8.2, 8.3**

- [x] 7. Implement Run-Level Policy Enforcement
  - [x] 7.1 Implement `RunLevelPolicy` class with `enforce()` method
    - Create `nodes/src/nodes/trust_boundary/run_level_policy.py`
    - Implement `enforce(payload, schema)`: return payload unchanged if `enable_run_policy` is false or schema is None; raise `HookAborted` if payload is empty/null; validate schema is well-formed (raise `HookAborted` if malformed); recursively strip unknown keys at all nesting levels; validate sanitized payload with `jsonschema.validate`; raise `HookAborted` with first violation on failure
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x]* 7.2 Write property test: Run-Level Policy Strict Sanitization
    - **Property 16: Run-Level Policy Strict Sanitization**
    - **Validates: Requirements 9.1, 9.2, 9.3**

  - [x]* 7.3 Write property test: Run-Level Policy Passthrough
    - **Property 17: Run-Level Policy Passthrough**
    - **Validates: Requirements 9.4, 9.5**

- [x] 8. Implement Trust Boundary Node IGlobal and IInstance
  - [x] 8.1 Implement `IGlobal` for the Trust Boundary Gate
    - Create `nodes/src/nodes/trust_boundary/IGlobal.py`
    - In `beginGlobal`: load config via `Config.getNodeConfig`, parse permission scopes, instantiate `AuthorizationEngine`, attempt CrewAI import and hook registration (fall back to passthrough on failure), check jsonschema availability (disable run policy if missing, log warning), instantiate `RunLevelPolicy`
    - In `endGlobal`: deregister lifecycle hooks, release authorization engine and policy state
    - _Requirements: 12.5, 12.6, 12.7, 15.1, 15.2, 15.3_

  - [x] 8.2 Implement `IInstance` for the Trust Boundary Gate with `writeQuestions` and hook wiring
    - Create `nodes/src/nodes/trust_boundary/IInstance.py`
    - `open(entry)`: reset per-run call counters on the authorization engine
    - `writeQuestions`: forward questions downstream (primary filtering is done via hooks)
    - Wire the `TrustBoundaryHook` class with `on_pre_tool_call` and `on_execution_start` handlers
    - _Requirements: 12.5, 10.1, 10.2, 10.3_

  - [x] 8.3 Implement `TrustBoundaryHook` with PRE_TOOL_CALL and EXECUTION_START handlers
    - Create `nodes/src/nodes/trust_boundary/trust_boundary_hook.py`
    - `on_pre_tool_call(context)`: call `auth_engine.evaluate(tool_name, tool_args, agent_id)`; if denied and `abort_on_unauthorized` is true, raise `HookAborted(reason, "TrustBoundaryEvaluationGate")`; if denied and `abort_on_unauthorized` is false, log denial and allow; wrap in `RuntimeError` if framework doesn't propagate `HookAborted`
    - `on_execution_start(context)`: call `run_level_policy.enforce(payload, schema)` to sanitize and validate; update context payload with sanitized result
    - _Requirements: 10.1, 10.2, 10.3, 9.1, 9.6_

  - [x]* 8.4 Write property test: Abort Behavior Correctness
    - **Property 18: Abort Behavior Correctness**
    - **Validates: Requirements 10.1, 10.2**

- [x] 9. Implement Audit Logging
  - [x] 9.1 Implement structured audit logging for the Trust Boundary Gate
    - Create `nodes/src/nodes/trust_boundary/audit_logger.py`
    - Implement `log_auth_decision(tool_name, agent_id, scope_id, allowed, reason, evaluated_at)`: emit structured log entry at INFO level with ISO 8601 UTC timestamp; truncate reason to 500 chars
    - Implement `log_run_policy(outcome, stripped_keys, evaluated_at)`: emit structured log entry at INFO level with outcome (accepted/modified/rejected) and stripped key list
    - Respect `audit_log` toggle: emit nothing when false
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [x]* 9.2 Write property test: Audit Trail Completeness
    - **Property 19: Audit Trail Completeness**
    - **Validates: Requirements 11.1, 11.2, 11.3**

- [x] 10. Implement Graceful Degradation
  - [x] 10.1 Implement dependency availability checks and passthrough fallback
    - In `trust_boundary/IGlobal.py`, add try/except for `jsonschema` import: if missing, disable `enable_run_policy`, log warning with library name and disabled feature
    - Add try/except for `crewai` import: if missing or missing expected base class interface, enter passthrough mode, log each forwarded object, emit warning about unavailable interception points
    - In passthrough mode, forward all payloads unmodified and append audit log entry for each forwarded payload (timestamp + payload identifier)
    - _Requirements: 15.1, 15.2, 15.3, 15.4_

- [x] 11. Checkpoint - Ensure Trust Boundary node tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Integration wiring and final validation
  - [x] 12.1 Wire both nodes into the pipeline registration system
    - Verify both `services.json` files are discoverable by the C++ engine's node loader
    - Ensure `nodes/src/nodes/input_prescreen/__init__.py` and `nodes/src/nodes/trust_boundary/__init__.py` export the correct module paths
    - Verify both nodes can be instantiated by the test harness in `test/nodes/`
    - _Requirements: 12.1, 12.2_

  - [x] 12.2 Create README.md documentation for both nodes
    - Create `nodes/src/nodes/input_prescreen/README.md` documenting inputs, outputs, config schema, and usage
    - Create `nodes/src/nodes/trust_boundary/README.md` documenting inputs, outputs, config schema, permission scope format, and usage
    - _Requirements: 14.1, 14.4_

  - [x]* 12.3 Write integration tests for Pre-Screen Node pipeline flow
    - Test end-to-end: question with injection → block mode → preventDefault called
    - Test end-to-end: clean question → nonce fencing applied → forwarded with addendum
    - Test whitespace-only input → forwarded without scan
    - Mock `rocketlib` base classes following `test/nodes/test_init_mocks.py` pattern
    - _Requirements: 4.1, 5.1, 5.5, 4.4_

  - [x]* 12.4 Write integration tests for Trust Boundary Gate pipeline flow
    - Test end-to-end: tool call against denied tool → HookAborted raised
    - Test end-to-end: tool call within rate limit → allowed, then exceeds → denied
    - Test run-level policy: payload with extra keys stripped, invalid payload raises HookAborted
    - Test passthrough mode when CrewAI unavailable
    - _Requirements: 6.2, 7.2, 9.2, 9.3, 15.2_

- [x] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document using `hypothesis`
- Unit tests validate specific examples and edge cases
- Both nodes follow the existing pattern established by `nodes/src/nodes/guardrails/` (IGlobal/IInstance lifecycle, services.json registration, filter type)
- The implementation language is Python (rocketlib SDK)
- `jsonschema` is an optional dependency for the Trust Boundary Gate — graceful degradation is required

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "3.1", "6.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "2.6", "3.2", "3.3", "3.4", "6.2", "6.3", "6.4", "6.5", "7.1"] },
    { "id": 3, "tasks": ["4.1", "7.2", "7.3", "8.1"] },
    { "id": 4, "tasks": ["4.2", "8.2", "8.3", "9.1"] },
    { "id": 5, "tasks": ["4.3", "4.4", "4.5", "8.4", "9.2", "10.1"] },
    { "id": 6, "tasks": ["12.1", "12.2"] },
    { "id": 7, "tasks": ["12.3", "12.4"] }
  ]
}
```
