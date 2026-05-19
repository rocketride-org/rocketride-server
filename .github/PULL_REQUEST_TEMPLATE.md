## Summary

<!-- Describe your changes in 1-3 bullet points -->

-

## Type

<!-- What kind of change is this? (feature, fix, refactor, docs, chore, etc.) -->

## Testing

- [ ] Tests added or updated
- [ ] Tested locally
- [ ] `./builder test` passes

## Checklist

- [ ] Commit messages follow [conventional commits](https://www.conventionalcommits.org/)
- [ ] No secrets or credentials included
- [ ] Wiki updated (if applicable)
- [ ] Breaking changes documented (if applicable)
- [ ] For any new `Question(...)` constructor call inside an agent integration: does it inherit `attachments` from the entry-point question, or is the drop documented? (TDD §8.1, Slice D)
- [ ] For new multimodal `@tool_function` tools: are all `format: "rocketride-attachment"` markers at the top level of `inputSchema.properties` (no nesting, no arrays)? (TDD §10.3, Q-H2)

## Linked Issue

<!-- REQUIRED: Every PR must be linked to an issue. Use one of: -->
<!-- Fixes #123 / Closes #123 / Resolves #123 -->

Fixes #
