# Conditional Node (`conditional`)

Pipeline routing component that evaluates a condition per entry and directs data
to one of two exclusive output lanes: `then` (condition true) or `else`
(condition false).

## Lanes

| Input lane  | Output lanes    |
| ----------- | --------------- |
| `text`      | `then` / `else` |
| `questions` | `then` / `else` |

Only text-like lanes are supported in this iteration. Additional lane types
(audio, video, image, documents, classifications, etc.) will land in follow-up
PRs.

## Condition

A **real Python expression** evaluated in a sandbox against the incoming
content. Any valid Python expression works — comparisons, string methods,
comprehensions, boolean combinations, etc. Truthy routes to `then`; falsy
routes to `else`.

### Scope

| Variable    | Type     | Available in                      |
| ----------- | -------- | --------------------------------- |
| `text`      | `str`    | `writeText` (text lane)           |
| `questions` | `object` | `writeQuestions` (questions lane) |

### Examples

```python
'confidential' in text                  # substring match
len(text) > 100                         # length check
text.lower().startswith('error')        # string method
any(kw in text for kw in ['a', 'b'])    # comprehension
```

## Failure mode

If the expression raises at runtime, the chunk is routed to `else` and a debug
message is emitted.
