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

from typing import List
import os
import re
import base64
import asyncio
import mimetypes
import secrets
import uuid

from rocketlib import IInstanceBase, IJson, warning, debug
from ai.account.live_media import LiveWriter
from ai.account.media_publish import MediaPublisher, sfu_hosts
from ai.account.file_store import MAX_CHUNK_SIZE
from ai.common.schema import Doc, Question, Answer
from ai.common.avi.descriptor import descriptor_from_payload, source_media_detail
from rocketlib import AVI_ACTION, Entry

from .IGlobal import IGlobal

_MEDIA_OFF_HINTED = False


def _hint_media_plane_off(lane: str) -> None:
    """Once per process, note that live streaming is available but off, and how to turn it on.
    Debug-level and one-shot so the common file-delivery path stays quiet.
    """
    global _MEDIA_OFF_HINTED
    if _MEDIA_OFF_HINTED:
        return
    _MEDIA_OFF_HINTED = True
    debug(
        f'media-plane off: ROCKETRIDE_MEDIA_SFU is unset, so {lane} is delivered as a whole-file '
        "artifact. Set it to 'managed' (local) or an SFU host to stream it live over WHEP."
    )


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    text: str = ''

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Per-lane spool writers + stream descriptors; per-instance, not class-level mutables.
        self._media: dict = {}
        self._media_descriptors = {}

    def _getkey(self, type: str):
        # Allow the key to be overriden by
        #   connConfig: {
        #       laneName: "defdoc"
        #   }
        #   connConfig: {
        #       lanes: {
        #           laneId: "documents"
        #           laneName: "defdoc"
        #       }
        #   }

        # If we are using the new stye:
        if self.IGlobal.laneName is not None:
            # Grab the key name
            key = self.IGlobal.laneName
        elif self.IGlobal.lanes:
            # If we are using the old style, grab the key
            key = self.IGlobal.lanes.get(type, type)
        else:
            key = type

        # Add the type so we can track it result_types
        if 'result_types' not in self.instance.currentObject.response:
            self.instance.currentObject.response['result_types'] = {}
        self.instance.currentObject.response['result_types'][key] = type

        # Return the key
        return key

    def open(self, object: Entry):
        """
        Initialize the instance for a new object.

        Resets chunk and table IDs to start fresh for this object's processing.

        Args:
            object (Entry): The object to initialize processing for.
        """
        self.text = ''  # Reset the text buffer
        # Per-lane spool writers + descriptors; each lane's BEGIN (re)creates its entry.
        self._media = {}
        self._media_descriptors = {}

    def close(self):
        """
        Finalize the instance for the current object.

        This method is called when processing of the current object is complete.
        """

        def deep_merge_dicts(src: dict, dest: dict):
            for key, value in src.items():
                if isinstance(value, dict) and isinstance(dest.get(key), dict):
                    deep_merge_dicts(value, dest[key])
                else:
                    # Manually copy dict or list to avoid shared references
                    if isinstance(value, dict):
                        dest[key] = deep_merge_dicts(value, {})
                    elif isinstance(value, list):
                        dest[key] = [deep_merge_dicts(item, {}) if isinstance(item, dict) else item for item in value]
                    else:
                        dest[key] = value
            return dest

        if self.text:
            # Get the key to write to
            key = self._getkey('text')

            # If it isn't there, create it
            if key not in self.instance.currentObject.response:
                self.instance.currentObject.response[key] = []

            # Add the text
            self.instance.currentObject.response[key].append(self.text)

        # Copy over the metadata info
        if self.instance.currentObject.hasMetadata:
            # Create the dict we will return
            metadata = {}

            # Copy over the keys
            for k, v in self.instance.currentObject.metadata.items():
                if 'tika' in k.lower():
                    continue
                metadata[k] = v

            # Set it
            self.instance.currentObject.response['metadata'] = metadata

        # Copy over the name
        if self.instance.currentObject.hasName:
            self.instance.currentObject.response['name'] = self.instance.currentObject.name

        # Copy over the path
        if self.instance.currentObject.hasPath:
            # Get the object path
            path = self.instance.currentObject.path

            # Strip the name
            directory = os.path.dirname(path)

            # Save it
            self.instance.currentObject.response['path'] = directory

    def writeText(self, text: str):
        # Save it out so we can write it into the text array
        self.text += text + '\n\n'

    def writeTable(self, table: str):
        # Get the key to write to (official lane name is "table")
        key = self._getkey('table')

        # If it isn't there, create it
        if key not in self.instance.currentObject.response:
            self.instance.currentObject.response[key] = []

        # Add the table
        self.instance.currentObject.response[key].append(table)

    def writeJson(self, data: IJson):
        # Get the key to write to (official lane name is "json")
        key = self._getkey('json')

        # If it isn't there, create it
        if key not in self.instance.currentObject.response:
            self.instance.currentObject.response[key] = []

        # Add the json
        self.instance.currentObject.response[key].append(IJson.toDict(data))

    def writeDocuments(self, documents: List[Doc]):
        # Get the key to write to
        key = self._getkey('documents')

        # If it isn't there, create it
        if key not in self.instance.currentObject.response:
            self.instance.currentObject.response[key] = []

        # Add the documents
        for document in documents:
            self.instance.currentObject.response[key].append(document.toDict())

    def writeQuestions(self, questions: Question):
        # Get the key to write to
        key = self._getkey('questions')

        # If it isn't there, create it
        if key not in self.instance.currentObject.response:
            self.instance.currentObject.response[key] = []

        # Add the documents
        self.instance.currentObject.response[key].append(questions.model_dump())

    def writeAnswers(self, answer: Answer):
        # Get the key to write to
        key = self._getkey('answers')

        # If it isn't there, create it
        if key not in self.instance.currentObject.response:
            self.instance.currentObject.response[key] = []

        # Add the documents
        if answer.isJson():
            self.instance.currentObject.response[key].append(answer.getJson())
        else:
            self.instance.currentObject.response[key].append(answer.getText())

    def _write_media(self, lane: str, action: int, mimeType: str, data: bytes):
        """Spool the image/audio/video lanes as they arrive, announcing on BEGIN.
        A consumer reads along behind the producer; nothing is held whole in memory.
        """
        if action == AVI_ACTION.BEGIN:
            # BEGIN carries the stream descriptor, not media bytes.
            self._media_descriptors[lane] = descriptor_from_payload(data)
            self._begin_media(lane, mimeType)

        elif action == AVI_ACTION.WRITE:
            if entry := self._media.get(lane):
                entry['writer'].append(data)
                entry['bytes'] += len(data)
                if publisher := entry.get('publisher'):
                    publisher.feed(data)

        elif action == AVI_ACTION.END:
            entry = self._media.pop(lane, None)
            if entry is None:
                return
            if not entry['bytes']:
                # An empty stream produces no file and no entry (a producer that emitted
                # nothing, not a blank result). Close the push and drop the empty spool.
                if publisher := entry.get('publisher'):
                    publisher.finish()
                entry['writer'].discard()
                return
            key = self._getkey(lane)
            if key not in self.instance.currentObject.response:
                self.instance.currentObject.response[key] = []
            result = self._end_media(lane, entry)
            # source_media_detail() strips the identity/security backlink from the response.
            detail = source_media_detail(self._media_descriptors.get(lane))
            if detail:
                result['metadata'] = detail
            self.instance.currentObject.response[key].append(result)

    def _begin_media(self, lane: str, mimeType: str) -> None:
        """Open the spool, start the live push, and announce the artifact before its bytes exist."""
        path = self._media_path(lane, mimeType)
        writer = LiveWriter(self.IGlobal.client_id or 'anonymous', path)
        try:
            writer.begin()
        except OSError as e:
            # The spool dir may be unwritable; the old in-memory path couldn't fail here, and
            # _init_file_store already treats storage failures as non-fatal. Drop this lane (no
            # entry) so the object doesn't abort over a temp-file error.
            warning(f'response: spool open failed for {lane}; skipping its media: {e}')
            return
        entry = {'writer': writer, 'path': path, 'mime': mimeType, 'publisher': None, 'bytes': 0}

        # Live media-plane: push the stream to the SFU so the client pulls it over WHEP,
        # never bytes over the control WS. Resolve the SFU only for a streamable lane with
        # transmit_media on — so an image lane or transmit_media off never even touches it.
        # No SFU configured => the spool path still stands and the media is delivered as a
        # normal (whole-file) artifact instead.
        if self.IGlobal.transmit_media and mimeType.startswith(('audio/', 'video/')):
            hosts = sfu_hosts()
            if hosts:
                whep_host, rtsp_host = hosts
                stream_id = self._stream_id()
                publisher = MediaPublisher(whep_host, stream_id, mimeType, rtsp_host=rtsp_host)
                if publisher.begin():
                    entry['publisher'] = publisher
                    self._trace_media_publish(lane, mimeType, whep_host, stream_id, publisher.whep_url)
            else:
                _hint_media_plane_off(lane)  # once: how to turn live streaming on
        self._media[lane] = entry

        if self.IGlobal.transmit_media and self.IGlobal.client_id:
            publisher = entry['publisher']
            whep = publisher.whep_url if publisher else None
            # Announce a pull path only if the client can resolve it later — a live WHEP url, or a
            # persisted object (file_store). With neither, the media is base64-inlined in the
            # response, so an announced outputs/ path would point at nothing after END.
            if whep or self.IGlobal.file_store is not None:
                self._announce_artifact(lane, mimeType, path, whep)

    def _trace_media_publish(self, kind: str, mime: str, sfu: str, stream_id: str, whep_url: str) -> None:
        """Surface the live push in the monitor (Flow/Trace + Log) as proof it went over WebRTC."""
        try:
            self.instance.sendSSE(
                'media_publish',
                kind=kind,
                mime_type=mime,
                stream_id=stream_id,
                sfu=sfu,
                whep_url=whep_url,
                transport='RTSP->WHEP',
            )
        except Exception as e:
            warning(f'response: media_publish trace failed: {e}')
        debug(f'media-plane -> SFU: streaming {kind} ({mime}) as {stream_id} via WHEP {whep_url}')

    def _end_media(self, lane: str, entry: dict) -> dict:
        """Close the live push and persist the spool. Discarded last: base64 fallback reads it."""
        writer, path, mime = entry['writer'], entry['path'], entry['mime']
        if publisher := entry.get('publisher'):
            publisher.finish()
            if publisher.failed:
                warning(
                    f'response: media-plane push died for {mime}; client falls back to storage. ffmpeg: {publisher.stderr_tail}'
                )
        writer.finish()
        try:
            if self.IGlobal.file_store is not None:
                try:
                    _run_async(self._persist_spool(path))
                    return {'mime_type': mime, 'path': path}
                except Exception as e:
                    warning(f'response: persisting {path!r} failed; falling back to base64: {e}')

            return {'mime_type': mime, lane: base64.b64encode(self._read_spool(lane, path)).decode('utf-8')}
        finally:
            writer.discard()

    async def _persist_spool(self, path: str) -> None:
        """Copy the spool into the account store, one chunk at a time."""
        store = self.IGlobal.file_store
        handle = await store.open_write(path)
        try:
            with open(self._spool_part(path), 'rb') as fh:
                while chunk := fh.read(MAX_CHUNK_SIZE):
                    await store.write_chunk(handle, chunk)
        except BaseException:
            try:
                await store.close_write(handle)
            except Exception:
                pass
            raise
        await store.close_write(handle)

    def _spool_part(self, path: str) -> str:
        from ai.account.live_media import spool_paths

        return spool_paths(self.IGlobal.client_id or 'anonymous', path)[0]

    def _read_spool(self, lane: str, path: str) -> bytes:
        """Read the whole spool back. Only the base64 fallback pays this cost."""
        try:
            with open(self._spool_part(path), 'rb') as fh:
                return fh.read()
        except OSError as e:
            warning(f'response: reading spool for {lane} failed: {e}')
            return b''

    def _announce_artifact(self, kind: str, mime: str, path: str, url: str | None = None) -> None:
        """Announce the artifact before it exists: a WHEP url for live, else the pull path."""
        try:
            self.instance.sendSSE(
                'artifact_path',
                kind=kind,
                mime_type=mime,
                path=path,
                name=path.rsplit('/', 1)[-1],
                streaming=True,
                url=url,
                live=bool(url),
            )
        except Exception as e:
            warning(f'response: artifact_path SSE failed for {path!r}: {e}')

    def _stream_id(self) -> str:
        """SFU stream name as a capability token: a per-client prefix plus 128 bits of
        randomness. The WHEP url only travels the authenticated control channel (SSE to this
        client), so an unguessable id keeps one client from reaching another's live stream by
        guessing. The prefix lets the SFU scope path-based auth rules per client — see the
        media-sfu deploy kit.
        """
        tenant = re.sub(r'[^A-Za-z0-9]+', '', self.IGlobal.client_id or 'anon')[:24] or 'anon'
        return f'{tenant}-{secrets.token_hex(16)}'

    def _media_path(self, kind: str, mime: str) -> str:
        """Unique logical FileStore path under ``outputs/<kind>/`` for this media."""
        ext = mimetypes.guess_extension(mime or '') or ''
        if not ext and mime and '/' in mime:
            # guess_extension misses common audio/video types (e.g. audio/wav);
            # fall back to the MIME subtype so the file keeps a usable extension.
            ext = '.' + mime.split(';')[0].split('/')[-1].strip()
        base = 'output'
        if self.instance.currentObject.hasName and self.instance.currentObject.name:
            base = os.path.splitext(os.path.basename(self.instance.currentObject.name))[0] or 'output'
        return f'outputs/{kind}/{base}-{uuid.uuid4().hex[:8]}{ext}'

    def writeAudio(self, aviAction: int, mimeType: str, data: bytes):
        self._write_media('audio', aviAction, mimeType, data)

    def writeVideo(self, aviAction: int, mimeType: str, data: bytes):
        self._write_media('video', aviAction, mimeType, data)

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        self._write_media('image', action, mimeType, buffer)


def _run_async(coro):
    """Run a coroutine from the synchronous AVI callbacks, which own no event loop."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        raise RuntimeError('_run_async must not be called from a thread with a running event loop')

    return asyncio.run(coro)
