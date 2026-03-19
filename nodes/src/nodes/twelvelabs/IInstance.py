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

import os
import tempfile
from rocketlib import IInstanceBase, AVI_ACTION, debug
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    Instance class for the TwelveLabs node.

    Buffers incoming video chunks, writes them to a temporary file on stream end,
    submits the file to TwelveLabs with the configured instructions, and outputs
    the returned text.
    """

    IGlobal: IGlobal

    def beginInstance(self) -> None:
        self._video_chunks = []
        self._mime_type = ''

    def writeVideo(self, action: int, mimeType: str, buffer: bytes) -> None:
        if action == AVI_ACTION.BEGIN:
            self._video_chunks = []
            self._mime_type = mimeType

        elif action == AVI_ACTION.WRITE:
            self._video_chunks.append(buffer)

        elif action == AVI_ACTION.END:
            self._submit_video()

    def _submit_video(self) -> None:
        """Write buffered video to a temp file, submit to TwelveLabs, output text."""
        from . import twelvelabs_driver

        suffix = self._suffix_for_mime(self._mime_type)
        tmp_path = None

        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
                for chunk in self._video_chunks:
                    f.write(chunk)
                tmp_path = os.path.realpath(f.name)

            debug(f'    TwelveLabs: submitting {tmp_path} ({len(self._video_chunks)} chunks)')

            text = twelvelabs_driver.process_video(
                self.IGlobal.api_key,
                tmp_path,
                self.IGlobal.instructions,
            )

            if self.instance.hasListener('text'):
                self.instance.writeText(text if text else "No data from TwelveLabs")

        finally:
            self._video_chunks = []
            # if tmp_path and os.path.exists(tmp_path):
            #     os.unlink(tmp_path)

    @staticmethod
    def _suffix_for_mime(mime_type: str) -> str:
        """Return a file suffix appropriate for the given MIME type."""
        mime_map = {
            'video/mp4': '.mp4',
            'video/quicktime': '.mov',
            'video/x-msvideo': '.avi',
            'video/webm': '.webm',
            'video/x-matroska': '.mkv',
            'video/mpeg': '.mpg',
        }
        return mime_map.get(mime_type, '.mp4')
