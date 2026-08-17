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

from rocketlib import AVI_ACTION, Entry, IInstanceBase, error


from ai.common.avi.descriptor import (
    derived_name,
    descriptor_from_payload,
    forward_enriched_image,
    image_begin_payload,
)

from .IGlobal import IGlobal

# Crops are always re-encoded, so the output type is fixed regardless of what came in.
_OUTPUT_MIME = 'image/jpeg'


class IInstance(IInstanceBase):
    """
    Per-object plumbing: accumulate an image stream, split it, emit one stream per photo.

    Deliberately free of cv2 and numpy — every pixel touched by this node is touched behind
    ``IGlobal.split_scan``. That keeps this class unit-testable in an environment with no
    imaging libraries, and confines the 143 MP array to one stack frame.
    """

    IGlobal: IGlobal

    # Raw bytes of the inbound image, accumulated across WRITE chunks.
    image_data: bytearray = None

    # Stream descriptor parsed on the image BEGIN (source provenance).
    _source_descriptor = None

    # Emission counter for output names. Counts files actually emitted, not regions detected,
    # so names never gain a gap that would read as lost data. Per *object*, not per stream: one
    # object can carry several image streams (an upstream fan-out, or a multi-page document),
    # and derived_name() builds every stem from the source object, so restarting at 0 for each
    # stream would emit the same filename twice.
    _crop_index: int = 0

    def open(self, obj: Entry):
        """
        Reset per-object state.

        Args:
            obj: The object entering the node.
        """
        self._crop_index = 0

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        """
        Accumulate an inbound scan and, on END, emit one image stream per photo found.

        Args:
            action: AVI stream action (BEGIN/WRITE/END).
            mimeType: MIME type of the image chunk.
            buffer: Raw bytes on WRITE; the source stream descriptor on BEGIN.

        Returns:
            preventDefault() to suppress the engine's default forwarding — this node replaces
            its input with the crops, so nothing should pass through untouched.
        """
        if action == AVI_ACTION.BEGIN:
            # BEGIN carries the source stream descriptor, not image bytes.
            self._source_descriptor = descriptor_from_payload(buffer)
            self.image_data = bytearray()

        elif action == AVI_ACTION.WRITE:
            self.image_data += buffer

        elif action == AVI_ACTION.END:
            self._finish(mimeType)

        # We are re-writing the image, so don't do the default
        return self.preventDefault()

    def _finish(self, mimeType: str) -> None:
        """
        Do the work for one completed inbound scan, then release its buffers.

        Ordered so that each gate comes before the work it guards: with nothing listening there
        is no reason to decode 430 MB, and with only the text lane listening there is no reason
        to encode crops nobody will read.

        Args:
            mimeType: MIME type the scan arrived as, used when forwarding it unchanged.
        """
        source = bytes(self.image_data) if self.image_data else b''
        self.image_data = None

        wants_image = self.instance.hasListener('image')
        wants_text = self.instance.hasListener('text')
        if not wants_image and not wants_text:
            return

        result = self.IGlobal.split_scan(source, wants_image)
        if result is None:
            error('scan_cropper: could not decode the image; forwarding it unchanged')
            self._emit_original(source, mimeType, wants_image)
            self._emit_report(False, [], wants_text)
            return

        crops, regions = result
        for crop in crops:
            self._emit_crop(crop, regions)

        if not crops and not regions:
            self._emit_original(source, mimeType, wants_image)

        self._emit_report(True, regions, wants_text)

    def _emit_crop(self, crop: dict, regions: list) -> None:
        """
        Emit one cropped photo as its own image stream.

        One BEGIN/WRITE/END triplet is one downstream object; repeating it is the only way a
        node fans out. The emitted name is stamped back onto its region so the audit output on
        the text lane maps each filename to the geometry it came from.

        Args:
            crop: One entry from ``split_scan``'s crops list.
            regions: The regions list, mutated in place to record the name.
        """
        name = derived_name(self._source_descriptor, index=self._crop_index, marker='crop', ext='jpg')
        payload = image_begin_payload(
            self._source_descriptor,
            size=len(crop['data']),
            width=crop['width'],
            height=crop['height'],
            name=name,
        )
        self.instance.writeImage(AVI_ACTION.BEGIN, _OUTPUT_MIME, payload)
        self.instance.writeImage(AVI_ACTION.WRITE, _OUTPUT_MIME, crop['data'])
        self.instance.writeImage(AVI_ACTION.END, _OUTPUT_MIME)

        if name:
            regions[crop['region']]['name'] = name
        self._crop_index += 1

    def _emit_original(self, source: bytes, mimeType: str, wants_image: bool) -> None:
        """
        Forward the untouched scan, so a page we could not split does not vanish.

        Args:
            source: The scan exactly as it arrived.
            mimeType: The MIME type it arrived as.
            wants_image: False when nothing consumes the image lane, in which case there is
                nowhere to forward it to.
        """
        if not wants_image or not source:
            return
        forward_enriched_image(self.instance, self._source_descriptor, mimeType, source)

    def _emit_report(self, decoded: bool, regions: list, wants_text: bool) -> None:
        """
        Emit the detection record on the text lane.

        Sent on every path, including both failure paths. ``decoded`` is what separates "this is
        not an image I can read" from "I read it and found nothing" — without it both report
        zero regions and are indistinguishable when auditing a folder of scans.

        Args:
            decoded: Whether the input could be decoded at all.
            regions: Everything detection found, in reading order.
            wants_text: False when nothing consumes the text lane.
        """
        if not wants_text:
            return
        self.instance.writeText(json.dumps({'decoded': decoded, 'count': len(regions), 'regions': regions}))
