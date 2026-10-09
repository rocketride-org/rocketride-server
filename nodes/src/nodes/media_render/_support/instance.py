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

"""Bounded stream input and object-local processing for a media node."""

from __future__ import annotations
import copy
import json
import mimetypes
from pathlib import Path
from decimal import Decimal, InvalidOperation
import time
from rocketlib import AVI_ACTION, IInstanceBase, debug, warning
from rocketlib.engine import monitorSSE
from ai.common.schema import Answer
from ai.common.avi.descriptor import audio_begin_payload, video_begin_payload, image_begin_payload
from ..plan import choose_pipeline, normalize_outputs
from .config import LEGACY_DESTINATIONS, parse_request
from .paths import emitted_name
from .workspace import Workspace, write_file

MEDIA_MIMES = {
    'mp4': 'video/mp4',
    'mov': 'video/quicktime',
    'mkv': 'video/x-matroska',
    'webm': 'video/webm',
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'm4a': 'audio/mp4',
    'aac': 'audio/aac',
    'flac': 'audio/flac',
}

# What a render writes beside its media: the poster frame and the text
# sidecars. Named here so the lane a file takes, and the MIME it is reported
# with, are the same on every host — `.srt` is `application/x-subrip` to one
# `mimetypes` registry and unknown to the next.
OUTPUT_MIMES = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'srt': 'application/x-subrip',
    'vtt': 'text/vtt',
    'txt': 'text/plain',
    'json': 'application/json',
}

MEDIA_LANES = ('video', 'audio', 'image')

ARTICLES = {'video': 'a', 'audio': 'an', 'image': 'an'}

__all__ = ['LEGACY_DESTINATIONS', 'MEDIA_MIMES', 'MediaInstance', 'OUTPUT_MIMES', 'stream_descriptor']


