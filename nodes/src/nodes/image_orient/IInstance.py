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

import json

from ai.common.avi.descriptor import (
    descriptor_from_payload,
    forward_enriched_image,
    image_begin_payload,
    inherited_or_derived_name,
)
from rocketlib import AVI_ACTION, Entry, IInstanceBase, error


from .IGlobal import IGlobal

# Only used for the fallback name when a stream arrives unnamed; the node never changes format.
_EXT_FOR_MIME = {'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png'}


class IInstance(IInstanceBase):
    """
    Per-object plumbing: accumulate an image stream, ask which way up it goes, emit it.

    Deliberately free of cv2 and numpy — every pixel this node touches is touched behind
    ``IGlobal.orient``. That keeps the class unit-testable in an environment with no imaging
    libraries, and confines the decoded array to one stack frame.
    """

    IGlobal: IGlobal

    def open(self, obj: Entry):
        """
        Reset per-object state.

        Args:
            obj: The object being opened.
        """
        self._buffer = bytearray()
        self._descriptor = None
        self._mime = None
        return None

    def writeImage(self, aviAction, mimeType: str, buffer: bytes):
        """
        Accumulate one image stream, then correct its orientation on END.

        Args:
            aviAction: BEGIN, WRITE or END.
            mimeType: The stream's mime type.
            buffer: The BEGIN descriptor payload, or a chunk of image bytes.

        Returns:
            The result of ``preventDefault()`` on every path. This node replaces the image rather
            than adding to it, so letting the engine also forward the original would deliver two
            images where the pipeline expects one.
        """
        if aviAction == AVI_ACTION.BEGIN:
            self._buffer = bytearray()
            self._descriptor = descriptor_from_payload(buffer)
            self._mime = mimeType
        elif aviAction == AVI_ACTION.WRITE:
            if buffer:
                self._buffer.extend(buffer)
        elif aviAction == AVI_ACTION.END:
            self._finish()

        return self.preventDefault()

    def _finish(self) -> None:
        """Decide, emit the image, and record what happened on the text lane."""
        source = bytes(self._buffer)
        self._buffer = bytearray()

        wants_image = self.instance.hasListener('image')
        wants_text = self.instance.hasListener('text')
        if not wants_image and not wants_text:
            # Nothing consumes either lane, so decoding would be pure cost.
            return

        result = self.IGlobal.orient(source, self._mime, wants_image)
        if result is None:
            error(f'image_orient: could not decode {self._mime}; forwarding unchanged')
            self._forward(source, wants_image)
            self._report({'decoded': False, 'rotation': 0, 'confident': False}, wants_text)
            return

        out, record = result
        if out is None:
            self._forward(source, wants_image)
        elif wants_image:
            self._emit(out, record)
        self._report(record, wants_text)

    def _forward(self, source: bytes, wants_image: bool) -> None:
        """
        Pass the original bytes through untouched.

        Args:
            source: The image exactly as it arrived.
            wants_image: False when nothing consumes the image lane.
        """
        if not wants_image:
            return
        # Taken from the incoming descriptor, never derived: image_begin_payload's fallback is
        # PIL-based and this node has no Pillow. Absent, they are omitted — sinks tolerate that.
        meta = getattr(self._descriptor, 'metadata', None)
        forward_enriched_image(
            self.instance,
            self._descriptor,
            self._mime,
            source,
            width=getattr(meta, 'width', None),
            height=getattr(meta, 'height', None),
        )

    def _emit(self, data: bytes, record: dict) -> None:
        """
        Emit the corrected image as a single stream.

        The source name is kept: this is the same photograph turned the right way up, not a new
        artifact, so a sink re-run replaces the file rather than accumulating a copy beside it.

        Args:
            data: The rotated, re-encoded image.
            record: The decision record, carrying the rotated dimensions.
        """
        payload = image_begin_payload(
            self._descriptor,
            size=len(data),
            width=record.get('width'),
            height=record.get('height'),
            name=inherited_or_derived_name(self._descriptor, ext=_EXT_FOR_MIME.get(self._mime, 'jpg')),
        )
        self.instance.writeImage(AVI_ACTION.BEGIN, self._mime, payload)
        self.instance.writeImage(AVI_ACTION.WRITE, self._mime, data)
        self.instance.writeImage(AVI_ACTION.END, self._mime, b'')

    def _report(self, record: dict, wants_text: bool) -> None:
        """
        Emit the decision record on the text lane.

        Sent on every path, including failure. ``decoded`` separates "this is not an image I can
        read" from "I read it and left it alone" — without it both look like a photo that was not
        rotated, and they need different fixes.

        Args:
            record: What the decision produced.
            wants_text: False when nothing consumes the text lane.
        """
        if not wants_text:
            return
        # Emitted geometry is for the image, not the audit; it would only be noise here.
        published = {k: v for k, v in record.items() if k not in ('width', 'height')}
        self.instance.writeText(json.dumps(published))
