# ocr

A RocketRide filter node that extracts machine-readable text and tables from images using optical character recognition.

## What it does

Turns visual content (scanned documents, screenshots, photos) into structured text for downstream analysis. The node is GPU-capable and registered as a filter in the pipeline.

Four OCR engines are supported via the `ai.common.models` model-server wrappers: **EasyOCR** (multi-language, the default), **DocTR** (document-focused, language-agnostic), **Surya** (multi-language, 90+ languages), and **TrOCR** (transformer-based, Microsoft model). The wrappers auto-detect whether to call a remote model server or fall back to local inference. An unknown engine name falls back to EasyOCR silently.

Table extraction uses **img2table** for OpenCV-based table structure detection, with OCR inference routed through the same model-server adapter (`ModelServerOCR`). Detected tables are emitted on the `table` lane as Markdown. Both img2table v1 and v2 plug-in APIs are supported: v2 reorganised the API and replaced the two-step `content`/`to_ocr_dataframe` contract with a single `of()` method returning `OCRData`; the node detects the installed version at import time via `_IMG2TABLE_V2`.

Animated GIFs are handled frame by frame: each frame is OCR'd individually and the per-frame texts are joined with newlines before being written to the `text` lane. OCR reads are serialised with an internal threading lock so concurrent instances share one engine safely.

---

## Configuration

### Lanes

| Lane in     | Lane out | Description                       |
| ----------- | -------- | --------------------------------- |
| `documents` | `text`   | Extract text from image documents |
| `image`     | `text`   | Extract text from a raw image     |
| `image`     | `table`  | Extract tables from a raw image   |

On the `documents` lane, every incoming document must be of type `Image` (the node raises a `ValueError` otherwise). Each image document is OCR'd and re-emitted as a `Document`-type copy whose `page_content` is the extracted text. The original image documents are not forwarded: if a downstream node needs the images themselves, connect it to the source node directly.

### Fields

| Field | Type | Description |
|---|---|---|
| `engine` | string | Default "easyocr". Select the OCR engine for text extraction. EasyOCR supports many languages with script families. DocTR is language-agnostic and good for documents. Surya supports multi-language. TrOCR uses transformer models. |
| `script_family` | string | Default "latin". Select the script family for OCR. This determines which languages are loaded for text recognition. Only applies to EasyOCR engine. |
| `det_arch` | string | Default "db_resnet50". Choose the architecture used for table text detection.
 Documentation: https://mindee.github.io/doctr/latest/using_doctr/using_models.html |
| `reco_arch` | string | Default "crnn_vgg16_bn". Choose the architecture used for table text recognition.
 Documentation: https://mindee.github.io/doctr/latest/using_doctr/using_models.html |
| `table_engine` | string | Default "doctr". Select the OCR engine used for table text extraction. DocTR is optimized for document tables. EasyOCR and Surya are general-purpose alternatives. |
| `profile` | string | Default "latin". Select a preconfigured OCR profile optimized for different languages and use cases. |

