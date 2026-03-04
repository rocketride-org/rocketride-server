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

from typing import List, Tuple
from rocketlib import IInstanceBase, Entry
from ai.common.schema import Doc, DocMetadata
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    Instance class responsible for handling audio input and delegating transcription.

    This class uses the `Transcribe` helper to buffer and process audio data,
    invoking the global transcription function when appropriate.
    """

    IGlobal: IGlobal  # Reference to the global object with configuration and transcribe method

    def _segment_callback(self, segments: List[Tuple[int, str]]):
        """
        Output transcribed text output.

        Args:
            segments (List[Tuple[float, str]]): A list of (timestamp, text) tuples
        """
        outputDocs = False
        if self.instance.hasListener('documents'):
            outputDocs = True

        outputText = False
        if self.instance.hasListener('text'):
            outputText = True

        # Walk through the segments creating a document for each
        accum = ''
        docs = []

        for segment in segments:
            # Get the time stamp and text
            time_stamp, text = segment

            if outputDocs:
                # Create the default metadata for the document
                metadata = DocMetadata.defaultMetadata(self)

                # Save the frame and time stamp in the metadata
                metadata.chunkId = self.chunkId
                metadata.time_stamp = time_stamp

                # Create the document object and save the base64 encoded image
                doc = Doc(page_content=text, metadata=metadata)
                docs.append(doc)

                # One more chunk
                self.chunkId += 1

            if outputText:
                # If we are outputting text, just accumulate it
                accum += text + '\n'

        # Output the documents if we need to
        if outputDocs:
            self.instance.writeDocuments(docs)

        # Output the text if we need to
        if outputText:
            self.instance.writeText(accum)

    def beginInstance(self):
        """
        Initialize the instance-level transcription pipeline.

        Creates a `Transcribe` object with parameters from the global config and
        sets up the callback for receiving transcribed text.
        """
        from .transcribe import Transcribe

        self._transcribe = Transcribe(
            segment_callback=self._segment_callback,
            transcribe=self.IGlobal.transcribe,
        )

    def open(self, object: Entry):
        """
        Open the instance with the provided object.

        Args:
            object (Entry): The object to be opened.
        """
        # New stream - reset the chunkId
        self.chunkId = 0

    def writeAudio(self, action: int, mimeType: str, buffer: bytes):
        # Use the standard AVI write method for audio
        self._transcribe.writeAVI(action, mimeType, buffer)

    def writeVideo(self, action: int, mimeType: str, buffer: bytes):
        # Use the standard AVI write method for video
        self._transcribe.writeAVI(action, mimeType, buffer)
