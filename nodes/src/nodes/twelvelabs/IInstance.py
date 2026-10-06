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

    Streams incoming video chunks straight to a temporary file, submits the
    file to TwelveLabs with the configured instructions, and outputs the
    returned text.
    """

    IGlobal: IGlobal

    def beginInstance(self) -> None:
        """
        Initialize the instance.
        """
        self._tmp_path = None
        self._tmp_file = None
        self._mime_type = ''

    def writeVideo(self, action: int, mimeType: str, buffer: bytes) -> None:
        """
        Write video data to the instance.

        Args:
            action: The action to perform.
            mimeType: The MIME type of the video.
            buffer: The video data.
        """
        if action == AVI_ACTION.BEGIN:
            # A file still open here belongs to a stream the engine displaced
            # without an END (e.g. a prior stream that never declared a byte
            # count to settle against) - release it before starting the new one.
            self._discard_tmp_file()
            self._mime_type = mimeType
            suffix = self._suffix_for_mime(mimeType)
            fd, self._tmp_path = tempfile.mkstemp(suffix=suffix)
            self._tmp_file = os.fdopen(fd, 'wb')

        elif action == AVI_ACTION.WRITE:
            if self._tmp_file is not None and buffer:
                self._tmp_file.write(buffer)

        elif action == AVI_ACTION.END:
            self._submit_video()

    def closing(self) -> None:
        """Release a stream still open when the instance is torn down (no END arrived)."""
        self._discard_tmp_file()

    def _discard_tmp_file(self) -> None:
        """Close and delete any temp file left over from an incomplete stream."""
        if self._tmp_file is not None:
            try:
                self._tmp_file.close()
            except OSError as e:
                debug(f'TwelveLabs: failed to close temp file: {e}')
            self._tmp_file = None
        if self._tmp_path and os.path.exists(self._tmp_path):
            try:
                os.unlink(self._tmp_path)
            except OSError as e:
                debug(f'TwelveLabs: failed to delete temp file: {e}')
        self._tmp_path = None

    def _submit_video(self) -> None:
        """Close the temp file, submit it to TwelveLabs, output text."""
        from . import twelvelabs_driver

        if self._tmp_file is None:
            return

        try:
            self._tmp_file.close()
            self._tmp_file = None

            debug(f'TwelveLabs: submitting {self._tmp_path}')

            text = twelvelabs_driver.process_video(
                self.IGlobal.api_key,
                self._tmp_path,
                self.IGlobal.instructions,
            )

            if self.instance.hasListener('text'):
                self.instance.writeText(text if text else 'No data from TwelveLabs')

        finally:
            self._discard_tmp_file()

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
