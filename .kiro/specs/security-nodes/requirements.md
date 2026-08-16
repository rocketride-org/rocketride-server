# Requirements Document

## Introduction

This document defines the requirements for two security nodes in the RocketRide pipeline: the **Static Input Pre-Screen Node** (mitigating LLM01 Prompt Injection) and the **Trust Boundary Evaluation Gate** (mitigating Excessive Agency). Both nodes are implemented using the RocketRide Python SDK (`rocketlib`), follow the `IGlobal`/`IInstance` lifecycle pattern, register as `filter`-type nodes, and expose `.pipe` JSON configuration with boolean toggles in the visual builder canvas.

## Glossary

- **Pre-Screen_Node**: The Static Input Pre-Screen filter node that scans and fences untrusted input before it reaches downstream LLM nodes
- **Trust_Gate**: The Trust Boundary Evaluation Gate filter node that intercepts tool calls and enforces permission-scoped authorization
- **Heuristic_Engine**: The compiled regex and pattern matching engine used by Pre-Screen_Node to detect prompt injection markers
- **Nonce_Fencer**: The component that generates cryptographic nonces and wraps untrusted content between unique delimiters
- **Authorization_Engine**: The component that evaluates tool call contexts against configured permission scopes
- **Pipeline_Engine**: The RocketRide C++ execution engine that routes data streams between nodes
- **Permission_Scope**: A configured set of allowed/denied tools, agent identifiers, rate limits, and argument schemas
- **ScanResult**: The output of the heuristic scan containing pass/fail status and match details
- **FencedPayload**: The output of nonce fencing containing the wrapped text and system prompt addendum
- **AuthDecision**: The output of authorization evaluation containing allow/deny status and reason
- **HookAborted**: The exception raised to block unauthorized tool calls or invalid payloads
- **Policy_Mode**: The enforcement behavior of Pre-Screen_Node: "block", "warn", or "log"
- **CSPRNG**: Cryptographically Secure Pseudo-Random Number Generator used for nonce generation

## Requirements

### Requirement 1: Heuristic Scan Detection

**User Story:** As a pipeline operator, I want incoming text to be scanned against heuristic rules for prompt injection markers, so that injection attempts are detected before reaching downstream LLM nodes.

#### Acceptance Criteria

1. WHEN the Pre-Screen_Node receives a question or document, THE Heuristic_Engine SHALL scan the full text content (up to 100,000 characters) against all enabled heuristic rules
2. WHEN a heuristic rule pattern matches the input text, THE Heuristic_Engine SHALL record each match as an entry containing the rule_id, category, severity, matched_text (truncated to 100 characters), and zero-based character offset of the match start position in the ScanResult
3. WHEN multiple heuristic rule patterns match the input text, THE Heuristic_Engine SHALL record all matches in the ScanResult matches list ordered by character offset ascending
4. WHEN no heuristic rule patterns match the input text, THE Heuristic_Engine SHALL return a ScanResult with passed equal to true and an empty matches list
5. WHEN at least one heuristic rule pattern matches the input text, THE Heuristic_Engine SHALL return a ScanResult with passed equal to false
6. IF the Pre-Screen_Node receives empty text or text containing only whitespace, THEN THE Heuristic_Engine SHALL return a ScanResult with passed equal to true and an empty matches list without executing rule evaluation
7. THE Heuristic_Engine SHALL measure and record scan duration in microseconds in every ScanResult, completing the scan within 50 milliseconds for inputs up to 10,000 characters

### Requirement 2: Heuristic Rule Compilation

**User Story:** As a pipeline operator, I want heuristic rules to be pre-compiled at process startup, so that scanning is performed with minimal latency during request processing.

#### Acceptance Criteria

