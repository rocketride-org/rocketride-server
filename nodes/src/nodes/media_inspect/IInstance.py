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
import shutil
import tempfile
from pathlib import Path
from rocketlib import AVI_ACTION, warning, debug
from ._support.instance import MediaInstance
from ._support import media as common_media
from ._support.config import as_bool
from . import levels as levels_lib
from . import media as media_lib
from .IGlobal import IGlobal

NODE = 'media_inspect'
SCHEMA_VERSION = 1


class IInstance(MediaInstance):
    """Measure a recording or extract caller-selected pictures."""

    IGlobal: IGlobal
    node = NODE
    modes = ('probe', 'levels', 'stills')

    def _measure(self, mode, ctx, source, local, media):
        if mode == 'probe':
            result = {
                'schema_version': 1,
                'kind': 'media_probe',
                'mode': mode,
                **common_media.probe_payload(media, source),
                'context': dict(ctx),
            }
            self._emit_text(result)
            return result
        operation = self._levels if mode == 'levels' else self._stills
        return operation(ctx, source, local, media)

    def _stills(self, ctx: dict, source: str, local: Path, media: dict) -> dict:
        """Stream selected JPEGs; report each invalid request without losing valid images."""
        entries = media_lib.parse_stills(ctx.get('stills'))
        if not entries:
            raise ValueError(f'{NODE}: stills needs a non-empty stills array')
        if not self._image_listener():
            raise ValueError('Connect an image sink for extracted stills')
        quality = common_media.parse_count(ctx.get('quality'), media_lib.STILL_QUALITY) or media_lib.STILL_QUALITY
        quality = max(2, min(31, quality))
        files, failed, streamed = {}, [], []
        self._status('stills', source=source, stills=len(entries))
        for index, row in enumerate(entries):
            name = row.get('id') if isinstance(row, dict) else None
            label = name.strip() if isinstance(name, str) and name.strip() else f'#{index}'
            try:
                if not media.get('has_video'):
                    raise ValueError('The file has no video track')
                label, at_ms, crop, width = media_lib.still_entry(row)
                data = media_lib.cut_still(local, at_ms, crop, media=media, width=width, quality=quality)
            except Exception as exc:  # noqa: BLE001 — one invalid still does not discard others
                warning(f'{NODE}: no still for {label}: {exc}')
                failed.append(label)
                continue
            self._stream_picture(f'{label}.jpg', data)
            files[label] = f'{label}.jpg'
            streamed.append(label)
        result = {
            'schema_version': SCHEMA_VERSION,
            'kind': media_lib.STILLS_KIND,
            'mode': 'stills',
            'source': source,
            'files': files,
            'failed': failed,
            'streamed': streamed,
            'context': dict(ctx),
        }
        self._emit_text(result)
        self._status('stills_done', files=len(files), failed=len(failed))
        return result

    def _image_listener(self) -> bool:
        """Is anything reading the image lane? A stream nobody reads is not sent."""
        if self.instance.hasListener('image'):
            return True
        warning(f'{NODE}: no image listener wired — the pictures were not streamed')
        return False

    def _stream_picture(self, name: str, data: bytes) -> None:
        """
        One picture on the image lane, under its own name, marked on the text
        lane first.

        The marker is what survives. A filter's image streams are not objects:
        a response node collects everything one run wrote into ONE text buffer
        under the INPUT object's name, so the descriptor's name — which the
        image lane does keep — never reaches a caller reading text. Writing the
        name on the text lane immediately before the picture puts it in that
        buffer directly in front of whatever the node behind this one says
        about the picture, because a write is propagated all the way down the
        pipe before the next one starts.

        One stream per picture is what every image node expects (the stock
        frame grabber emits frames the same way), so a consumer sees N images
        rather than one N-frame stream. The BEGIN carries the enrichment when
        the engine's descriptor helpers are importable and an empty payload
        when they are not.
        """
        self._emit_text_line(name)
        try:
            from ai.common.avi.descriptor import image_begin_payload, image_dims

            width, height = image_dims(data)
            payload = image_begin_payload(
                None, size=len(data), width=width, height=height, name=name, origin='extracted'
            )
        except Exception as exc:  # noqa: BLE001
            debug(f'{NODE}: no image descriptor for {name}: {exc}')
            payload = b''
        mime = 'image/jpeg'
        chunk_bytes = self.IGlobal.config['chunk_bytes']
        self.instance.writeImage(AVI_ACTION.BEGIN, mime, payload)
        try:
            for at in range(0, len(data), chunk_bytes):
                self.instance.writeImage(AVI_ACTION.WRITE, mime, data[at : at + chunk_bytes])
        finally:
            self.instance.writeImage(AVI_ACTION.END, mime, b'')

    def _levels(self, ctx: dict, source: str, local: Path, media: dict) -> dict:
        """
        Silences, RMS peaks and shot changes over a range, on the SOURCE clock,
        and the RMS level of any window named in `ranges:`.

        The three scans read the whole range once; `ranges:` decodes only the
        windows it is given. A caller that wants nothing but those windows says
        `scan: no` and pays for neither the level pass nor the scene detector —
        which on a long recording is the difference between a second and a
        minute per ten minutes of picture.
        """
        cfg = self.IGlobal.config
        span = common_media.parse_range(ctx.get('range')) or (0, int(media.get('duration_ms') or 0))
        windows = common_media.parse_ranges(ctx.get('ranges'))
        wanted = as_bool(ctx.get('scan'), True)
        work = Path(tempfile.mkdtemp(prefix='media_inspect_levels_'))
        try:
            self._status(
                'scanning',
                source=source,
                start_ms=span[0],
                end_ms=span[1],
                scan=wanted,
                ranges=len(windows),
            )
            scan = levels_lib.scan_levels(
                local,
                work,
                start_ms=span[0],
                end_ms=span[1],
                silence_db=float(ctx.get('silence_db') or cfg['silence_db']),
                silence_ms=int(float(ctx.get('silence_ms') or cfg['silence_ms'])),
                peak_ms=int(float(ctx.get('peak_ms') or cfg['peak_ms'])),
                scene_threshold=float(ctx.get('scene_threshold') or cfg['scene_threshold']),
                has_video=bool(media.get('has_video')),
                has_audio=bool(media.get('has_audio')),
                scan=wanted,
                scan_scenes=as_bool(ctx.get('scan_scenes'), True),
            )
            if windows:
                scan['ranges'] = (
                    levels_lib.measure_ranges(local, windows)
                    if media.get('has_audio')
                    else [{'start': a, 'end': b, 'rms_db': None} for a, b in windows]
                )
        finally:
            shutil.rmtree(work, ignore_errors=True)
        manifest = {
            'schema_version': SCHEMA_VERSION,
            'kind': 'media_levels',
            'mode': 'levels',
            'source': source,
            **scan,
            'context': dict(ctx),
        }
        self._emit_text(manifest)
        self._status(
            'scanned',
            silences=len(scan['silences']),
            peaks=len(scan['peaks']),
            scenes=len(scan['scenes']),
            ranges=len(scan.get('ranges') or []),
        )
        return manifest
