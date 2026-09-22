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


"""Local word alignment with a bounded speech-model cache."""

from __future__ import annotations
import threading
from pathlib import Path

_lock = threading.Lock()

_models: dict[str, object] = {}


def get_model(name: str = 'small'):
    """Retrieve or load a speech model, retaining at most one cached model at a time."""
    with _lock:
        model = _models.get(name)
        if model is None:
            from faster_whisper import WhisperModel

            _models.clear()
            model = WhisperModel(name, device='auto', compute_type='int8')
            _models[name] = model
        return model


ALIGN_VERSION = 3

ALIGN_RATE = 16000

ALIGN_CHANNELS = 1

MAX_WORD_MS = 1500  # no spoken word is longer; anything above is timing smear

SMEAR_PROB = 0.2  # ...and a long word with this little confidence is a hallucination

SMEAR_MS = 1200

VAD_PARAMETERS = {'min_silence_duration_ms': 300}


def sanitize_words(words: list[dict]) -> list[dict]:
    """
    Whisper stretches uncertain words across leading silence or music (a word
    "spanning" 8 s at probability 0.01), which threw captions out of sync for
    the first seconds of a piece. Rules: drop long near-zero-confidence words,
    cap a word's duration by pulling its START toward its end (ends line up
    with the next word and are the trustworthy edge), and never let a word
    overlap its successor.
    """
    out: list[dict] = []
    for w in words:
        start, end = int(w['start_ms']), int(w['end_ms'])
        if end <= start:
            continue
        prob = float(w.get('probability', 1.0) or 0.0)
        if end - start > SMEAR_MS and prob < SMEAR_PROB:
            continue
        if end - start > MAX_WORD_MS:
            start = end - MAX_WORD_MS
        # A prior interval cannot be shortened to a positive duration if the
        # next hypothesis starts at or before it (including millisecond rounding).
        while out and out[-1]['start_ms'] >= start:
            out.pop()
        if out and out[-1]['end_ms'] > start:
            out[-1]['end_ms'] = start
        out.append({**w, 'start_ms': start, 'end_ms': end})
    return out


def align_words(path: str | Path, model_name: str = 'small', language: str | None = 'en') -> dict:
    """Words with millisecond timings relative to the start of the given audio file."""
    model = get_model(model_name)
    with _lock:
        segments, info = model.transcribe(
            str(path),
            word_timestamps=True,
            # VAD keeps the model from timing words across leading/trailing
            # silence or music — the cause of out-of-sync opening captions
            vad_filter=True,
            vad_parameters=dict(VAD_PARAMETERS),
            language=language or None,
            condition_on_previous_text=False,
        )
        words, text = [], []
        for seg in segments:
            text.append(seg.text.strip())
            for w in seg.words or []:
                word = w.word.strip()
                if word:
                    words.append(
                        {
                            'word': word,
                            'start_ms': int(w.start * 1000),
                            'end_ms': int(w.end * 1000),
                            'probability': round(float(w.probability), 3),
                        }
                    )
    return {'language': info.language, 'words': sanitize_words(words), 'text': ' '.join(text)}