1. WHEN beginGlobal is invoked, THE Pre-Screen_Node SHALL compile all enabled heuristic rules into regex Pattern objects using case-insensitive and single-line matching flags
2. IF a custom rule contains an invalid regex pattern, THEN THE Pre-Screen_Node SHALL log a warning identifying the rule ID and the compilation error reason, disable the offending rule, and continue compiling the remaining valid rules
3. IF all heuristic rules are disabled or invalid after compilation, THEN THE Pre-Screen_Node SHALL proceed with an empty rule set such that subsequent scans return a ScanResult with passed equal to true and an empty matches list
4. THE Heuristic_Engine compile operation SHALL be idempotent, producing the same set of compiled patterns and the same set of disabled rule IDs regardless of how many times it is called
5. THE Heuristic_Engine SHALL skip disabled rules during scanning without evaluating their patterns

### Requirement 3: Cryptographic Nonce Fencing

**User Story:** As a pipeline operator, I want untrusted content wrapped in cryptographic nonce fences, so that downstream LLM nodes can distinguish between instructions and data.

#### Acceptance Criteria

1. WHEN nonce fencing is enabled, THE Nonce_Fencer SHALL generate a new cryptographically secure nonce per execution cycle using CSPRNG with a minimum length of 16 bytes
2. WHEN fencing content, THE Nonce_Fencer SHALL wrap the content between exactly one opening marker formatted as `<<<UNTRUSTED_DATA_{nonce}>>>` and one closing marker formatted as `<<<END_UNTRUSTED_DATA_{nonce}>>>` using the cycle nonce
3. WHEN the generated nonce appears within the content text, THE Nonce_Fencer SHALL regenerate the nonce until no collision exists, up to a maximum of 10 retry attempts
4. IF all 10 nonce collision retry attempts are exhausted, THEN THE Nonce_Fencer SHALL raise a SecurityError and block the request
5. WHEN content is fenced, THE Nonce_Fencer SHALL produce a system_addendum instructing the LLM to treat nonce-fenced regions as data-only and not as instructions
6. THE Nonce_Fencer SHALL produce nonces as hex strings of length equal to nonce_length multiplied by 2
7. IF the content to be fenced is empty or null, THEN THE Nonce_Fencer SHALL return the content unchanged without applying markers

### Requirement 4: Pre-Screen Policy Mode Enforcement

**User Story:** As a pipeline operator, I want configurable enforcement modes (block, warn, log), so that I can tune the strictness of injection detection for different pipeline contexts.

#### Acceptance Criteria

1. WHILE policy_mode is set to "block", WHEN the Heuristic_Engine scan returns passed equal to false, THE Pre-Screen_Node SHALL emit a warning message per matched violation indicating the rule name and violation details, call preventDefault, and stop the question from reaching downstream nodes
2. WHILE policy_mode is set to "warn", WHEN the Heuristic_Engine scan returns passed equal to false, THE Pre-Screen_Node SHALL emit a warning message per matched violation indicating the rule name and violation details, and forward the question downstream
3. WHILE policy_mode is set to "log", WHEN the Heuristic_Engine scan returns passed equal to false, THE Pre-Screen_Node SHALL forward the question downstream without emitting any warning messages
4. WHEN the input text is empty or contains only whitespace characters, THE Pre-Screen_Node SHALL forward it downstream without invoking the Heuristic_Engine scan
5. IF policy_mode is not set to one of the recognized values ("block", "warn", "log"), THEN THE Pre-Screen_Node SHALL default to "warn" behavior and emit a warning message per matched violation while forwarding the question downstream

### Requirement 5: Pre-Screen Nonce Integration

**User Story:** As a pipeline operator, I want the pre-screen node to automatically fence question text and context documents with nonces, so that all untrusted text is clearly delimited for downstream processing.

#### Acceptance Criteria

1. WHEN enable_nonce_fencing is true and the guardrails scan action is "pass", THE Pre-Screen_Node SHALL wrap each question text by prepending and appending the cycle nonce as boundary delimiters
2. WHEN enable_nonce_fencing is true and the guardrails scan action is "warn" or "log", THE Pre-Screen_Node SHALL wrap each question text by prepending and appending the cycle nonce as boundary delimiters
3. WHEN enable_nonce_fencing is true and the guardrails scan action is "block", THE Pre-Screen_Node SHALL NOT fence the question text and SHALL NOT forward it downstream
4. WHEN enable_nonce_fencing is true and at least one context document is present in the question, THE Pre-Screen_Node SHALL wrap each context document individually using the same cycle nonce that was applied to the question text
5. WHEN fencing is applied to a question, THE Pre-Screen_Node SHALL append the system_addendum text to the end of the question so that the downstream LLM receives awareness of nonce boundary semantics
6. WHEN enable_nonce_fencing is false, THE Pre-Screen_Node SHALL forward questions and context documents without prepending or appending nonce delimiters and without injecting the system_addendum
7. IF the cycle nonce is unavailable or empty at the time fencing is requested, THEN THE Pre-Screen_Node SHALL reject the question with an error indication stating that nonce generation failed

