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
import base64

from rocketlib import IInstanceBase, IJson
from ai.common.schema import Doc, Question, Answer
from ai.common.avi.descriptor import descriptor_from_payload, source_media_detail
from rocketlib import AVI_ACTION, Entry

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    text: str = ''

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Per-lane buffers + descriptors; per-instance, not class-level mutables (shared).
        self._media_buffers = {}
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
        # Per-lane media buffers + descriptors; each lane's BEGIN (re)initializes its entry.
        self._media_buffers = {}
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
        """Shared handler for the image/audio/video stream lanes.

        All three multimedia lanes behave identically: accumulate the stream across
        BEGIN/WRITE/END and emit a single entry ``{mime_type, <lane>, metadata}`` where
        ``<lane>`` is the base64 payload (key ``'image'``/``'audio'``/``'video'``) and
        ``metadata`` is the stream descriptor parsed from that stream's own BEGIN payload
        (present only when one arrived).

        State is per lane, which separates image from audio from video. Several streams on
        one lane within a single object — a producer fanning one scan out into several
        images — arrive already separated: ``IInstanceBase`` delivers each stream's END
        before the next BEGIN, so every one of them reaches :meth:`_emit_media` in turn.

        Args:
            lane (str): The media lane — ``'image'``, ``'audio'`` or ``'video'``.
            action (int): The AVI stream action (BEGIN/WRITE/END).
            mimeType (str): The media MIME type.
            data (bytes): The BEGIN descriptor payload, or a WRITE data chunk.
        """
        if action == AVI_ACTION.BEGIN:
            # BEGIN carries the stream descriptor, not media bytes.
            self._media_buffers[lane] = bytearray()
            self._media_descriptors[lane] = descriptor_from_payload(data)

        elif action == AVI_ACTION.WRITE:
            self._media_buffers[lane] += data

        elif action == AVI_ACTION.END:
            # An empty stream has nothing to return, and the file sink creates no file for
            # one either, so it produces no entry rather than a blank one.
            if not self._media_buffers.get(lane):
                return
            self._emit_media(lane, mimeType)

    def _emit_media(self, lane: str, mimeType: str) -> None:
        """Append one completed stream to the response, labelled with its own descriptor.

        Args:
            lane (str): The media lane — ``'image'``, ``'audio'`` or ``'video'``.
            mimeType (str): The media MIME type.
        """
        key = self._getkey(lane)
        if key not in self.instance.currentObject.response:
            self.instance.currentObject.response[key] = []

        payload = base64.b64encode(self._media_buffers.get(lane, bytearray())).decode('utf-8')
        self._media_buffers[lane] = bytearray()

        # source_media_detail() strips the identity/security backlink from the response.
        entry = {'mime_type': mimeType, lane: payload}
        detail = source_media_detail(self._media_descriptors.get(lane))
        if detail:
            entry['metadata'] = detail
        self.instance.currentObject.response[key].append(entry)

    def writeAudio(self, aviAction: int, mimeType: str, data: bytes):
        self._write_media('audio', aviAction, mimeType, data)

    def writeVideo(self, aviAction: int, mimeType: str, data: bytes):
        self._write_media('video', aviAction, mimeType, data)

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        self._write_media('image', action, mimeType, buffer)
