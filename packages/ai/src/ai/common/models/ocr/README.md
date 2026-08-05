# `ai.common.models.ocr`

Loaders and user-facing classes for the four supported OCR engines:

| Engine  | Loader            | User class | Requirements file          |
| ------- | ----------------- | ---------- | -------------------------- |
| EasyOCR | `EasyOCRLoader`   | `EasyOCR`  | `requirements_easyocr.txt` |
| DocTR   | `DocTRLoader`     | `DocTR`    | `requirements_doctr.txt`   |
| Surya   | `SuryaLoader`     | `Surya`    | `requirements_surya.txt`   |
| TrOCR   | `TrOCRLoader`     | `TrOCR`    | `requirements_trocr.txt`   |

Each loader exposes `load / preprocess / inference / postprocess` for use by the model server and local-mode connectors. Each user class auto-detects model-server mode via `get_model_server_address()` and falls back to local execution otherwise.

## OpenCV compatibility

All four engines share the `cv2` namespace but disagree on which OpenCV PyPI package and version they want. The project installs a single unified build, `opencv-contrib-python==4.13.0.92`, via `ai.common.opencv`, which also uninstalls competing variants (`opencv-python`, `opencv-python-headless`, `opencv-contrib-python-headless`) so only one `cv2` is active at runtime.

Upstream pins (as of the versions currently used):

| Engine  | PyPI package                               | Upstream OpenCV requirement           | Matches project's 4.13.0.92? |
| ------- | ------------------------------------------ | ------------------------------------- | ---------------------------- |
| EasyOCR | `easyocr` 1.7.2                            | `opencv-python-headless` (unpinned)   | Yes                          |
| DocTR   | `python-doctr` 1.0.1                       | `opencv-python <5.0.0, >=4.5.0`       | Yes                          |
| Surya   | `surya-ocr` 0.17.1                         | `opencv-python-headless==4.11.0.86`   | No: hard pin to 4.11.0.86    |
| TrOCR   | `craft-text-detector` 0.4.3 (detector dep) | `opencv-python <4.5.4.62, >=3.4.8.29` | No: caps below 4.5.4.62      |

Surya and TrOCR's detector pin OpenCV to versions the project deliberately overrides. They work because `ai.common.opencv` runs `depends()` at import time and force-aligns all four OpenCV variants to 4.13.0.92 _after_ the engines are installed.

**Loader convention:** every loader imports `from ai.common.opencv import cv2` (see `doctr.py`, `easyocr.py`, `surya.py`, `trocr.py`) _before_ touching the engine's own imports. This guarantees the project's `cv2` is resolved first and any conflicting variant pulled in transitively is uninstalled by the shim. When adding a new loader, follow the same pattern.

## Upstream docs

- [EasyOCR](https://github.com/JaidedAI/EasyOCR)
- [DocTR documentation](https://mindee.github.io/doctr/)
- [Surya](https://github.com/VikParuchuri/surya)
- [craft-text-detector (TrOCR detector)](https://github.com/fcakyon/craft-text-detector)
