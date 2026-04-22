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

from typing import List, Optional


class Translator:
    """
    Thin wrapper around Google Cloud Translation v3 TranslationServiceClient.

    Uses API-key authentication. When source language is empty, v3 auto-detects.
    """

    # Max segments/content chars per v3 request (keep comfortably under limits)
    MAX_SEGMENTS = 1024
    MAX_CHARS_PER_REQUEST = 25000

    def __init__(self, apikey: str, source: Optional[str], target: str):
        """
        Build a v3 translation client with API-key auth.

        Args:
            apikey (str): Google Cloud API key with Cloud Translation API enabled.
            source (Optional[str]): BCP-47 source language code. Empty/None enables auto-detect.
            target (str): BCP-47 target language code (e.g., "en", "es").
        """
        from google.cloud import translate_v3

        self._client = translate_v3.TranslationServiceClient(
            client_options={'api_key': apikey},
        )
        # API-key auth does not require a real project; v3 accepts the wildcard parent.
        self._parent = 'projects/-'
        self._source = source or None  # '' -> None -> auto-detect
        self._target = target

    def translate(self, text: str) -> str:
        """
        Translate a single string.

        Args:
            text (str): Source text. Empty string is returned untranslated.

        Returns:
            str: Translated text in the configured target language.
        """
        if not text:
            return ''
        return self.translate_batch([text])[0]

    def translate_batch(self, texts: List[str]) -> List[str]:
        """
        Translate many strings in as few requests as possible.

        Splits into sub-batches to respect segment count and character limits.
        Empty strings pass through untranslated (preserved at the same index).

        Args:
            texts (List[str]): Source strings to translate. Order is preserved.

        Returns:
            List[str]: Translated strings, one per input, in the same order.
        """
        if not texts:
            return []

        results: List[str] = [''] * len(texts)

        # Index/text pairs for non-empty entries only
        pending: List[tuple[int, str]] = [(i, t) for i, t in enumerate(texts) if t]

        batch: List[tuple[int, str]] = []
        batch_chars = 0
        for idx, text in pending:
            text_len = len(text)
            if batch and (len(batch) >= self.MAX_SEGMENTS or batch_chars + text_len > self.MAX_CHARS_PER_REQUEST):
                self._flush(batch, results)
                batch = []
                batch_chars = 0
            batch.append((idx, text))
            batch_chars += text_len

        if batch:
            self._flush(batch, results)

        return results

    def _flush(self, batch: List[tuple[int, str]], results: List[str]) -> None:
        """
        Issue a single v3 translate_text request for one sub-batch and scatter
        the translated strings back into the results list at their original indexes.

        Args:
            batch (List[tuple[int, str]]): (original_index, source_text) pairs to translate.
            results (List[str]): Output buffer; this method writes into it in place.

        Returns:
            None.
        """
        request = {
            'parent': self._parent,
            'contents': [t for _, t in batch],
            'target_language_code': self._target,
            'mime_type': 'text/plain',
        }
        if self._source:
            request['source_language_code'] = self._source

        resp = self._client.translate_text(request=request)
        for (idx, _), translated in zip(batch, resp.translations):
            results[idx] = translated.translated_text
