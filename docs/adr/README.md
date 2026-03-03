# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the RocketRide Engine project.

ADRs document significant architectural decisions made during the project's development. They provide context for why certain choices were made and what alternatives were considered.

## Format

We use the [MADR](https://adr.github.io/madr/) (Markdown Any Decision Records) template.

## Index

| # | Title | Status | Date |
|---|-------|--------|------|
| [0001](0001-custom-build-system.md) | Custom build system | Accepted | 2024-01-15 |

## Creating a New ADR

1. Copy the template below
2. Number it sequentially (e.g., `0002-your-decision.md`)
3. Fill in the sections
4. Submit via pull request

### Template

```
# [short title]

## Status

[Proposed | Accepted | Deprecated | Superseded by [ADR-XXXX](XXXX-title.md)]

## Context

[Describe the issue motivating this decision]

## Decision

[Describe the decision and its rationale]

## Consequences

### Positive
- [benefit]

### Negative
- [tradeoff]
```
