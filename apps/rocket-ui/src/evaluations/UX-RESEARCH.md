# RocketRide evaluation experience

## Product objective

Someone who can build a RocketRide pipeline should be able to evaluate it without first learning evaluation infrastructure. The first meaningful outcome is a real response, a comprehensible quality check, and an explanation of what to improve. An experienced engineer must retain control of inputs, scoring, runtime selection, repeated trials, versioned evidence, and comparisons.

The proposed experience starts inside the existing pipeline canvas. The pipeline is already known, so asking the user to reconstruct a target function or repeat model configuration adds unnecessary work. The initial decisions are an example input and the expected behavior. Technical execution choices remain available through All settings. This is a design recommendation based on the comparison below, not a claim that competitor parity or better usability has been established by user testing.

## Evidence and limits

The supplied `langsmith-vs-rocketride-digest.html`, dated September 3, 2026, describes the strategic opportunity: reuse the runtime and its trace evidence to make repeatable quality checks. Its reported production/staging capabilities and PR statuses are historical inputs, not fresh verification of those branches. In particular, an emitted event alone does not establish a reproducible test or a trusted expected answer.

The external review used official LangSmith, Braintrust, Langfuse, and Phoenix documentation, plus Nielsen Norman Group's interaction guidance. Public product screenshots were visually inspected for LangSmith's experiment results and Braintrust's playground. The comparison does not claim hands-on access to authenticated competitor workspaces. Documentation can omit account setup, entitlement restrictions, and intermediate errors. Apple’s onboarding documentation page was also consulted, but its JavaScript delivery did not provide enough readable evidence for detailed assertions. The Apple reference therefore remains an experiential brief: confidence, continuity, and few unnecessary decisions.

## Comparative findings

| Product | Documented workflow | Useful pattern for RocketRide | Adaptation required |
|---|---|---|---|
| LangSmith | Configure target, create examples, select an evaluator, start an experiment | Prebuilt evaluation choices and visible expected/actual output | Infer the target from the current pipeline |
| Braintrust | Configure tasks and scorers in a playground, run rows, inspect differences, preserve selected experiments | Fast iteration; comparison keeps inputs, outputs, and scores together | RocketRide already owns the executable graph |
| Langfuse | Start from a dataset, select prompt/model configuration and optional evaluator, run and compare | Make examples a reusable working asset | Its prompt UI is not equivalent to arbitrary full-pipeline execution |
| Phoenix | Use datasets, execute an application task, evaluate outputs, compare experiments | Keep execution evidence distinct from scoring | Its documented introductory application workflow includes code |

LangSmith's quickstart introduces three concepts: the data to test, the thing being tested, and the scoring function. Its UI walkthrough supplies a correctness evaluator instead of requiring the user to implement one. The official result screenshot puts input, reference output, actual output, correctness, and latency together. This makes the meaning of a result visible without first opening a separate technical report.[1]

Braintrust's playground accepts tasks, scorers, and optional datasets. It supports single-row runs and comparing variants. Playground reruns replace the current working results, while saving an experiment preserves a snapshot. Its screenshots use a workspace grid with task columns and a prominent Run action. This favors frequent iteration but can still look dense to a newcomer; copying its entire workspace would not automatically solve RocketRide's onboarding problem.[2]

Braintrust's comparison flow aligns test cases against a baseline and exposes score changes. Sorting regressions and looking at changed outputs ties aggregate performance to individual examples. RocketRide should likewise explain a regression through the example and trace, rather than presenting a percentage with no route to diagnosis.[3]

Langfuse's UI experiment flow begins from a dataset and exposes prompt selection, connection configuration, and optional evaluation. It distinguishes these prompt experiments from full application logic evaluated through SDK or other execution paths. RocketRide's whole-pipeline runner is therefore a meaningful integration advantage, provided the UI makes that advantage understandable.[4]

Phoenix's introductory experiment guide demonstrates comparing application versions using shared data and evaluation criteria. It reinforces the conceptual separation between executing a task and deciding whether its result is good. A pipeline completing successfully is insufficient evidence that the answer meets an expectation.[5]

## Interaction principles

Progressive disclosure keeps the common decisions visible and offers specialized controls on request. Nielsen Norman Group distinguishes this from a wizard, which divides the main task into successive stages. It also warns that stages can impede work when users repeatedly move between interdependent decisions.[6]

RocketRide needs both approaches. A first-time user gets three short stages: examples, checks, review/run. Each stage can be revisited directly. An experienced user can switch to All settings without converting the underlying evaluation or losing its values. This avoids separate beginner and expert formats that would drift apart over time.

The first stage should teach through a real task. An input field and expected-answer field explain evaluation more effectively than a glossary followed by an empty dataset table. The examples in placeholders illustrate the structure without becoming automatically approved test data. A deliberate confirmation establishes that the author has reviewed the expectation.

The second stage should describe observable behavior. “Includes the expected answer” is easier to assess than `contains`. “Let a person review it” explains both the mechanism and why the result will not immediately be an automatic pass. Latency checks reveal their time limit when selected. AI judges require honest configuration affordances: a label promising automatic intelligence is misleading when a separate judge pipeline has not been configured.

The final stage should explain the work before starting it. It summarizes examples, selected checks, environment, input mode, repetitions, and pass target. If the canvas has changed, the user can explicitly adopt the current graph; a silently stale target would destroy trust. Starting a run saves the version required by the backend. The user should not have to discover that a separate save action is a prerequisite.

