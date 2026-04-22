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

from rocketlib import IInstanceBase, Entry
from ai.common.schema import Doc
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    Translate text (and timed document segments) between languages.

    - writeText:      accumulates incoming plain text, translates once at close.
    - writeDocuments: translates page_content in a single batch call; passes
                      metadata through untouched so time_stamp / time_stamp_end
                      survive for downstream subtitle rendering.
    """

    IGlobal: IGlobal

    _text_buf: str = ''

    def open(self, object: Entry):
        """
        Reset per-stream state when a new object enters the pipeline.

        Args:
            object (Entry): The entry object beginning processing.

        Returns:
            None.
        """
        self._text_buf = ''

    def writeText(self, text: str):
        """
        Accumulate plain text from upstream until the stream closes.

        Emission is deferred to `closing()` so the whole input is translated
        in a single API call instead of once per chunk.

        Args:
            text (str): Incoming chunk of plain text.

        Returns:
            None.
        """
        self._text_buf += text
        # Defer emission until closing so we translate the full input in one call
        self.preventDefault()

    def writeDocuments(self, docs):
        """
        Translate a batch of timed document segments and emit them downstream.

        Preserves each Doc's `metadata` object unchanged so fields like
        `time_stamp` / `time_stamp_end` flow through for subtitle timing.

        Args:
            docs (list[Doc]): Source-language segments to translate.

        Returns:
            None.
        """
        if not docs:
            self.instance.writeDocuments(docs)
            return

        translated = self.IGlobal.translator.translate_batch([d.page_content for d in docs])
        out = [Doc(page_content=t, metadata=d.metadata) for t, d in zip(translated, docs)]
        self.instance.writeDocuments(out)
        self.preventDefault()

    def closing(self):
        """
        Flush the buffered plain text by translating it in one API call and
        emitting the result on the `text` output lane.

        Returns:
            None.
        """
        if self._text_buf:
            result = self.IGlobal.translator.translate(self._text_buf)
            self.instance.writeText(result)
            self._text_buf = ''
