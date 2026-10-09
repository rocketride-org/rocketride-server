---
title: Decisions and Gates
---

# Decisions and Gates

A System One node answers questions about your content, like "Is this email spam?" or "Which team owns this?". A Gate node uses those answers to pass an item on or drop it. Together they let a pipeline send different content down different paths without calling a full LLM for every choice.

The System One node does not change your content. It records its answers on the object being processed, under `decisions`, and forwards the content as it came in. The Gate reads those answers.

## Route on a decision

Say you want to drop spam emails and keep only billing and refund messages from the rest.

```
parse ─text─▶ System One (is_spam) ─text─▶ Gate (is_spam equals no) ─text─▶ preprocessor
                                                                              │ documents
                                                                              ▼
                                       System One (topic) ─documents─▶ Gate (topic is one of billing, refund) ─▶ …
              └─text─▶ Gate (is_spam equals yes) ─text─▶ …
```

1. Add a System One node after the parser and give it a yes/no question named `is_spam`.
2. Add a Gate after it. Set **Pass when** to `all`, and add one condition: Question `is_spam`, Operator `equals`, Value `no`. Only non-spam text continues.
3. Add a second Gate on another wire from the same System One node, with `is_spam` `equals` `yes`, for the spam path. Each Gate sits on its own wire, so one System One node can feed several Gates.
4. After the preprocessor splits the text into chunks, add a second System One node with a pick-one question named `topic` and the options `billing`, `refund`, `legal` and `other`.
5. Add a Gate after it with Question `topic`, Operator `is one of`, Value `billing, refund`. Only chunks about billing or refunds continue.

A Gate has a **Pass when** setting (`all` or `any` of the conditions) and a list of **Conditions**. Each condition is a Question, an Operator and a Value.

| Operator | Value | True when |
|---|---|---|
| equals, does not equal | one value | the answer is, or is not, the value |
| is one of, is none of | a list, comma-separated | the answer is, or is not, in the list |
| `>`, `≥`, `<`, `≤` | a number | the comparison holds (for a rubric, it compares the level's position) |
| between | `low, high` | the answer is between them, inclusive |
| is answered | none | the question has an answer that is not `uncertain` |
| is uncertain | none | the answer is `uncertain` |

A rubric question (for example "How urgent is it?" with levels low, medium, high) answers with the level's text, so `equals high` works. `≥ 1` means medium or higher.

There is no "otherwise" output. To handle the other side of a rule, add a second Gate with the opposite rule, usually with `does not equal`.

## Whole document vs. each chunk

Where you put a System One node decides what it looks at.

- **Before the chunker, on the text lane:** it answers about the whole document, once. Use this for questions like "Is this spam?" or "What language is this?".
- **After the chunker, on the documents lane:** it answers about each chunk separately. Use this for "Which topic is this passage about?".

A chunk with no decision of its own uses the whole-document one. So a Gate on the documents lane can check `is_spam` even though that was answered on the whole text.

One System One node can have several input lanes connected. Every lane gets the same questions, so only connect lanes where those questions make sense.

## Uncertain answers

A node has a minimum confidence you can set per question. When the model is less sure than that, the answer is recorded as `uncertain` instead of its best guess.

`uncertain` is an ordinary answer value:

- `is_spam equals yes` is false for an uncertain answer.
- `is_spam does not equal yes` is true for an uncertain answer.

So use `does not equal` when you mean "anything but yes", including the cases where the model wasn't sure. Use `is uncertain` to send unsure items to a person for review, and `is answered` to keep only confident ones.

## Too long

System One never answers from part of a text, document, table or answer. If an input is longer than the model can take:

- **Whole text or an answer:** the object fails with an error.
- **A chunk or a table:** the item is marked `too_long`, with no answers, and a warning is logged. **Every Gate blocks it**, whatever its rule, including `does not equal` and `is uncertain`.
- **A question** (on the questions lane) is the one exception: it is shortened to fit, a warning is logged, and the record is marked `truncated`.

Split long text with a preprocessor before the System One node, so each piece fits. The limit depends on the model (Ollama's Nimble takes 8192 tokens, tev1 takes 2048).

## Convert to text first

System One reads text. An image, audio or video can't be sent to it, and a non-text document fails the object with the message "System One reads text; convert this content to text first". Run OCR, captioning or transcription first, and put the System One node after it.

## Where to put a Gate

Put the Gate **downstream of the node that answers its questions, on the same path.** The Gate reads decisions that already exist when an item arrives. Branches that run side by side run in an order the canvas doesn't show, so a Gate on a different branch from the System One node may run first. It then fails with an error that names the missing question.

A Gate also fails the object when no decision exists for its question, instead of guessing. Check that the question name in the Gate matches the name on the System One node exactly.

If two nodes on the same path answer a question with the same name, the Gate stops with an error. Rename one of them.

A Gate can sit on any lane. It forwards each item on the lane it arrived on, so it works on text, documents, tables, questions, answers, JSON, images, audio and video. For images, audio and video it uses the decision for the whole object, so the whole stream passes or is blocked together.

## Seeing the decisions

Everything a System One node decided appears in the result under `decisions`, grouped by node and one entry per item:

```json
{
  "decisions": {
    "decision_ollama_1": {
      "writer": "decision_ollama",
      "model": "nimble",
      "questions": { "is_spam": { "kind": "yes_no", "question": "Is this email spam?" } },
      "items": [
        { "lane": "text", "status": "ok",
          "preview": "Hi Dylan, following up on the invoice we sent…",
          "answers": { "is_spam": { "answer": "no", "confidence": 0.84 } } }
      ]
    }
  }
}
```

The `preview` is the start of the item, so you can tell which one the answer belongs to. An item with a `status` other than `ok` (such as `too_long`) has no answers.

Don't name a response lane `decisions`. The name is reserved.

If you are writing a node that records decisions, see [Making a node's output routable](https://github.com/rocketride-org/rocketride-server/blob/develop/docs/development/nodes/decisions.md).