## Changes in this refresh

The default Setup screen uses a compact progress navigation and a single focused stage. The first example can be entered inline. Existing CSV/JSON import and case review remain available. Quality presets map to the existing deterministic, JSON, latency, and human-review scorer kinds. All settings retains the existing judge editor, additional checks, environment controls, repetitions, dataset name, pipeline snapshot, and pass criteria.

Run evaluation saves a changed or new evaluation before submitting execution. It uses the server-issued revision and keeps the existing idempotency key behavior for a retry of the same run request. A failed save must not be followed by execution. A failed run request must leave the saved setup available. Conflict handling must preserve the draft and require resolution before another write.

The saved evaluation library is disclosed separately from first-time setup. Draft export, explicit save, JSON editing, results, and assistant access remain available. These are genuine features rather than cosmetic controls. However, explicit save remains necessary for saving work without running; this refresh does not promise persistent autosave of unfinished text.

Results now lead with whether the evaluation met its criteria and an appropriate next action. Execution errors prompt diagnosis, incomplete evidence prompts review, failures prompt expected-versus-actual inspection, and completed scored runs suggest using a baseline. The existing case details, graph trace navigation, exports, and baseline comparison continue to carry the evidence.

## Beginner and expert journeys

The beginner opens an existing pipeline's Evaluations tab, supplies one realistic input and expected answer, confirms the example, accepts or changes the suggested check, reviews the summary, and runs. The success condition is not necessarily a green result. A failed answer with a clear explanation is also a successful first evaluation because it exposes something actionable.

The returning engineer opens a saved evaluation, switches directly to All settings if needed, imports additional examples, reviews them, configures specialized scoring, and runs a changed revision. The baseline remains an explicit choice supported by completed evidence. Exported specs and reports support the established engineering workflow without making JSON the primary interface.

A reviewer opens a result and examines the input, expected answer, actual output, check result, and trace. Human review remains distinguishable from automatic scoring. Empty, unreviewed, failed, errored, incomplete, and abstaining outcomes must never be relabeled as success merely to make the UI feel smooth.

## Remaining opportunities

The current first-run path is strongest for deterministic text checks. A first-class judge builder with rubric templates and an existing model connection would improve semantic evaluation onboarding. It should only be presented as ready when it can execute with valid configuration. Similarly, traces should become examples through a reviewed capture workflow with complete inputs and provenance; a decorative “use traces” button would create a false promise.

The results workspace still has room for improvement: focus failures before secondary metadata, expose side-by-side outputs earlier, and offer selected-row reruns when the backend contract supports them. Large-dataset workflows require real pagination, filtering, and storage behavior, not a visual table alone. No scalability claims follow from testing one example.

Agent-assisted authoring should share these same examples and checks. The cloud harness can help generate a draft, explain weak criteria, or expand edge cases, but an unavailable harness must not block manual local evaluation. The gateway remains secondary to this refresh.

## Acceptance and usability study

Functional acceptance requires an actual browser run against the local engine: create a reviewed example, select a check, save-and-run once, observe the persisted result, and reload it from the library. Exercise both pass and fail cases, edited references requiring renewed review, hidden advanced settings, and a viewport narrow enough to trigger responsive layout. Check that failed requests retain data and cannot show a fabricated success.

Usability acceptance needs people as well as automation. Ask several first-time users to evaluate a pipeline without narration. Observe whether they understand what to type, distinguish an expected answer from an input, choose a suitable check, explain the outcome, and find the next improvement. Ask experienced users to import cases, change a threshold, locate the executed graph, and compare runs. Proposed targets are a first useful result within five minutes and completion without facilitator intervention; these are future study targets, not measured results.

## Verification record

The local browser walkthrough saved an evaluation, executed the real Webhook-to-Return-Text pipeline, and persisted a passing response. An earlier run exposed a five-second cleanup deadline that was shorter than the engine's shutdown sequence. The deadline is now bounded at 30 seconds; a regression test exercises termination lasting longer than five seconds. The complete SaaS suite passed with 425 tests and one skip. The UI suite passed 18 checks, including inference of text input from source connections, and the TypeScript check and production bundle build passed. These are engineering checks; no human onboarding study has yet been conducted.

## References

1. LangChain, [Evaluation quickstart](https://docs.langchain.com/langsmith/evaluation-quickstart), accessed September 14, 2026. Official walkthrough and experiment result screenshot.
2. Braintrust, [Iterate in playgrounds](https://www.braintrust.dev/docs/evaluate/playgrounds), accessed September 14, 2026. Official workflow and visual layout.
3. Braintrust, [Compare experiments](https://www.braintrust.dev/docs/evaluate/compare-experiments), accessed September 14, 2026. Baseline and regression inspection.
4. Langfuse, [Experiments via UI](https://langfuse.com/docs/evaluation/experiments/experiments-via-ui), accessed September 14, 2026. Prompt experiment setup and application-execution distinction.
5. Arize, [Optimize Your App with Experiments](https://arize.com/docs/phoenix/get-started/get-started-datasets-and-experiments), accessed September 14, 2026. Dataset/task/evaluator model.
6. Nielsen Norman Group, [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/), accessed September 14, 2026. Progressive versus staged disclosure and interaction tradeoffs.
7. Supplied attachment, `langsmith-vs-rocketride-digest.html`, September 3, 2026, sections Product shape, Test results, Delivery state, and Build order. Private historical context.
