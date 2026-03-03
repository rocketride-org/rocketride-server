# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the RocketRide Engine project. ADRs document significant technical decisions made during the project's development.

## Format

We use [MADR](https://adr.github.io/madr/) (Markdown Any Decision Records) format.

## Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-custom-build-system.md) | Custom declarative build system | Accepted | 2024-01-15 |

## Creating a New ADR

1. Copy the template below into a new file named `NNNN-short-title.md`
2. Fill in the sections
3. Submit as a PR for review

### Template

```markdown
# NNNN: Title

## Status

Proposed | Accepted | Deprecated | Superseded by [NNNN](NNNN-title.md)

## Context

What is the issue that we're seeing that is motivating this decision or change?

## Decision

What is the change that we're proposing and/or doing?

## Consequences

What becomes easier or more difficult to do because of this change?
```