### Requirement 6: Tool Call Authorization

**User Story:** As a pipeline operator, I want tool calls intercepted and evaluated against permission scopes, so that agents cannot invoke tools beyond their configured authorization.

#### Acceptance Criteria

1. WHEN a tool call is intercepted at PRE_TOOL_CALL, THE Authorization_Engine SHALL evaluate the tool_name, tool_args, and agent_id against all applicable permission scopes for that agent
2. WHEN a tool_name matches an entry in denied_tools for any applicable scope, THE Authorization_Engine SHALL deny the call regardless of allowed_tools entries and return an AuthDecision with allowed equal to false
3. WHEN a tool_name matches an entry in allowed_tools and does not match denied_tools, THE Authorization_Engine SHALL allow the call if all other checks (rate limit, schema) pass
4. WHEN no permission scope covers the calling agent_id (neither by explicit ID nor wildcard "*"), THE Authorization_Engine SHALL deny the call with a default-deny decision and scope_id set to "__default_deny__"
5. WHEN no scope grants access to the requested tool_name for the agent, THE Authorization_Engine SHALL deny the call with scope_id set to "__no_match__"

### Requirement 7: Rate Limiting

**User Story:** As a pipeline operator, I want per-scope rate limits on tool calls within a single run, so that runaway agents cannot make excessive tool invocations.

#### Acceptance Criteria

1. WHEN max_calls_per_run is set to an integer greater than zero for a scope, THE Authorization_Engine SHALL initialize a call counter at zero for that scope at the start of each run and increment it for each authorized call within that run
2. WHEN the call count for a scope reaches max_calls_per_run, THE Authorization_Engine SHALL deny subsequent tool calls under that scope and return a denial result that includes the scope identifier, the configured limit value, and a reason indicating rate limit exceeded
3. THE Authorization_Engine SHALL increment the call counter only after a call is authorized, not when denied
4. WHEN max_calls_per_run is zero for a scope, THE Authorization_Engine SHALL allow unlimited calls under that scope without tracking count
5. IF max_calls_per_run is set to a negative number or a non-integer value for a scope, THEN THE Authorization_Engine SHALL reject the configuration and report an error indicating the invalid limit value

### Requirement 8: Tool Argument Schema Validation

**User Story:** As a pipeline operator, I want tool call arguments validated against a configured JSON Schema, so that agents cannot pass malformed or dangerous arguments to authorized tools.

#### Acceptance Criteria

1. WHEN require_args_schema is configured for a scope, THE Authorization_Engine SHALL validate tool_args against all constraints defined in the require_args_schema (including type, required properties, format, minimum, maximum, pattern, and additionalProperties) before authorizing the call
2. IF tool_args do not conform to the require_args_schema, THEN THE Authorization_Engine SHALL deny the call with a failure reason that identifies the property path and the constraint that was violated
3. WHEN require_args_schema is not configured for a scope, THE Authorization_Engine SHALL skip argument schema validation for that scope and continue to the next authorization check
4. IF require_args_schema is configured but contains an invalid JSON Schema definition, THEN THE Authorization_Engine SHALL deny the call with a failure reason indicating the schema itself is malformed

### Requirement 9: Run-Level Policy Enforcement

**User Story:** As a pipeline operator, I want execution payloads validated and sanitized against a configured schema at run start, so that invalid or unexpected input fields never reach downstream agents.

#### Acceptance Criteria

