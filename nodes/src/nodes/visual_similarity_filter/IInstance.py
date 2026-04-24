# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Visual Similarity Filter — per-instance logic.

Text-first pipeline (validated at 91% accuracy vs image-comparison approach):

  1. Reference setup (once per pipeline run):
       - vlm-text       → use configured prompt directly as the description
       - vlm-image      → describe reference image via VLM → text description
       - vlm-image-text → describe reference image + append user text → combined

  2. Per-frame scoring:
       - YOLO pre-filter: if no vehicles detected → False (fast skip, no VLM call)
       - Full frame + text description → VLM → YES/NO

The reference image is only used to generate a text description.
Per-frame VLM calls always use the full frame + text — never image comparison.
This eliminates the studio→broadcast domain gap that hurt image-mode accuracy.
"""

import datetime

from rocketlib import IInstanceBase, AVI_ACTION, Entry

from .IGlobal import IGlobal
from .vlm_chat import VLMChat
from .embedder import detect_car_crops

_LOG = '/tmp/brandy_pipeline.log'

DESCRIBE_PROMPT = (
    'You are looking at a reference F1 race car. Describe it in one detailed sentence covering ALL of the following: '
    '1) the team or constructor name (e.g. Mercedes AMG, Ferrari, McLaren), '
    '2) the car number if visible, '
    '3) the primary body color and all secondary accent colors, '
    '4) any distinctive sponsor logos or markings you can identify (e.g. Petronas teal stripe, Shell livery, papaya orange). '
    'Be as specific as possible — this description will be used to identify this exact car in broadcast footage. '
    'Example: "Mercedes AMG F1, car #44, predominantly silver with black sidepods and a Petronas teal stripe on the nose and front wing".'
)

DEFAULT_TEXT_PROMPT = 'This is a broadcast F1 race frame. Does it contain an F1 race car? Reply YES or NO only.'


def _plog(msg: str) -> None:
    line = f'[{datetime.datetime.now().isoformat(timespec="milliseconds")}] [vsf          ] {msg}\n'
    with open(_LOG, 'a') as f:
        f.write(line)


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        cfg = self.IGlobal.config
        self._mode = cfg.get('type', 'vlm-image')
        self._ref_pattern = cfg.get('reference_filename_pattern', 'reference').lower()
        self._image_buf = bytearray()
        self._image_mime = 'image/jpeg'
        self._is_reference_entry = False
        _plog(f'beginInstance: mode={self._mode} model={cfg.get("model", "qwen2.5vl:7b")}')

    def endInstance(self):
        pass

    def open(self, obj: Entry):
        filename = (getattr(obj, 'name', '') or '').lower()
        self._is_reference_entry = bool(self._ref_pattern and self._ref_pattern in filename)
        self._image_buf = bytearray()
        if self._is_reference_entry:
            _plog(f'open: reference image detected: {filename!r}')

    def close(self):
        pass

    # ------------------------------------------------------------------
    # Image lane (reference image upload via dropper)
    # ------------------------------------------------------------------

    def writeImage(self, action: AVI_ACTION, mimeType: str, buffer: bytes = None):
        if action == AVI_ACTION.BEGIN:
            self._image_buf = bytearray()
            self._image_mime = mimeType
            self.preventDefault()
        elif action == AVI_ACTION.WRITE:
            if buffer:
                self._image_buf.extend(buffer)
            self.preventDefault()
        elif action == AVI_ACTION.END:
            img_bytes = bytes(self._image_buf)
            self._image_buf = bytearray()
            if self._is_reference_entry and self._mode != 'vlm-text':
                self._store_reference(img_bytes, mimeType)
            self.preventDefault()

    # ------------------------------------------------------------------
    # Control-plane invoke — called by clip_buffer per scan interval
    # ------------------------------------------------------------------

    def invoke(self, param) -> bool:
        frame_bytes = getattr(param, 'frame_bytes', None)
        if frame_bytes is None:
            _plog('invoke: param missing frame_bytes → False')
            return False

        cfg = self.IGlobal.config

        # ── Text-only mode: no reference image needed ──────────────────
        if self._mode == 'vlm-text':
            with self.IGlobal.device_lock:
                if self.IGlobal.ref_description is None:
                    prompt = cfg.get('prompt', '').strip() or DEFAULT_TEXT_PROMPT
                    self.IGlobal.ref_description = prompt
                    self.IGlobal.ref_ready.set()
                    _plog(f'invoke: text mode — prompt: {prompt!r:.100}')
            return self._score_frame(frame_bytes)

        # ── Image / image-text modes: first call stores reference ───────
        stored_now = False
        with self.IGlobal.device_lock:
            if self.IGlobal.ref_bytes is None:
                self.IGlobal.ref_bytes = frame_bytes
                self.IGlobal.ref_ready.set()
                _plog(f'invoke: reference stored ({len(frame_bytes)} bytes)')
                stored_now = True

        if stored_now:
            self._generate_ref_description()
            return False

        if not self.IGlobal.ref_ready.wait(timeout=30.0):
            _plog('invoke: reference not ready within 30s → False')
            return False

        return self._score_frame(frame_bytes)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _store_reference(self, image_bytes: bytes, mime: str):
        stored_now = False
        with self.IGlobal.device_lock:
            if self.IGlobal.ref_bytes is None:
                self.IGlobal.ref_bytes = image_bytes
                self.IGlobal.ref_mime = mime
                self.IGlobal.ref_ready.set()
                _plog(f'_store_reference: stored {len(image_bytes)} bytes via image lane')
                stored_now = True
            else:
                _plog('_store_reference: reference already set — ignoring duplicate')
        if stored_now:
            self._generate_ref_description()

    def _generate_ref_description(self):
        cfg = self.IGlobal.config
        custom_prompt = cfg.get('prompt', '').strip()
        model = cfg.get('model', 'qwen2.5vl:7b')
        url = cfg.get('ollama_url', 'http://localhost:11434')
        timeout = float(cfg.get('timeout', 30.0))
        chat = VLMChat(model, url, timeout)

        desc = chat.describe(DESCRIBE_PROMPT, images=[self.IGlobal.ref_bytes])
        if not desc:
            desc = 'an F1 race car'
            _plog('_generate_ref_description: VLM returned empty — using fallback')

        if self._mode == 'vlm-image-text' and custom_prompt:
            self.IGlobal.ref_description = f'{desc}. Additionally: {custom_prompt}'
        else:
            self.IGlobal.ref_description = desc

        _plog(f'ref_description: {self.IGlobal.ref_description!r:.120}')

    def _score_frame(self, frame_bytes: bytes) -> bool:
        """Stage 1 — YOLO cheap pre-filter, Stage 2 — full frame + text → VLM."""
        try:
            crops = detect_car_crops(frame_bytes)
            if not crops:
                _plog('_score_frame: YOLO found no vehicles → skip VLM')
                return False
            _plog(f'_score_frame: YOLO found {len(crops)} vehicle(s) → VLM')
        except Exception as e:
            _plog(f'_score_frame: YOLO failed ({e}) → proceeding to VLM without pre-filter')

        cfg = self.IGlobal.config
        ref_desc = self.IGlobal.ref_description or DEFAULT_TEXT_PROMPT
        model = cfg.get('model', 'qwen2.5vl:7b')
        url = cfg.get('ollama_url', 'http://localhost:11434')
        timeout = float(cfg.get('timeout', 30.0))
        chat = VLMChat(model, url, timeout)

        prompt = f'This is a broadcast F1 race frame — it may be slightly blurry and contain multiple cars, crowds, barriers, and track elements. Does this frame contain: {ref_desc}? Reply YES or NO only.'
        result = chat.ask(prompt, images=[frame_bytes])
        _plog(f'_score_frame: VLM → {result}')
        return result
