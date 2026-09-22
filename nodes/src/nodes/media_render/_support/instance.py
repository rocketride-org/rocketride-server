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
import time
from rocketlib import AVI_ACTION, IInstanceBase, debug
from rocketlib.engine import monitorSSE
from ai.common.schema import Answer
from ai.common.avi.descriptor import audio_begin_payload, video_begin_payload, image_begin_payload
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

LEGACY_DESTINATIONS = {'write_to', 'probe_to', 'status_to', 'report_to'}


class MediaInstance(IInstanceBase):
    """Own temporary files until closing; downstream nodes own persistence."""

    node = 'media'
    modes = ()

    def open(self, obj):
        """Initialize temporary input state for the incoming object."""
        self.close()
        self._workspace = Workspace()
        self._active = {}
        self._inputs = {}
        self._input_bytes = 0
        self._input_limit = self.IGlobal.config.get('max_input_bytes', 16 * 1024**3)
        self._assets = []
        self._handled = False
        self._t0 = time.time()
        self._entry_name = Path(str(getattr(obj, 'name', '') or 'source.media')).name
        self._ctx = {}
        self._question = ''
        self._spec = None
        self._render_outputs = []

    def _request(self):
        raw = self.IGlobal.config.get('request') or '{}'
        request = json.loads(raw) if isinstance(raw, str) else copy.deepcopy(raw)
        if not isinstance(request, dict):
            raise ValueError('request must be a JSON object')
        if LEGACY_DESTINATIONS.intersection(request):
            raise ValueError('Storage destinations are unsupported; connect a downstream sink')
        mode = request.get('mode', self.modes[0])
        if mode not in self.modes:
            raise ValueError('mode must be one of: ' + ', '.join(self.modes))
        return request, mode

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
            descriptor = json.loads(bytes(data).decode('utf-8')) if data else {}
            if not isinstance(descriptor, dict):
                raise ValueError('Media descriptor must be an object')
            name = descriptor.get('name') or descriptor.get('resource_name') or self._entry_name
            if name in self._inputs or any(item['name'] == name for item in self._active.values()):
                raise ValueError('Duplicate input stream name: ' + str(name))
            if len(self._inputs) + len(self._active) >= 128:
                raise ValueError('At most 128 input streams are supported per object')
            if isinstance(name, str) and name.split('/')[0] == 'outputs':
                raise ValueError('Input name uses the reserved outputs directory')
            path = self._workspace.resolve(name)
            expected = descriptor.get('size')
            if expected is not None and (type(expected) is not int or expected < 0):
                raise ValueError('Declared stream size must be a non-negative integer')
            if expected is not None and expected > self._input_limit - self._input_bytes:
                raise ValueError('Media input exceeds the configured max_input_mb limit')
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
                if item['size'] is not None and item['received'] + len(data) > item['size']:
                    raise ValueError('Media stream exceeded its declared byte count')
                item['file'].write(data)
                item['received'] += len(data)
                self._input_bytes += len(data)
            else:
                item['file'].close()
                del self._active[lane]
                if not item['received'] or (item['size'] is not None and item['received'] != item['size']):
                    raise ValueError('Empty or truncated media stream')
                self._inputs[item['name']] = item

    def closing(self):
        """Process completed input streams and release all object-local scratch files."""
        if getattr(self, '_handled', False):
            return
        self._handled = True
        try:
            if self._active:
                raise ValueError('An input media stream did not finish')
            request, mode = self._request()
            if not (self.instance.hasListener('answers') or self.instance.hasListener('text')):
                raise ValueError('Connect a text or answers consumer for the result manifest')
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
        self._spec = spec
        report = self._render(self._workspace)
        paths = sorted(path for path in (self._workspace.root / 'outputs').rglob('*') if path.is_file())
        for path in paths:
            lane, _ = self._output_type(path)
            if lane in ('video', 'audio', 'image') and not self.instance.hasListener(lane):
                raise ValueError('Connect a ' + lane + ' sink for rendered output')
        artifacts = [self._stream_file(path) for path in paths]
        # These are emitted names, never account paths or signed URLs.
        report['files'] = {
            key: str(Path(value).relative_to('outputs')) for key, value in report.get('files', {}).items()
        }
        report['artifacts'] = artifacts
        report['storage'] = 'downstream'
        self._emit(report)

    def _output_type(self, path):
        name = path.relative_to(self._workspace.root / 'outputs').as_posix()
        for output in self._render_outputs:
            if output['file'] == name:
                return ('video' if output['video'] else 'audio'), MEDIA_MIMES[output['container']]
        mime = mimetypes.guess_type(name)[0] or 'application/octet-stream'
        return mime.split('/')[0], mime

    def _stream_file(self, path):
        name = path.relative_to(self._workspace.root / 'outputs').as_posix()
        lane, mime = self._output_type(path)
        record = {'name': name, 'mime': mime, 'size': path.stat().st_size}
        if lane in ('video', 'audio', 'image'):
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