def stream_descriptor(payload) -> dict:
    """
    The stream's own fields from a BEGIN payload. The engine builds the
    descriptor as `{"type": "VideoStream", "metadata": {...}}` with the
    stream's name, size and source under `metadata` (`stream_descriptor.hpp`,
    `buildStreamDescriptor`); a producer that bypasses it may write the same
    fields flat. Both are read, `metadata` first. A payload that is not JSON,
    or not an object, is no descriptor at all — the canonical parser
    (`descriptor_from_payload`) never raises on one, and neither does this.
    """
    if not payload:
        return {}
    try:
        data = json.loads(bytes(payload).decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    metadata = data.get('metadata')
    return {**data, **metadata} if isinstance(metadata, dict) else data


class MediaInstance(IInstanceBase):
    """Own temporary files until closing; downstream nodes own persistence."""

    node = 'media'
    modes = ()

    def open(self, obj):
        """Admit the incoming object — refuse what cannot run before a byte is taken — and set up its scratch state."""
        self.close()
        self._workspace = None
        self._active = {}
        self._inputs = {}
        self._input_bytes = 0
        self._input_limit = self.IGlobal.config.get('max_input_bytes', 16 * 1024**3)
        self._assets = []
        self._warnings = []
        self._handled = True  # nothing to process until the object is admitted below
        self._t0 = time.time()
        self._entry_name = Path(str(getattr(obj, 'name', '') or 'source.media')).name
        self._ctx = {}
        self._question = ''
        self._spec = None
        self._render_outputs = []
        # The request, and the sinks it needs, are the same for every object.
        # One they cannot serve is refused here, not after its input was spooled.
        self._job = self._request()
        self._require_listeners(self._job[0])
        self._workspace = Workspace()
        self._handled = False

    def _request(self):
        """The static request and its mode: parsed once by IGlobal.beginGlobal, or here when no global was started."""
        parsed = getattr(self.IGlobal, 'request', None)
        if isinstance(parsed, dict):
            return copy.deepcopy(parsed), self.IGlobal.mode
        return parse_request(self.IGlobal.config.get('request'), self.modes)

    def _require_listeners(self, request):
        """
        Every lane this render will emit on needs a sink, and the manifest a
        consumer, before the object is admitted: an object that finds out at
        the end of its render has spent the whole render finding out.
        """
        if not (self.instance.hasListener('answers') or self.instance.hasListener('text')):
            raise ValueError('Connect a text or answers consumer for the result manifest')
        for lane, purpose in self._required_lanes(request.get('spec') or {}).items():
            if not self.instance.hasListener(lane):
                raise ValueError(f'Connect {ARTICLES[lane]} {lane} sink for {purpose}')

    def _required_lanes(self, spec) -> dict:
        """
        The media lanes the spec's deliverables will take, each with what it
        is for: video or audio per normalized output, and image for the poster
        frame — which a clip renders unless `thumbnail` says otherwise. The
        poster comes off a video deliverable, so audio-only outputs never need
        the image lane even when the source has a picture.
        """
        media = spec.get('media') if isinstance(spec.get('media'), dict) else {}
        has_video = bool(media.get('has_video', True))
        outputs = normalize_outputs(spec, self.IGlobal.config, has_video)
        lanes = {}
        for output in outputs:
            lane = 'video' if output['video'] else 'audio'
            lanes.setdefault(lane, f'rendered output {output["key"]!r} ({output["file"]})')
        clip = choose_pipeline(spec) == 'clip'
        poster = bool(spec['thumbnail']) if 'thumbnail' in spec else clip
        if poster and any(o['video'] for o in outputs):
            lanes.setdefault('image', 'the thumbnail, or set spec.thumbnail to false')
        return lanes

    def writeVideo(self, action, mime, data):
        """Consume a video BEGIN, WRITE or END action and its MIME/data payload."""
        self._receive('video', action, mime, data)
        return self.preventDefault()

    def writeAudio(self, action, mime, data):
        """Consume an audio BEGIN, WRITE or END action and its MIME/data payload."""
        self._receive('audio', action, mime, data)
        return self.preventDefault()

    def writeImage(self, action, mime, data):
        """Consume an image BEGIN, WRITE or END action and its MIME/data payload."""
        self._receive('image', action, mime, data)
        return self.preventDefault()

    def _receive(self, lane, action, mime, data):
        if action == AVI_ACTION.BEGIN:
            if lane in self._active:
                self._active.pop(lane)['file'].close()
                raise ValueError('Previous media stream did not finish')
            descriptor = stream_descriptor(data)
            name = descriptor.get('name') or descriptor.get('resource_name') or self._entry_name
            if name in self._inputs or any(item['name'] == name for item in self._active.values()):
                raise ValueError('Duplicate input stream name: ' + str(name))
            if len(self._inputs) + len(self._active) >= 128:
                raise ValueError('At most 128 input streams are supported per object')
            if isinstance(name, str) and name.split('/')[0] == 'outputs':
                raise ValueError('Input name uses the reserved outputs directory')
            path = self._workspace.resolve(name)
            # The declared size is advisory: for a stream extracted from a
            # container the engine falls back to the container's own size
            # (`stream_descriptor.hpp`). It is enough to refuse what could
            # never fit the budget; it is not enough to fail a stream over.
            expected = descriptor.get('size')
            if expected is not None:
                try:
                    if isinstance(expected, bool) or not isinstance(expected, (int, float, str)):
                        raise ValueError
                    expected = Decimal(str(expected))
                    if not expected.is_finite() or expected < 0 or expected != expected.to_integral_value():
                        raise ValueError
                except (InvalidOperation, ValueError):
                    expected = None
                    self._warn(f'Stream {name!r} has an invalid advisory size; the bytes received will be used.')
            if expected is not None and expected > self._input_limit - self._input_bytes:
                raise ValueError('Media input exceeds the configured max_input_mb limit')
            expected = int(expected) if expected is not None else None
            path.parent.mkdir(parents=True, exist_ok=True)
            self._active[lane] = {
                'file': path.open('xb'),
                'name': name,
                'size': expected,
                'received': 0,
                'lane': lane,
                'mime': mime,
            }
        elif action in (AVI_ACTION.WRITE, AVI_ACTION.END):
            if lane not in self._active:
                raise ValueError('Media bytes/end received without BEGIN')
            item = self._active[lane]
            if action == AVI_ACTION.WRITE:
                if len(data) > self._input_limit - self._input_bytes:
                    raise ValueError('Media input exceeds the configured max_input_mb limit')
                item['file'].write(data)
                item['received'] += len(data)
                self._input_bytes += len(data)
            else:
                item['file'].close()
                del self._active[lane]
                if not item['received']:
                    raise ValueError('Empty media stream: ' + str(item['name']))
                if item['size'] is not None and item['received'] != item['size']:
                    self._warn(
                        f'Stream {item["name"]!r} declared {item["size"]} bytes and delivered {item["received"]}; '
                        'the declared size is advisory and the bytes received were used.'
                    )
                self._inputs[item['name']] = item

    def _warn(self, note):
        """Something worth telling the caller that did not stop the render; it reaches the report's `warnings`."""
        self._warnings.append(note)
        warning(f'{self.node}: {note}')

    def _settle_lanes(self):
        """
        Deliver the END a producer never sent for a stream that arrived whole.
        The base class does this from its `close()` wrapper, but the engine
        calls `closing()` first (`pipe.instance.cpp`: `Parent::closing()`,
        then `Parent::close()`), and `closing()` is where this node renders,
        so it has to happen here to count. The base's own rule applies: only a
        stream whose bytes match its declared size is ended; anything else is
        reported and left open, and `closing()` fails the object for it.
        """
        settle = getattr(self, '_avi_settle_lanes', None)
        if callable(settle) and getattr(self, '_avi_lanes', None):
            settle()

    def closing(self):
        """Process completed input streams and release all object-local scratch files."""
        if getattr(self, '_handled', False):
            return
        self._handled = True
        try:
            self._settle_lanes()
            if self._active:
                raise ValueError('An input media stream did not finish')
            request, mode = self._job
            if not self._inputs:
                raise ValueError('No media stream received')
            requested = request.get('input_name')
            requested = self._source_name(request, requested)
            sources = [name for name, item in self._inputs.items() if item['lane'] in ('video', 'audio')]
            if requested:
                source = requested
            elif len(sources) == 1:
                source = sources[0]
            else:
                raise ValueError('Multiple media streams require input_name or spec.source')
            if source not in sources:
                raise ValueError('Requested source was not received as an audio/video stream')
            self._ctx = {
                k: json.dumps(v) if isinstance(v, (dict, list)) else str(v) for k, v in request.items() if v is not None
            }
            self._ctx.update(mode=mode, source=source)
            self._process(request, mode, source)
        except Exception as exc:
            self._status(None, None, 'error', message=str(exc))
            raise
        finally:
            self.close()

    def _source_name(self, request, requested):
        spec = request.get('spec')
        if not isinstance(spec, dict):
            raise ValueError('Render requires a spec JSON object')
        return requested or spec.get('source')

    def _process(self, request, mode, source):
        spec = copy.deepcopy(request.get('spec'))
        if not isinstance(spec, dict):
            raise ValueError('Render requires a spec JSON object')
        if LEGACY_DESTINATIONS.intersection(spec):
            raise ValueError('Render destinations are unsupported; connect a downstream sink')
        spec.update(source=source, write_to='outputs')
        if self._warnings:
            # what the input stage noticed travels with the render: the report's
            # `warnings` is seeded from the spec's own (`spec_hash` ignores them)
            carried = spec.get('warnings') if isinstance(spec.get('warnings'), list) else []
            spec['warnings'] = [*carried, *self._warnings]
        self._spec = spec
        report = self._render(self._workspace)
        paths = sorted(path for path in (self._workspace.root / 'outputs').rglob('*') if path.is_file())
        for path in paths:
            lane, _ = self._output_type(path)
            if lane in MEDIA_LANES and not self.instance.hasListener(lane):
                raise ValueError(f'Connect {ARTICLES[lane]} {lane} sink for rendered output')
        artifacts = [self._stream_file(path) for path in paths]
        # These are emitted names, never account paths or signed URLs.
        report['files'] = {key: emitted_name(value) for key, value in report.get('files', {}).items()}
        report['artifacts'] = artifacts
        report['storage'] = 'downstream'
        self._emit(report)

    def _output_type(self, path):
        name = path.relative_to(self._workspace.root / 'outputs').as_posix()
        for output in self._render_outputs:
            if output['file'] == name:
                return ('video' if output['video'] else 'audio'), MEDIA_MIMES[output['container']]
        suffix = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
        mime = OUTPUT_MIMES.get(suffix) or MEDIA_MIMES.get(suffix) or mimetypes.guess_type(name)[0]
        mime = mime or 'application/octet-stream'
        return mime.split('/')[0], mime

    def _stream_file(self, path):
        name = path.relative_to(self._workspace.root / 'outputs').as_posix()
        lane, mime = self._output_type(path)
        record = {'name': name, 'mime': mime, 'size': path.stat().st_size}
        if lane in MEDIA_LANES:
            emit = getattr(self.instance, 'write' + lane.title())
            payload = {'video': video_begin_payload, 'audio': audio_begin_payload, 'image': image_begin_payload}[lane]
            emit(AVI_ACTION.BEGIN, mime, payload(None, size=record['size'], name=name))
            with path.open('rb') as stream:
                while chunk := stream.read(self.IGlobal.config['chunk_bytes']):
                    emit(AVI_ACTION.WRITE, mime, chunk)
            emit(AVI_ACTION.END, mime, b'')
        else:
            # A text lane has no per-file name. Preserve sidecar names and MIME
            # alongside their UTF-8 content in the result manifest instead.
            record['text'] = path.read_text(encoding='utf-8')
        return record

    def _put(self, workspace, name, local):
        return write_file(workspace, name, local)

    def _status_to(self, spec=None):
        return None

    def _status(self, workspace, destination, stage, **data):
        pipe = getattr(self.instance, 'pipeId', None)
        if pipe is not None:
            try:
                monitorSSE(
                    pipe,
                    self.IGlobal.config.get('event_type', self.node),
                    {'schema_version': 1, 'node': self.node, 'stage': stage, **data},
                )
            except Exception as exc:  # noqa: BLE001 — progress cannot invalidate media output
                debug(f'{self.node}: progress delivery failed: {exc}')

    def _answer(self, payload):
        if self.instance.hasListener('answers'):
            answer = Answer(expectJson=True)
            answer.setAnswer(payload)
            self.instance.writeAnswers(answer)

    def _emit_text(self, payload):
        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(payload))

    def _emit_text_line(self, line):
        if self.instance.hasListener('text'):
            self.instance.writeText(line)

    def _emit(self, payload):
        self._answer(payload)
        self._emit_text(payload)

    def close(self):
        """Close active streams and release temporary files; safe to call repeatedly."""
        for item in getattr(self, '_active', {}).values():
            item['file'].close()
        self._active = {}
        if hasattr(self, '_release_assets') and hasattr(self, '_assets'):
            self._release_assets()
        workspace = getattr(self, '_workspace', None)
        if workspace is not None:
            workspace.close()
            self._workspace = None