The main settings panel exposes `ocr.profile`, `ocr.engine`, `ocr.script_family`, and `ocr.table_engine`. The DocTR architecture fields (`ocr.det_arch`, `ocr.reco_arch`) accept the architectures listed in the [DocTR model docs](https://mindee.github.io/doctr/latest/using_doctr/using_models.html).

Detection architectures: `linknet_resnet18`, `linknet_resnet34`, `linknet_resnet50`, `db_resnet50`, `db_mobilenet_v3_large`, `fast_tiny`, `fast_small`, `fast_base`.

Recognition architectures: `crnn_vgg16_bn`, `crnn_mobilenet_v3_small`, `crnn_mobilenet_v3_large`, `sar_resnet31`, `master`, `vitstr_small`, `vitstr_base`, `parseq`.

The TrOCR engine additionally reads an optional `trocr_model` config value selecting the Hugging Face model variant (default: `microsoft/trocr-base-printed`).

---

## Profiles

Profiles are preconfigured combinations of engine, script family, and table engine. Selecting a profile sets all three at once. The default profile is `latin`.

| Profile key            | Title                         | Engine  | Script family         | Table engine |
| ---------------------- | ----------------------------- | ------- | --------------------- | ------------ |
| `latin`                | Latin (English)               | EasyOCR | `latin`               | DocTR        |
| `latin-extended`       | Latin Extended (European)     | EasyOCR | `latin-extended`      | DocTR        |
| `cyrillic`             | Cyrillic (Russian, etc.)      | EasyOCR | `cyrillic`            | DocTR        |
| `arabic`               | Arabic/Persian/Urdu           | EasyOCR | `arabic`              | DocTR        |
| `devanagari`           | Devanagari (Hindi, etc.)      | EasyOCR | `devanagari`          | DocTR        |
| `chinese-simplified`   | Chinese (Simplified)          | EasyOCR | `chinese-simplified`  | DocTR        |
| `chinese-traditional`  | Chinese (Traditional)         | EasyOCR | `chinese-traditional` | DocTR        |
| `japanese`             | Japanese                      | EasyOCR | `japanese`            | DocTR        |
| `korean`               | Korean                        | EasyOCR | `korean`              | DocTR        |
| `doctr`                | DocTR (Language-agnostic)     | DocTR   | `latin` (unused)      | DocTR        |
| `surya`                | Surya (Multi-language)        | Surya   | `latin` (unused)      | Surya        |
| `trocr`                | TrOCR (Transformer)           | TrOCR   | `latin` (unused)      | DocTR        |

---

## Script families

Script families map to EasyOCR language code lists. Every family except plain `latin` also loads English as a fallback. The `script_family` setting has no effect when the selected engine is DocTR, Surya, or TrOCR.

| Family                | Languages loaded                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `latin`               | `en` only (English only, for reliability)                                                                                              |
| `latin-extended`      | `en` plus ~28 Latin-script languages: fr, de, es, it, pt, nl, pl, ro, cs, sk, hu, hr, sl, sq, lt, lv, da, no, sv, id, ms, tl, vi, tr, az, uz, sw, la, oc |
| `cyrillic`            | ru, uk, be, bg, rs_cyrillic, mn, en (Macedonian not supported by EasyOCR; Serbian maps to `rs_cyrillic`)                              |
| `arabic`              | ar, fa, ur, ug, en                                                                                                                     |
| `devanagari`          | hi, mr, ne, en                                                                                                                         |
| `bengali`             | bn, as, en                                                                                                                             |
| `chinese-simplified`  | ch_sim, en                                                                                                                             |
| `chinese-traditional` | ch_tra, en                                                                                                                             |
| `japanese`            | ja, en                                                                                                                                 |
| `korean`              | ko, en                                                                                                                                 |
| `thai`                | th, en                                                                                                                                 |
| `tamil`               | ta, en                                                                                                                                 |
| `telugu`              | te, en                                                                                                                                 |

The `bengali`, `thai`, `tamil`, and `telugu` families are selectable via `ocr.script_family` but have no preconfigured profile. The Japanese EasyOCR models may misread English text; the full test suite uses a relaxed assertion (`contains: "quick"` instead of `"quick brown fox"`) for that profile.

---

## OpenCV compatibility

All four engines share the `cv2` namespace but require different OpenCV builds. The node installs a single unified build, `opencv-contrib-python==4.13.0.92`, via `ai.common.opencv`, which also uninstalls competing variants (`opencv-python`, `opencv-python-headless`, `opencv-contrib-python-headless`) so only one `cv2` is active at runtime.

Upstream pins (as of the versions currently used):

| Engine  | PyPI package                               | Upstream OpenCV requirement            | Matches project's 4.13.0.92? |
| ------- | ------------------------------------------ | -------------------------------------- | ---------------------------- |
| EasyOCR | `easyocr` 1.7.2                            | `opencv-python-headless` (unpinned)    | Yes                          |
| DocTR   | `python-doctr` 1.0.1                       | `opencv-python <5.0.0, >=4.5.0`        | Yes                          |
| Surya   | `surya-ocr` 0.17.1                         | `opencv-python-headless==4.11.0.86`    | No (hard pin to 4.11.0.86)   |
| TrOCR   | `craft-text-detector` 0.4.3 (detector dep) | `opencv-python <4.5.4.62, >=3.4.8.29`  | No (caps below 4.5.4.62)     |

Surya and TrOCR's detector pin OpenCV to versions the project deliberately overrides. They work because `ai.common.opencv` runs `depends()` at import time and force-aligns all four OpenCV variants to 4.13.0.92 after the engines are installed. Always import `from ai.common.opencv import cv2` before importing an OCR engine, or the wrong `cv2` may be resolved.

For the same reason, `IGlobal.py` imports `ai.common.opencv` before img2table: img2table internally imports `cv2` at load time, so the correct OpenCV package must already be active.

---

## img2table version compatibility

img2table 2.0 (released 2026-05-10) reorganised the OCR plug-in API. The node supports both v1 and v2:

| Symbol / location                  | img2table v1      | img2table v2      |
| ---------------------------------- | ----------------- | ----------------- |
| `OCRInstance` base class           | `img2table.ocr.base` | `img2table.ocr._types` |
| Result type returned by `of()`     | `OCRDataframe` (`img2table.ocr.data`) | `OCRData` (`img2table.ocr._types`) |
| Plug-in contract                   | `content()` + `to_ocr_dataframe()` | single `of()` override |

The `_IMG2TABLE_V2` flag is set at import time and gates each code path. `external_contracts.py` declares version-tagged import requirements so the `check-externals` CI framework can validate the correct symbols on whichever version is installed.

---

## Upstream docs

- [EasyOCR](https://github.com/JaidedAI/EasyOCR)
- [DocTR documentation](https://mindee.github.io/doctr/)
- [Surya](https://github.com/VikParuchuri/surya)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `ocr.det_arch` | `string` | **Detection Architecture (DocTR)**<br/>Choose the architecture used for table text detection.<br/> Documentation: https://mindee.github.io/doctr/latest/using_doctr/using_models.html | `"db_resnet50"` |
| `ocr.engine` | `string` | **OCR Engine**<br/>Select the OCR engine for text extraction. EasyOCR supports many languages with script families. DocTR is language-agnostic and good for documents. Surya supports multi-language. TrOCR uses transformer models. | `"easyocr"` |
| `ocr.profile` | `string` | **OCR Profile**<br/>Select a preconfigured OCR profile optimized for different languages and use cases. | `"latin"` |
| `ocr.reco_arch` | `string` | **Recognition Architecture (DocTR)**<br/>Choose the architecture used for table text recognition.<br/> Documentation: https://mindee.github.io/doctr/latest/using_doctr/using_models.html | `"crnn_vgg16_bn"` |
| `ocr.script_family` | `string` | **Script Family**<br/>Select the script family for OCR. This determines which languages are loaded for text recognition. Only applies to EasyOCR engine. | `"latin"` |
| `ocr.table_engine` | `string` | **Table OCR Engine**<br/>Select the OCR engine used for table text extraction. DocTR is optimized for document tables. EasyOCR and Surya are general-purpose alternatives. | `"doctr"` |

## Dependencies

- `img2table`
- `pillow`
- `numpy`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/ocr)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
