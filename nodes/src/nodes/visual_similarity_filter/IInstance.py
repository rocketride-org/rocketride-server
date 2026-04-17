# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

from rocketlib import IInstanceBase, AVI_ACTION, Entry
from ai.common.table import Table

from .IGlobal import IGlobal

_LOG = '/tmp/brandy_pipeline.log'


def _plog(msg: str) -> None:
    import datetime

    line = f'[{datetime.datetime.now().isoformat(timespec="milliseconds")}] [vsf          ] {msg}\n'
    with open(_LOG, 'a') as f:
        f.write(line)


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        _plog(f'beginInstance: config={self.IGlobal.config}')
        self._frame_idx = 0
        self._matched = 0
        self._total = 0
        self._forwarded = 0
        self._match_rows = []
        self._image_buf = bytearray()
        self._image_mime = 'image/png'
        self._ref_buf = bytearray()
        self._ref_mime = 'image/png'
        self._is_reference_entry = False
        self._tracking = False
        self._prev_frame_bytes = None

        cfg = self.IGlobal.config
        self._fps = float(cfg.get('fps', 1.0))
        # Filename substring that identifies a reference image arriving on the image lane.
        # The server sends the reference image with filename "reference.jpg"; dropper users
        # should name their reference file accordingly (e.g. "reference_mercedes.jpg").
        self._reference_pattern = cfg.get('reference_filename_pattern', 'reference').lower()
        # Scene-aware tracking state
        self._tracking = False
        self._prev_frame_bytes = None
        # Grayscale MAD above this → scene cut detected, tracker resets (0 = disabled)
        self._scene_cut_threshold = float(cfg.get('scene_change_threshold', 0.15))
        # While tracking, similarity threshold is multiplied by this factor (more permissive)
        self._tracking_factor = float(cfg.get('tracking_threshold_factor', 0.6))

    def endInstance(self):
        pass

    def open(self, obj: Entry):
        _plog(f'open: name={getattr(obj, "name", "?")} type={type(obj).__name__} attrs={[a for a in dir(obj) if not a.startswith("_")]}')
        self._frame_idx = 0
        self._matched = 0
        self._total = 0
        self._forwarded = 0
        self._match_rows = []
        filename = (getattr(obj, 'name', '') or '').lower()
        self._is_reference_entry = bool(filename and self._reference_pattern and self._reference_pattern in filename)
        if self._is_reference_entry:
            _plog(f'open: reference image detected by filename: {filename!r}')

    def close(self):
        _plog(f'close: frame_idx={self._frame_idx} matched={self._matched}')
        if self.instance.hasListener('table') and self._match_rows:
            table = Table.generate_markdown_table(
                headers=['Frame', 'Time', 'Similarity'],
                data=self._match_rows,
            )
            self.instance.writeTable(table)
        # Send scores via SSE so clients can bootstrap better reference images.
        # Only sent for video files (not the reference image itself).
        if self._match_rows and not self._is_reference_entry:
            self.instance.sendSSE(
                'scores_table',
                matches=[{'frame': r[0], 'time': r[1], 'score': float(r[2])} for r in self._match_rows],
            )

    # ------------------------------------------------------------------
    # Reference image lane handling
    # ------------------------------------------------------------------

    def writeReference(self, action: AVI_ACTION, mimeType: str, buffer: bytes = None):
        _plog(f'writeReference: action={action} mime={mimeType}')
        if action == AVI_ACTION.BEGIN:
            self._ref_buf = bytearray()
            self._ref_mime = mimeType
            self.preventDefault()
        elif action == AVI_ACTION.WRITE:
            if buffer:
                self._ref_buf.extend(buffer)
            self.preventDefault()
        elif action == AVI_ACTION.END:
            self._set_reference(bytes(self._ref_buf))
            self._ref_buf = bytearray()
            self.preventDefault()

    def _set_reference(self, image_bytes: bytes):
        _plog(f'_set_reference: called, image_bytes={len(image_bytes)}')
        try:
            # YOLO car-crop: use highest-confidence detection on the reference image.
            # Falls back to full image if YOLO unavailable or no car detected.
            try:
                from .embedder import detect_car_crops

                crops = detect_car_crops(image_bytes)
                if crops:
                    image_bytes = crops[0]  # highest-confidence crop
                    _plog(f'_set_reference: YOLO crop done, {len(image_bytes)} bytes')
                else:
                    _plog('_set_reference: YOLO found no car — using original image')
            except Exception as yolo_err:
                _plog(f'_set_reference: YOLO crop skipped ({yolo_err}), using original image')

            embedder = self.IGlobal.embedder
            # Use multi-crop global embeddings for all models — _score_frame uses global cosine
            crops = embedder.embed_multicrop(image_bytes)
            _plog(f'_set_reference: embed_multicrop done, {len(crops)} crops')
            with self.IGlobal.device_lock:
                # Accumulate across multiple reference images — don't overwrite.
                # score = max cosine over ALL crops from ALL reference images.
                existing = self.IGlobal.reference_embeddings or []
                self.IGlobal.reference_embeddings = existing + crops
                self.IGlobal.reference_patches = None
            total = len(self.IGlobal.reference_embeddings)
            _plog(f'_set_reference: COMPLETE — {len(crops)} new crops, {total} total across all refs')
        except Exception as e:
            import traceback

            _plog(f'_set_reference: FATAL: {e}\n{traceback.format_exc()}')
        finally:
            # Always unblock waiting frames — if embed failed, frames will score 0
            self.IGlobal.reference_ready.set()

    # ------------------------------------------------------------------
    # Image stream handling
    # ------------------------------------------------------------------

    def writeImage(self, action: AVI_ACTION, mimeType: str, buffer: bytes):
        _plog(f'writeImage: action={action} mime={mimeType} is_ref={self._is_reference_entry}')
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
            _plog(f'writeImage END: is_reference={self._is_reference_entry} bytes={len(img_bytes)}')
            if self._is_reference_entry:
                # Filename matched reference_filename_pattern — set as reference embedding.
                self._set_reference(img_bytes)
            else:
                self._on_frame_complete(img_bytes, self._image_mime)
            self.preventDefault()

    # ------------------------------------------------------------------
    # Control-plane invoke (called by clip_buffer)
    # ------------------------------------------------------------------

    def invoke(self, frame_bytes: bytes) -> bool:
        # Clip Buffer sends the reference image as the very first invoke() call.
        # If no reference is set yet, treat this frame as the reference.
        if not self.IGlobal.reference_embeddings:
            _plog('invoke: no reference set — treating first frame as reference')
            self._set_reference(frame_bytes)
            return False
        matched, similarity = self._score_frame_with_yolo(frame_bytes)
        _plog(f'invoke: matched={matched} similarity={similarity:.4f}')
        return matched

    # ------------------------------------------------------------------
    # YOLO-assisted scoring — detect vehicles, score each crop
    # ------------------------------------------------------------------

    def _score_frame_with_yolo(self, image_bytes: bytes) -> tuple:
        """Detect vehicles with YOLOv8 nano, embed each crop, return best score.

        Flow:
          1. YOLO detects all vehicles in the frame.
          2. No vehicles found → return False immediately (kills pit shots, crowd shots).
          3. Each vehicle crop is embedded with SigLIP and scored against the reference.
          4. Return the highest-scoring crop's result.

        Falls back to full-frame _score_frame() if YOLO is unavailable.
        """
        import numpy as np

        if not self.IGlobal.reference_ready.wait(timeout=300.0):
            _plog('_score_frame_with_yolo: reference not ready, dropping frame')
            return False, 0.0

        # Step 1: detect vehicles
        try:
            from .embedder import detect_car_crops

            car_crops = detect_car_crops(image_bytes)
            _plog(f'_score_frame_with_yolo: YOLO detected {len(car_crops)} vehicle(s)')
        except Exception as e:
            _plog(f'_score_frame_with_yolo: YOLO unavailable ({e}), falling back to full frame')
            return self._score_frame(image_bytes)

        # Step 2: no vehicles → instant reject
        if not car_crops:
            _plog('_score_frame_with_yolo: no vehicles detected → False')
            return False, 0.0

        # Step 3: score each crop, take the best
        threshold = self.IGlobal.embedder.similarity_threshold
        best_score = 0.0

        with self.IGlobal.device_lock:
            crop_embs = self.IGlobal.reference_embeddings
            if not crop_embs:
                return False, 0.0

            n_refs = max(1, len(crop_embs) // self._CROPS_PER_REF)
            for car_bytes in car_crops:
                try:
                    car_emb = self.IGlobal.embedder.embed(car_bytes)
                    ref_scores = []
                    for i in range(n_refs):
                        group = crop_embs[i * self._CROPS_PER_REF : (i + 1) * self._CROPS_PER_REF]
                        ref_scores.append(max(float(np.dot(c, car_emb)) for c in group))
                    score = float(np.mean(ref_scores))
                    best_score = max(best_score, score)
                except Exception as e:
                    _plog(f'_score_frame_with_yolo: embed error for crop: {e}')

        matched = best_score >= threshold
        _plog(f'_score_frame_with_yolo: {len(car_crops)} crop(s), best={best_score:.4f} thresh={threshold:.4f} matched={matched}')
        return matched, best_score

    # ------------------------------------------------------------------
    # Per-frame similarity + ring buffer forwarding
    # ------------------------------------------------------------------

    # Number of top reference patches used for the patch-match score.
    # Higher K = more robust to partial occlusion; lower K = more selective.
    _PATCH_TOP_K = 20
    _CROPS_PER_REF = 6  # embed_multicrop always returns exactly 6 crops per image

    def _score_frame(self, image_bytes: bytes) -> tuple:
        """Score a frame against the reference car.

        Scoring strategy:
          - Crops are stored in groups of _CROPS_PER_REF (one group per reference image).
          - For each reference image: per_ref_score = max cosine across its 6 crops.
            This preserves the multi-crop benefit (best crop wins) without inflating
            the score when many reference images are present.
          - Final score = mean of all per-reference scores.
            A frame must match consistently across MULTIPLE references, not just
            spike against one lucky crop — crucial for multi-reference accuracy.

        With a single reference (6 crops): mean([max_of_6]) = max_of_6 → identical
        to the original behaviour, so single-ref thresholds are unchanged.

        Returns (matched: bool, score: float).
        """
        import numpy as np

        if not self.IGlobal.reference_ready.wait(timeout=300.0):
            _plog('_score_frame: not ready within timeout, dropping frame')
            return False, 0.0

        threshold = self.IGlobal.embedder.similarity_threshold

        with self.IGlobal.device_lock:
            crop_embs = self.IGlobal.reference_embeddings
            if not crop_embs:
                _plog('_score_frame: no reference embeddings, dropping frame')
                return False, 0.0
            try:
                frame_emb = self.IGlobal.embedder.embed(image_bytes)
                n_refs = max(1, len(crop_embs) // self._CROPS_PER_REF)
                ref_scores = []
                for i in range(n_refs):
                    group = crop_embs[i * self._CROPS_PER_REF : (i + 1) * self._CROPS_PER_REF]
                    ref_scores.append(max(float(np.dot(c, frame_emb)) for c in group))
                score = float(np.mean(ref_scores))
                matched = score >= threshold
                _plog(f'_score_frame: mean-of-{n_refs}-ref-max={score:.4f} threshold={threshold:.4f} matched={matched}')
            except Exception as e:
                _plog(f'_score_frame: cosine error {e}')
                return False, 0.0

        return matched, score

    def _on_frame_complete(self, image_bytes: bytes, mime: str):
        idx = self._frame_idx
        self._frame_idx += 1
        self._total += 1
        timestamp = idx / self._fps if self._fps > 0 else float(idx)

        # Scene cut detection — resets tracker so next frame requires full semantic check
        if self._scene_cut_threshold > 0:
            scene_score = self._compute_scene_score(image_bytes)
            if scene_score > self._scene_cut_threshold:
                _plog(f'_on_frame_complete: scene cut idx={idx} scene_score={scene_score:.3f} → tracking reset')
                self._tracking = False

        # Always get the raw similarity score (YOLO-assisted)
        _, similarity = self._score_frame_with_yolo(image_bytes)

        # Tracking-aware threshold: once Mercedes is confirmed in a scene, be more
        # permissive so small/blurry/departing cars are still forwarded.
        if self._tracking:
            effective_threshold = self.IGlobal.embedder.similarity_threshold * self._tracking_factor
        else:
            effective_threshold = self.IGlobal.embedder.similarity_threshold
        matched = similarity >= effective_threshold

        _plog(f'_on_frame_complete: idx={idx} sim={similarity:.4f} thresh={effective_threshold:.4f} tracking={self._tracking} matched={matched}')

        if matched:
            self._tracking = True
            self._matched += 1
            self._match_rows.append([idx, self._fmt_time(timestamp), f'{similarity:.3f}'])
            self._forward_frame(image_bytes, mime)
        elif self._tracking:
            # Car has left the scene — stop tracking
            _plog(f'_on_frame_complete: car left scene at idx={idx}, stopping tracker')
            self._tracking = False

        self._prev_frame_bytes = image_bytes

    def _compute_scene_score(self, image_bytes: bytes) -> float:
        """Grayscale mean-abs-diff vs the previous frame (0.0–1.0).

        Mirrors the same formula used by frame_grabber's documents lane.
        Returns 0.0 if there is no previous frame.
        """
        if self._prev_frame_bytes is None:
            return 0.0
        import io
        import numpy as np
        from PIL import Image

        a = np.array(Image.open(io.BytesIO(self._prev_frame_bytes)).convert('L'), dtype=np.float32)
        b = np.array(Image.open(io.BytesIO(image_bytes)).convert('L'), dtype=np.float32)
        return float(np.mean(np.abs(a - b))) / 255.0

    def _forward_frame(self, image_bytes: bytes, mime: str):
        if self.instance.hasListener('image'):
            self.instance.writeImage(AVI_ACTION.BEGIN, mime)
            self.instance.writeImage(AVI_ACTION.WRITE, mime, image_bytes)
            self.instance.writeImage(AVI_ACTION.END, mime)
            self._forwarded += 1

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _fmt_time(seconds: float) -> str:
        h = int(seconds // 3600)
        m = int((seconds % 3600) // 60)
        s = seconds % 60
        return f'{h:02}:{m:02}:{s:05.2f}'
