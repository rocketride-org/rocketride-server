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


"""Typed media operation handlers."""

from __future__ import annotations
import json
import shutil
import tempfile
from pathlib import Path
from rocketlib import AVI_ACTION, debug
from ._support.instance import MediaInstance
from ._support import media as common_media
from . import media as media_lib
from .align import ALIGN_CHANNELS, ALIGN_RATE, ALIGN_VERSION, align_words
from .IGlobal import IGlobal

NODE = 'media_speech'
SCHEMA_VERSION = 1
MODELS = frozenset({'tiny', 'base', 'small', 'medium', 'large-v3'})


class IInstance(MediaInstance):
    """Stream bounded audio pieces or measure source-clock word timings."""

    IGlobal: IGlobal
    node = NODE
    modes = ('pieces', 'words')

    def _measure(self, mode, ctx, source, local, media):
        if mode == 'pieces':
            return self._pieces(ctx, source, local, media)
        return self._words(ctx, source, local, media)

    def _pieces(self, ctx: dict, source: str, local: Path, media: dict) -> dict:
        """The sound as fixed-length WAV pieces, one stream each, in stream order."""
        cfg = self.IGlobal.config
        if not self.instance.hasListener('audio'):
            raise ValueError('Connect an audio consumer for pieces output')
        if not media['has_audio']:
            raise ValueError(f'{NODE}: the file has no audio track')
        piece_seconds = media_lib.clamp_piece_seconds(ctx.get('piece_seconds') or cfg['piece_seconds'])
        skipped = media_lib.parse_ordinals(ctx.get('skip_pieces'))
        # a batch limit, not a budget: the pieces are still cut from the whole
        # recording (the grid has to be the same one every run), only the
        # STREAMING stops after `max_pieces`, and the reference says what is
        # left so the next run can pick it up
        limit = common_media.parse_count(ctx.get('max_pieces'))
        work = Path(tempfile.mkdtemp(prefix='media_speech_'))
        try:
            self._status('splitting', source=source, piece_seconds=piece_seconds, resumed=len(skipped))
            pieces = media_lib.split_audio(local, work, piece_seconds)
            streamed = [p for p in pieces if p['index'] not in skipped]
            if limit:
                streamed = streamed[:limit]
            ref = media_lib.build_reference(
                source=source,
                mode='pieces',
                media=media,
                kind=media_lib.PIECES_KIND,
                context=ctx,
                question=self._question,
                streamed=streamed,
                piece_seconds=piece_seconds,
                pieces_total=len(pieces),
                skipped=skipped,
            )
            self._feed_pieces(streamed, len(pieces), len(skipped), media, cfg['chunk_bytes'])
            self._emit_text(ref)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return ref

    def _feed_pieces(self, streamed: list[dict], total: int, resumed: int, media: dict, chunk_bytes: int) -> None:
        """One WAV piece per stream, in order — the stream index IS the piece's place in `pieces`."""
        if not self.instance.hasListener('audio'):
            raise ValueError('Connect an audio consumer for pieces output')
        self._status(
            'transcribing',
            piece=resumed,
            pieces=total,
            resumed=resumed,
            duration_ms=media['duration_ms'],
        )
        for n, piece in enumerate(streamed, start=1):
            self.instance.writeAudio(
                AVI_ACTION.BEGIN,
                'audio/wav',
                self._descriptor(
                    piece['index'], piece['offset_ms'], piece['duration_ms'], Path(piece['path']).stat().st_size
                ),
            )
            try:
                with open(piece['path'], 'rb') as f:
                    while True:
                        chunk = f.read(chunk_bytes)
                        if not chunk:
                            break
                        self.instance.writeAudio(AVI_ACTION.WRITE, 'audio/wav', chunk)
            finally:
                self.instance.writeAudio(AVI_ACTION.END, 'audio/wav', b'')
            # one small status write per piece: a watching client sees live
            # progress and a reloaded one can tell a slow run from a dead one
            self._status(
                'transcribing',
                piece=resumed + n,
                pieces=total,
                resumed=resumed,
                duration_ms=media['duration_ms'],
            )
        if not streamed:
            debug(f'{NODE}: every piece was skipped — nothing was streamed')

    def _descriptor(self, index: int, offset_ms: int, duration_ms: int, size: int) -> bytes:
        """Name every audio piece and declare its exact length and source offset."""
        from ai.common.avi.descriptor import audio_begin_payload

        payload = json.loads(
            audio_begin_payload(
                None,
                size=size,
                name=media_lib.piece_name(index),
                duration=duration_ms / 1000,
                sample_rate=media_lib.PIECE_RATE,
                channels=media_lib.PIECE_CHANNELS,
                format='wav',
                origin='extracted',
            )
        )
        payload.update(start_offset=offset_ms / 1000, piece=index, offset_ms=offset_ms)
        return json.dumps(payload).encode('utf-8')

    def _words(self, ctx: dict, source: str, local: Path, media: dict) -> dict:
        """
        Word-level timings for a range, on the SOURCE clock.

        The aligner is given no prompt: feeding it the text it is about to hear
        makes it treat that text as already-transcribed context and skip
        re-emitting the opening seconds (see `align.py`). What comes back is
        sanitized — a word "spanning" eight seconds at probability 0.01 is
        timing smear, not speech — and then shifted by the range's own start.

        The range is decoded at ALIGN_RATE mono — the encoding the analysis WAV
        has always had. It is not a saving: the model resamples to 16 kHz mono
        itself, but not before the wider band has changed what it hears (a
        48 kHz slice of one measured minute made it emit a word twice that the
        16 kHz one does not). `sample_rate:` lets a caller ask for another.
        """
        cfg = self.IGlobal.config
        span = common_media.parse_range(ctx.get('range')) or (0, int(media.get('duration_ms') or 0))
        if span[1] <= span[0]:
            raise ValueError(
                f'{NODE}: words requires a non-empty range; if source duration is unknown, supply range as start_ms-end_ms'
            )
        model = str(ctx.get('model') or cfg['model'] or 'small').strip()
        if model not in MODELS:
            raise ValueError(f'{NODE}: model must be one of {sorted(MODELS)}')
        language = str(ctx.get('language', cfg['language']) or '').strip() or None
        sample_rate = common_media.parse_count(ctx.get('sample_rate'), ALIGN_RATE) or ALIGN_RATE
        work = Path(tempfile.mkdtemp(prefix='media_speech_words_'))
        try:
            self._status(
                'aligning',
                source=source,
                start_ms=span[0],
                end_ms=span[1],
                seconds=round((span[1] - span[0]) / 1000, 1),
                model=model,
            )
            wav = common_media.slice_audio(
                local, span[0], span[1], work / 'range.wav', sample_rate=sample_rate, channels=ALIGN_CHANNELS
            )
            aligned = align_words(wav, model, language)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        words = [
            {
                'w': str(w.get('word') or ''),
                's': int(w['start_ms']) + span[0],
                'e': int(w['end_ms']) + span[0],
                'p': float(w.get('probability') or 0.0),
            }
            for w in aligned['words']
        ]
        manifest = {
            'schema_version': SCHEMA_VERSION,
            'kind': 'media_words',
            'mode': 'words',
            'source': source,
            'range': [span[0], span[1]],
            'model': model,
            'language': aligned.get('language') or language,
            'align_version': ALIGN_VERSION,
            'sample_rate': sample_rate,
            'words': words,
            'text': aligned.get('text') or '',
            'context': dict(ctx),
        }
        self._emit_text(manifest)
        self._status('aligned', words=len(words), start_ms=span[0], end_ms=span[1])
        return manifest