1. WHILE enable_run_policy is true AND a payload_schema is configured, WHEN EXECUTION_START occurs, THE Trust_Gate SHALL validate the initial execution payload against the payload_schema
2. WHEN the payload contains keys not defined in the schema properties, THE Trust_Gate SHALL recursively strip unknown keys from the payload at all nesting levels before conformance validation
3. IF the sanitized payload does not conform to the configured schema due to type mismatches, missing required fields, or constraint violations, THEN THE Trust_Gate SHALL raise HookAborted with an error message indicating the first schema violation encountered and prevent execution from proceeding
4. WHEN enable_run_policy is false, THE Trust_Gate SHALL pass the payload through without validation or modification
5. WHEN payload_schema is not configured, THE Trust_Gate SHALL pass the payload through without validation or modification
6. IF the payload is empty or null at EXECUTION_START while enable_run_policy is true and a payload_schema is configured, THEN THE Trust_Gate SHALL raise HookAborted with an error message indicating the payload is missing
7. IF the configured payload_schema is not a valid schema definition, THEN THE Trust_Gate SHALL raise HookAborted with an error message indicating the schema is malformed and prevent execution from proceeding

### Requirement 10: Authorization Hook Abort

**User Story:** As a pipeline operator, I want unauthorized tool calls to be blocked via HookAborted exceptions, so that the agent framework stops the tool invocation.

#### Acceptance Criteria

1. WHEN the Authorization_Engine returns allowed equal to false and abort_on_unauthorized is true, THE Trust_Gate SHALL raise HookAborted with the denial reason and source identifier "TrustBoundaryEvaluationGate"
2. WHEN the Authorization_Engine returns allowed equal to false and abort_on_unauthorized is false, THE Trust_Gate SHALL log the denial and allow the tool call to proceed
3. IF the agent framework does not propagate HookAborted correctly, THEN THE Trust_Gate SHALL wrap the exception in a RuntimeError to ensure the tool call is still blocked

### Requirement 11: Audit Logging

**User Story:** As a security auditor, I want all authorization decisions logged with timestamps, so that I can review and investigate agent behavior after execution.

#### Acceptance Criteria

1. WHILE audit_log is true, WHEN the Authorization_Engine evaluates a tool call, THE Trust_Gate SHALL log a structured entry containing tool_name, agent_id, scope_id, allowed status, reason (truncated to 500 characters), and evaluated_at timestamp in ISO 8601 UTC format
2. WHILE audit_log is true, WHEN the Trust_Gate enforces run-level policy, THE Trust_Gate SHALL log a structured entry containing the outcome (accepted, modified, or rejected), the list of stripped keys if any were removed, and an evaluated_at timestamp in ISO 8601 UTC format
3. WHILE audit_log is false, THE Trust_Gate SHALL not emit authorization decision log entries or run-level policy log entries
4. WHILE audit_log is true, THE Trust_Gate SHALL emit each audit log entry at INFO level or above so that entries are not suppressed by default logging configuration

### Requirement 12: Node Lifecycle and Registration

**User Story:** As a pipeline developer, I want both security nodes to follow the standard rocketlib IGlobal/IInstance lifecycle, so that they integrate seamlessly with the RocketRide C++ execution engine.

#### Acceptance Criteria

1. THE Pre-Screen_Node SHALL register as a filter-type node with the Pipeline_Engine via its service descriptor, declaring a `register` value of `filter`
2. THE Trust_Gate SHALL register as a filter-type node with the Pipeline_Engine via its service descriptor, declaring a `register` value of `filter`
3. WHEN beginGlobal is invoked, THE Pre-Screen_Node SHALL read its configuration from the .pipe JSON via `Config.getNodeConfig`, initialize the Heuristic_Engine and Nonce_Fencer, and complete within 5 seconds
4. IF the Pre-Screen_Node .pipe JSON configuration is missing required fields or contains invalid values, THEN THE Pre-Screen_Node SHALL emit a warning describing the missing or invalid field and abort pipeline startup by raising an error
5. WHEN beginGlobal is invoked, THE Trust_Gate SHALL load permission scopes from the .pipe JSON via `Config.getNodeConfig` and register lifecycle hooks on the agent framework that intercept agent invocations before execution
6. IF the agent framework does not support the expected interception points, THEN THE Trust_Gate SHALL forward all objects to downstream nodes unmodified, log each forwarded object with its source node identifier and timestamp, and emit a warning indicating which interception points are unavailable
7. WHEN endGlobal is invoked, THE Pre-Screen_Node SHALL release the Heuristic_Engine and Nonce_Fencer resources, and THE Trust_Gate SHALL deregister its lifecycle hooks from the agent framework and release permission scope state

