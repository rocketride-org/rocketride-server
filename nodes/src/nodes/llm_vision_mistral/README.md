# Mistral Vision node

## Supported Models & Token Limits

| Model Name             | Description                        | Max Tokens |
|------------------------|------------------------------------|------------|
| pixtral-12b-latest     | Pixtral 12B - High Performance     | 4096       |
| pixtral-large-latest   | Pixtral Large - Best Quality       | 4096       |
| mistral-medium-latest  | Mistral Medium - Vision Enabled    | 3025       |
| mistral-small-latest   | Mistral Small - Vision Enabled     | 3025       |

*See `services.json` for full configuration and model details.*

---

## Capabilities
- Image-to-Text: Analyze images and return text responses using Mistral's vision models.
- Robust Error Handling: Handles invalid input, API errors, and retries on transient failures.
- Token Counting: Uses the official Mistral tokenizer for accurate token management.
- Flexible Prompts: Supports custom system and user prompts for each request.

---

## Diagram Overview

```
[Image Input (chunks)]
   ↓
[writeImage() accumulates]
   ↓
[AVI_END → base64 + Question]
   ↓
[Chat.chat() sends to Mistral API]
   ↓
[LLM response (text)]
   ↓
[writeText() → pipeline]
```

---

## Data Flow

1. **Image Accumulation:**
   - The `writeImage()` method in `IInstance` receives image data in chunks and accumulates it until the image is complete.

2. **Building the Question:**
   - When the image is fully received (`AVI_END`), the image is encoded as a base64 data URL.
   - A `Question` object is created, which holds the image context (base64 data URL) and the prompt text.
   - The prompt text is loaded from the node configuration: `vision.prompt` if set, otherwise `prompt`.

3. **Sending to LLM:**
   - The `Question` object is passed to the `chat()` method in the `Chat` class (`mistral_vision.py`).
   - This method validates and processes the image, then sends the request to the Mistral Vision API.

4. **LLM Response:**
   - The LLM’s text response is returned and written back to the pipeline using `writeText()`.

---

## Expected Inputs / Supported Types
- Accepts image inputs via `AVI_ACTION` chunks
- Supports formats: `image/png`, `image/jpeg`, `image/gif`, `image/webp`
- Image size limit: 10MB

---

For more details, see the code in `IInstance.py`, `IGlobal.py`, and `mistral_vision.py`. 