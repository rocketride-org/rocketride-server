# accessibility_describe

A RocketRide image node that converts an image into a safety-oriented scene
description for blind and visually impaired users. Choose it when the next step
needs accessible text, including hazards, spatial references, visible text, and
navigation guidance.

## About Google Gemini

Google Gemini is the vision-model provider used by this node through the
`google-genai` Python package. The node sends image bytes and its analysis
prompt to the configured Gemini model in one content-generation request.

## What it does

The node buffers an incoming image stream until it finishes, then passes the
image and configured analysis prompt to Gemini and writes Gemini's response to
the `text` lane. Its built-in instructions emphasize hazards, spatial
orientation, readable text, concision, and environmental context; the default
analysis prompt requests environment, hazards, objects, text, people, and
navigation in fewer than 150 words.

It is a pipeline filter, not an agent tool. Use it for a complete
accessibility-focused narration instead of an image operation whose downstream
consumer needs another kind of result. An empty image stream produces no text.

---

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `image` | `text` | Analyze the completed image stream and emit the generated description. |

## Profiles

Default: **Gemini 2.5 Flash - Fast & Efficient (1M tokens)** (`gemini-2.5-flash`).

| Profile | Model | Context limit |
| --- | --- | --- |
| Gemini 2.5 Flash - Fast & Efficient (1M tokens) **(default)** | `gemini-2.5-flash` | `1048576` tokens |
| Gemini 2.5 Pro - High Quality (1M tokens) | `gemini-2.5-pro` | `1048576` tokens |
| Gemini 2.0 Flash - Balanced (1M tokens) | `gemini-2.0-flash` | `1048576` tokens |

## Configuration

Start with the default Flash profile, provide its API key, and keep the built-in
instructions and prompt if their safety-first structure fits the task. Adjust
the text fields when the user needs a different description policy, then use
the two formatting controls to make the output easier to act on. The model and
context-limit values are supplied by the selected profile.

### System Instructions

This text is the model's system instruction. By default it directs the model to
lead with hazards, use clock positions and relative distances, read visible text
exactly, favor actionable information, and identify the environment and
landmarks. Change it for a durable policy that should apply to every image—for
example, to add a site-specific safety rule—rather than to ask about one image.

An empty value falls back first to the generic `systemPrompt` runtime setting,
then to the built-in instruction. The selected hazard priority and spatial
format are appended to this instruction, so keep it compatible with those
controls instead of duplicating contradictory spatial or ordering rules.

### Analysis Prompt

The analysis prompt is the per-image request. Its default requests six
sections—environment, hazards, key objects, text, people, and navigation—and
asks Gemini to keep the description under 150 words. Change it when the output
has to match a particular consumer or structure; for example, ask for a brief
navigation-only description when a downstream voice interface must respond
quickly.

Leaving it empty falls back to the generic `prompt` runtime setting and then to
the built-in prompt. The implementation sends this text with the image, while
the system instructions remain a separate model setting.

### Hazard Priority

This control appends a safety-ordering instruction to the system prompt. The
default `high` tells the model to lead with hazards and to state that the area
appears safe when it finds none. Choose `medium` to include hazards in their
spatial context without requiring them first, or `low` for no extra hazard
emphasis. Keep `high` for navigation-oriented descriptions; lower it only when
another description order is more useful.

### Spatial Format

This control appends the requested spatial-language style to the system prompt.
`clock`, the default, asks for clock positions with 12 o'clock straight ahead;
`relative` asks for left, right, ahead, and behind; `both` asks for both forms.
Use `relative` for readers unfamiliar with clock positions, or `both` when
redundant orientation is valuable. It works alongside Hazard Priority because
hazards can use whichever spatial convention is selected.

---

## Authentication

Set the selected profile's Google AI API key in the node configuration. The
node will not start without a key, and it rejects a value beginning with `sk-`
as an OpenAI key rather than sending it to Gemini. Create the required key in
[Google AI Studio](https://aistudio.google.com/apikey).

## Notes

### Request and failure behavior

At the end of the image stream, the node base64-encodes the received bytes into
a data URL and sends the decoded bytes to Gemini with temperature `0.3` and a
maximum of `1024` output tokens. It makes one initial request plus up to three
retries for errors whose messages indicate a timeout, connection failure, HTTP
`500`, `502`, `503`, or `504`, or an internal server error; retry waits are 1,
2, and 4 seconds.

If all attempts fail, it raises an accessibility-vision error. Authentication,
rate-limit, invalid-input, unavailable-model, timeout, and safety-block
messages are translated to user-facing error text; other failures retain the
Google AI error message. A missing image or malformed image data URL raises a
value error before the model request.

## Upstream docs

- [Google Gemini API documentation](https://ai.google.dev/gemini-api/docs)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `accessibility.prioritizeHazards` | `string` | **Hazard Priority**<br/>How aggressively to prioritize hazard detection | `"high"` |
| `accessibility.prompt` | `string` | **Analysis Prompt**<br/>Prompt template for generating accessibility descriptions from images | `"Describe this image for a blind person. Include: environment type, hazards with positions, key objects with clock positions, visible text, people, and navigation guidance. Keep under 150 words."` |
| `accessibility.spatialFormat` | `string` | **Spatial Format**<br/>How to describe spatial positions | `"clock"` |
| `accessibility.systemPrompt` | `string` | **System Instructions**<br/>Define the accessibility description behavior and priorities | `"You are an accessibility-focused scene analyzer designed to help blind and visually impaired users understand their surroundings through image descriptions."` |
| `accessibility_describe.profile` | `string` | **Vision Model**<br/>Select the Gemini vision model for accessibility descriptions | `"gemini-2.5-flash"` |
| `model` | `string` | **Model**<br/>Google Gemini vision model |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Maximum context length in tokens |  |

## Dependencies

- `google-genai` `>=1.14.0`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/accessibility_describe)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