### Requirement 13: Glob Pattern Matching for Tool Permissions

**User Story:** As a pipeline operator, I want to use glob patterns in tool permission lists, so that I can concisely define broad tool access policies without listing every tool name.

#### Acceptance Criteria

1. THE Authorization_Engine SHALL interpret entries in allowed_tools and denied_tools as glob patterns supporting the wildcard characters `*` (matches zero or more characters) and `?` (matches exactly one character), evaluated with case-sensitive matching against tool_name values
2. WHEN a tool_name matches a denied_tools glob pattern, THE Authorization_Engine SHALL deny execution of that tool and return an authorization error indicating the tool is denied
3. WHEN a tool_name matches an allowed_tools glob pattern and does not match any denied_tools glob pattern, THE Authorization_Engine SHALL permit execution of that tool
4. WHEN a tool_name matches both an allowed_tools glob pattern and a denied_tools glob pattern, THE Authorization_Engine SHALL deny execution of that tool
5. IF a tool_name does not match any pattern in allowed_tools and does not match any pattern in denied_tools, THEN THE Authorization_Engine SHALL deny execution of that tool

### Requirement 14: Configuration Schema

**User Story:** As a pipeline operator, I want both nodes configurable through .pipe JSON with boolean toggles visible in the visual builder canvas, so that I can enable or disable security features without code changes.

#### Acceptance Criteria

1. THE Pre-Screen_Node .pipe configuration SHALL support boolean toggles for block_ignore_instructions (default: true) and enable_nonce_fencing (default: true)
2. THE Pre-Screen_Node .pipe configuration SHALL support policy_mode as a string field accepting values "block", "warn", or "log" with a default of "block"
3. THE Pre-Screen_Node .pipe configuration SHALL support nonce_length as an integer with a minimum value of 16 and a maximum value of 128, defaulting to 16
4. THE Trust_Gate .pipe configuration SHALL support boolean toggles for enable_tool_interception (default: true), enable_run_policy (default: false), abort_on_unauthorized (default: true), and audit_log (default: true)
5. THE Trust_Gate .pipe configuration SHALL support permission_scopes as a list of at most 50 scope objects each containing at minimum scope_id, allowed_tools, and denied_tools fields, and payload_schema as an optional JSON Schema object
6. IF the .pipe JSON contains a field value that violates its declared type or constraint, THEN THE Pipeline_Engine SHALL reject the configuration at load time and report an error message indicating the field name and the violated constraint
7. WHEN a supported configuration field is omitted from the .pipe JSON, THE node SHALL apply the documented default value and operate normally

### Requirement 15: Dependency Graceful Degradation

**User Story:** As a pipeline operator, I want security nodes to degrade gracefully when optional dependencies are missing, so that partial functionality is still available.

#### Acceptance Criteria

1. IF the jsonschema library is not importable at startup, THEN THE Trust_Gate SHALL disable run-level payload schema enforcement, forward payloads without schema validation, and log a warning that includes the library name and the feature that has been disabled
2. IF the CrewAI framework is not importable or does not expose the expected base class interface at startup, THEN THE Trust_Gate SHALL fall back to passthrough mode where all payloads are forwarded to downstream nodes unmodified and each forwarded payload is recorded in the audit log
3. WHEN the Trust_Gate enters degraded mode due to one or more missing optional dependencies, THE Trust_Gate SHALL log one warning per disabled feature at startup, stating the dependency name and the specific capability that is unavailable
4. WHILE operating in passthrough mode, THE Trust_Gate SHALL NOT reject or modify any payloads and SHALL append an audit log entry for each forwarded payload containing a timestamp and the payload identifier
