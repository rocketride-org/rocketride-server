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

import base64
from rocketlib import IInstanceBase, AVI_ACTION, Entry
from .IGlobal import IGlobal
from ai.common.schema import DocMetadata, Doc
from ai.common.table import Table

_LOG = '/tmp/brandy_pipeline.log'


def _plog(msg: str) -> None:
    import datetime

    line = f'[{datetime.datetime.now().isoformat(timespec="milliseconds")}] [frame_grabber] {msg}\n'
    with open(_LOG, 'a') as f:
        f.write(line)


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    _has_document_listener = False
    _has_image_listener = False

    def beginInstance(self):
        from ai.common.avi.frame import VideoFrameExtractor

        # Create the reader
        self._reader = VideoFrameExtractor(frame_callback=self._frame_callback, name='FrameGrabber', config=self.IGlobal.config)

    def endInstance(self):
        # Release the reader
        self._reader = None

    def open(self, obj: Entry):
        _plog(f'open: name={obj.name!r}')
        # Reset the start times
        self._startTimes = []
        self._prev_frame = None

    def close(self):
        _plog(f'close: total_frames={len(self._startTimes)}')
        # If we are listening on tables
        if self.instance.hasListener('table') and len(self._startTimes) > 0:
            # Generate the table
            table = Table.generate_markdown_table(
                headers=['Frame', 'Seconds', 'Time Stamp'],
                data=self._startTimes,
            )

            # Send it off
            self.instance.writeTable(table)

    def _frame_callback(self, image: bytes, frame_number: int, time_stamp: float):
        # Format seconds into a string
        def format_seconds(seconds: float) -> str:
            hours = int(seconds // 3600)
            minutes = int((seconds % 3600) // 60)
            secs = seconds % 60
            return f'{hours:02}:{minutes:02}:{secs:05.2f}'

        # If this is the end of sequence, ignore it
        if image is None:
            return

        if self.instance.hasListener('table'):
            # Add the start time
            self._startTimes.append([frame_number, time_stamp, format_seconds(time_stamp)])

        if self.instance.hasListener('documents'):
            # Compute scene change score vs previous frame (grayscale mean-abs-diff, 0–1)
            scene_score = 0.0
            if self._prev_frame is not None:
                import io
                import numpy as np
                from PIL import Image

                a = np.array(Image.open(io.BytesIO(self._prev_frame)).convert('L'), dtype=np.float32)
                b = np.array(Image.open(io.BytesIO(image)).convert('L'), dtype=np.float32)
                scene_score = float(np.mean(np.abs(a - b))) / 255.0
            self._prev_frame = image

            # Create the default metadata for the document
            metadata = DocMetadata(self)

            # Save the frame, time stamp, and scene score in the metadata
            metadata.chunkId = frame_number
            metadata.time_stamp = time_stamp
            metadata.scene_change_score = scene_score

            # Create the document object and save the base64 encoded image
            doc = Doc(type='Image', page_content=base64.b64encode(image).decode('utf-8'), metadata=metadata)

            # Save it
            self.instance.writeDocuments([doc])

        if self.instance.hasListener('image'):
            _plog(f'frame: frame_number={frame_number} time_stamp={time_stamp:.3f}')
            # Send the image
            self.instance.writeImage(AVI_ACTION.BEGIN, 'image/png')
            self.instance.writeImage(AVI_ACTION.WRITE, 'image/png', image)
            self.instance.writeImage(AVI_ACTION.END, 'image/png')

    def writeVideo(self, action: AVI_ACTION, mimeType: str, buffer: bytes):
        # We will use the easy writer which will handler the starting, locking,
        # writing, stopping and unlocking for us based on the action
        self._reader.writeAVI(action, mimeType, buffer)
