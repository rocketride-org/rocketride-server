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

from typing import TYPE_CHECKING
import base64
from rocketlib import IInstanceBase, AVI_ACTION, Entry, error
from .IGlobal import IGlobal
from ai.common.schema import DocMetadata, Doc
from ai.common.avi.descriptor import (
    descriptor_from_payload,
    attach_source,
    attach_name,
    derived_name,
    image_begin_payload,
    image_dims,
)
from ai.common.table import Table

if TYPE_CHECKING:
    from ai.common.avi.frame import VideoFrameExtractor


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    _has_document_listener = False
    _has_image_listener = False

    _reader: 'VideoFrameExtractor' = None

    _watermark: bool = False
    _wm_location: str = ''
    _wm_filename: bool = False
    _wm_timestamp: bool = False
    _source_descriptor = None  # full stream descriptor parsed on the video BEGIN

    # Frames emitted for the current object, across all its video streams. Names and
    # chunk ids come from this rather than from a frame's position in its own video.
    _frame_ordinal: int = 0

    _start_times: list = []

    def beginInstance(self):  # pylint: disable=C0103
        """
        Initialize the frame grabber instance.

        Sets up watermark configuration and creates the video frame extractor.
        """
        from ai.common.avi.frame import VideoFrameExtractor

        # Watermark options (see services.json); absent -> disabled.
        cfg = self.IGlobal.config
        self._watermark = cfg.get('watermark', 'no') == 'yes'
        self._wm_location = cfg.get('watermark_location', 'bottom_right')
        self._wm_filename = cfg.get('watermark_filename', 'yes') == 'yes'
        self._wm_timestamp = cfg.get('watermark_timestamp', 'yes') == 'yes'

        # Full source-video descriptor, parsed from the stream descriptor on BEGIN.
        # Drives both the watermark label and the per-frame source provenance.
        self._source_descriptor = None

        # Create the reader
        self._reader = VideoFrameExtractor(
            frame_callback=self._frame_callback, name='FrameGrabber', config=self.IGlobal.config
        )

    def endInstance(self):  # pylint: disable=C0103
        """End the instance by cleaning up resources."""
        self._reader = None

    def open(self, obj: Entry):
        """Open the video stream for frame extraction.

        Args:
            obj (Entry): The input entry containing the video stream.
        """
        self._start_times = []
        self._frame_ordinal = 0

    def close(self):
        """Close the video stream and generate table output if applicable.

        Generates a markdown table of frame timestamps if the instance has a table listener.
        """
        # If we are listening on tables
        if self.instance.hasListener('table') and len(self._start_times) > 0:
            # Generate the table
            table = Table.generate_markdown_table(
                headers=['Frame', 'Seconds', 'Time Stamp'],
                data=self._start_times,
            )

            # Send it off
            self.instance.writeTable(table)

    def writeVideo(self, action: AVI_ACTION, mimeType: str, buffer: bytes):  # pylint: disable=C0103
        """Write video data to the frame extractor.

        Args:
            action (AVI_ACTION): The AVI action indicating the stream state.
            mimeType (str): The MIME type of the video data.
            buffer (bytes): The video data buffer to process.
        """
        # On BEGIN the buffer holds the stream descriptor (not media). Store the
        # whole descriptor (source-video identity + media detail) for the watermark
        # and per-frame provenance, then hand the reader the buffer unchanged
        # (writeAVI ignores the BEGIN payload, so descriptor bytes never reach ffmpeg).
        if action == AVI_ACTION.BEGIN:
            self._source_descriptor = descriptor_from_payload(buffer)

        # We will use the easy writer which will handler the starting, locking,
        # writing, stopping and unlocking for us based on the action
        self._reader.writeAVI(action, mimeType, buffer)

    @staticmethod
    def _source_label(md: DocMetadata) -> str:
        """Build the watermark source label from the stream descriptor.

        For media extracted from a container it reads 'file @ container' (e.g. the
        file inside a zip); for a standalone file it is just the file name.

        Args:
            md (DocMetadata): The stream descriptor metadata.

        Returns:
            str: The source label, or None if no name is available.
        """

        def base(path):
            return path.replace('\\', '/').rsplit('/', 1)[-1] if path else ''

        inner = base(getattr(md, 'resource_name', None))
        container = base(md.parent)
        if inner and container and getattr(md, 'origin', None) == 'extracted':
            return f'{inner} @ {container}'
        return inner or container or None

    def _image_begin_payload(self, frame_ordinal: int, image_size: int, width=None, height=None) -> bytes:
        """Build the ImageStream BEGIN enrichment for an extracted frame.

        Mirrors the documents lane: top level describes the image stream itself
        (`size` = the frame's own byte length, `origin`, per-frame `name`), while the
        source video's media detail is nested under `source`. The engine assigns the
        image stream_index (the per-frame index).

        Args:
            frame_ordinal (int): The frame's ordinal within the object, used for the name.
                Not its position in the video — one object can carry several video streams,
                whose positions both start at 0 and whose stems match when they share a parent.
            image_size (int): The frame's PNG byte size (the image stream's own size).
            width (int): The frame width in pixels (best-effort; omitted when unknown).
            height (int): The frame height in pixels (best-effort; omitted when unknown).

        Returns:
            bytes: UTF-8 JSON enrichment for the image BEGIN.
        """
        # One-to-many: per-frame name '<stem>.frame<N>.png'. image_begin_payload projects the
        # source video under `source` (nesting any existing chain) and omits absent dims.
        name = derived_name(self._source_descriptor, index=frame_ordinal, marker='frame', ext='png')
        return image_begin_payload(self._source_descriptor, size=image_size, width=width, height=height, name=name)

    def _frame_callback(self, image: bytes, frame_number: int, time_stamp: float):
        """Handle a frame from the video stream.

        Args:
            image (bytes): The raw image data.
            frame_number (int): The frame number in the sequence.
            time_stamp (float): The timestamp of the frame in seconds.

        Returns:
            None
        """

        # Format seconds into a string
        def format_seconds(seconds: float) -> str:
            hours = int(seconds // 3600)
            minutes = int((seconds % 3600) // 60)
            secs = seconds % 60
            return f'{hours:02}:{minutes:02}:{secs:05.2f}'

        # If this is the end of sequence, ignore it
        if image is None:
            return

        # Burn the watermark onto the frame before it is emitted anywhere.
        if self._watermark:
            image = self._apply_watermark(image, format_seconds(time_stamp))

        if self.instance.hasListener('table'):
            # One table covers the whole object, so the Frame column carries the ordinal
            # rather than the position in the video: several videos would otherwise each
            # contribute a row 0, a row 1, and so on, with nothing to tell them apart.
            self._start_times.append([self._frame_ordinal, time_stamp, format_seconds(time_stamp)])

        if self.instance.hasListener('documents'):
            # Create the default metadata for the document
            metadata = DocMetadata(self)

            # chunkId is the frame's ordinal within the object, not its position in the
            # video: one object can carry several video streams, whose positions both
            # start at 0. `frame_number` keeps the true position.
            metadata.chunkId = self._frame_ordinal
            metadata.frame_number = frame_number
            metadata.time_stamp = time_stamp

            # Provenance: the source video's media detail under `source` + a per-frame
            # name '<video-stem>.frame<N>.png' (identity/backlink is already on this
            # frame's own metadata). Both no-op when no descriptor was received.
            attach_source(metadata, self._source_descriptor)
            attach_name(metadata, self._source_descriptor, index=self._frame_ordinal, marker='frame', ext='png')

            # Create the document object and save the base64 encoded image
            doc = Doc(type='Image', page_content=base64.b64encode(image).decode('utf-8'), metadata=metadata)

            # Save it
            self.instance.writeDocuments([doc])

        if self.instance.hasListener('image'):
            # The BEGIN buffer carries stream-descriptor enrichment (the frame's own
            # detail + origin + name, with the source video nested); the engine merges
            # it into the ImageStream descriptor for this frame.
            width, height = image_dims(image)
            self.instance.writeImage(
                AVI_ACTION.BEGIN,
                'image/png',
                self._image_begin_payload(self._frame_ordinal, len(image), width, height),
            )
            self.instance.writeImage(AVI_ACTION.WRITE, 'image/png', image)
            self.instance.writeImage(AVI_ACTION.END, 'image/png')

        # Counted per frame, not per listener: both lanes above name the frame by this
        # ordinal, so it advances once for the frame regardless of who is listening.
        self._frame_ordinal += 1

    def _apply_watermark(self, image: bytes, timestamp_text: str) -> bytes:
        """Apply a watermark to the image.

        Args:
            image (bytes): The raw image data.
            timestamp_text (str): The timestamp text to include in the watermark.

        Returns:
            bytes: The watermarked image data.
        """
        # Compose the label from the enabled parts (source label + timestamp).
        # The source label is derived from the stored descriptor (single source of truth).
        parts = []
        source_label = (
            self._source_label(self._source_descriptor.metadata) if self._source_descriptor is not None else None
        )
        if self._wm_filename and source_label:
            parts.append(source_label)
        if self._wm_timestamp:
            parts.append(timestamp_text)
        if not parts:
            return image

        text = ' · '.join(parts)
        try:
            import io
            from PIL import Image, ImageDraw, ImageFont

            img = Image.open(io.BytesIO(image)).convert('RGB')
            draw = ImageDraw.Draw(img)
            width, height = img.size

            # Font scales with resolution; white text + black stroke reads on any
            # background without inspecting the pixels (v1).
            font_size = max(14, round(height * 0.03))

            def load_font(size):
                try:
                    return ImageFont.truetype('DejaVuSans.ttf', size)
                except Exception:
                    return ImageFont.load_default(size=size)

            def measure(font, stroke):
                left, top, right, bottom = draw.textbbox((0, 0), text, font=font, stroke_width=stroke)
                return right - left, bottom - top

            font = load_font(font_size)
            stroke = max(1, font_size // 10)
            text_w, text_h = measure(font, stroke)
            margin = font_size

            # Shrink the label (down to a floor) so long source names / small frames
            # don't push it off-frame; margin scales with the font.
            while font_size > 10 and (text_w + 2 * margin > width or text_h + 2 * margin > height):
                font_size = max(10, int(font_size * 0.85))
                font = load_font(font_size)
                stroke = max(1, font_size // 10)
                margin = font_size
                text_w, text_h = measure(font, stroke)

            x = margin if 'left' in self._wm_location else width - text_w - margin
            y = margin if 'top' in self._wm_location else height - text_h - margin
            # Clamp so the label always starts on-frame even at the size floor.
            x = max(0, min(x, width - text_w))
            y = max(0, min(y, height - text_h))

            draw.text((x, y), text, font=font, fill='white', stroke_width=stroke, stroke_fill='black')

            out = io.BytesIO()
            img.save(out, format='PNG')
            return out.getvalue()
        except Exception as e:
            # Best-effort: never drop the frame if watermarking fails.
            error(f'frame_grabber watermark failed: {e}')
            return image
