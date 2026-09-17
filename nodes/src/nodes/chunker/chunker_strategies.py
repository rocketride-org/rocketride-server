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

"""Chunking strategies for splitting text into sized chunks with metadata.

Scope: this module deliberately implements only the two strategies the engine
does not already have. Recursive character splitting is *not* here -- the
``preprocessor_langchain`` node already exposes LangChain's
``RecursiveCharacterTextSplitter`` (see its ``default``/``recursive`` profiles),
so reimplementing it would give the product two ways to do the same thing.
Reach for that node for recursive splitting; reach for this one for real
tokenizer-accurate windows (``TokenChunker``) or dependency-free sentence
grouping (``SentenceChunker``).
"""

from __future__ import annotations

import re
from array import array
from bisect import bisect_right


class ChunkingStrategy:
    """Base class for text chunking strategies."""

    def chunk(self, text: str) -> list[dict]:
        """Return list of {'text': str, 'metadata': {'chunk_index': int, 'start_char': int, 'end_char': int}}."""
        raise NotImplementedError


class SentenceChunker(ChunkingStrategy):
    """Split at sentence boundaries, respecting chunk_size."""

    # Matches sentence-ending punctuation followed by whitespace or end-of-string
    _SENTENCE_RE = re.compile(r'(?<=[.!?])\s+')

    def __init__(self, chunk_size: int = 1000, chunk_overlap: int = 200):
        """Initialize with chunk size and overlap."""
        if chunk_size <= 0:
            raise ValueError('chunk_size must be positive')
        if chunk_overlap < 0:
            raise ValueError('chunk_overlap must be non-negative')
        if chunk_overlap >= chunk_size:
            raise ValueError('chunk_overlap must be less than chunk_size')
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def chunk(self, text: str) -> list[dict]:
        """Split text on sentence boundaries and group into sized chunks."""
        if not text or not text.strip():
            return []

        sentences = self._SENTENCE_RE.split(text)
        # Filter out empty sentences
        sentences = [s for s in sentences if s.strip()]
        if not sentences:
            return []

        result = []
        chunk_index = 0
        current_sentences: list[str] = []
        # Track where each sentence starts in the original text to handle repeated sentences
        sentence_positions: list[int] = []
        search_start = 0
        sentence_start_map: list[int] = []
        for sentence in sentences:
            pos = text.find(sentence, search_start)
            if pos == -1:
                pos = search_start
            sentence_start_map.append(pos)
            search_start = pos + len(sentence)

        def _span_len(positions: list[int], sents: list[str]) -> int:
            """Compute the actual text span from first position to end of last sentence."""
            if not positions:
                return 0
            return (positions[-1] + len(sents[-1])) - positions[0]

        for sent_idx, sentence in enumerate(sentences):
            next_pos = sentence_start_map[sent_idx]

            # Compute what the span would be if we added this sentence
            if current_sentences:
                candidate_len = (next_pos + len(sentence)) - sentence_positions[0]
            else:
                candidate_len = len(sentence)

            # If adding this sentence exceeds chunk_size and we have content,
            # finalize current. The ``current_sentences`` guard means a single
            # sentence longer than chunk_size is never split mid-sentence: it is
            # emitted whole as its own chunk (sentence boundaries take priority
            # over the size limit for this strategy).
            if current_sentences and candidate_len > self.chunk_size:
                start_char = sentence_positions[0]
                end_char = sentence_positions[-1] + len(current_sentences[-1])
                chunk_text = text[start_char:end_char]

                result.append(
                    {
                        'text': chunk_text,
                        'metadata': {
                            'chunk_index': chunk_index,
                            'start_char': start_char,
                            'end_char': end_char,
                        },
                    }
                )
                chunk_index += 1

                # Compute overlap: keep trailing sentences whose actual span fits within overlap
                if self.chunk_overlap > 0:
                    overlap_sentences: list[str] = []
                    overlap_positions: list[int] = []
                    for i in range(len(current_sentences) - 1, -1, -1):
                        trial_positions = [sentence_positions[i]] + overlap_positions
                        trial_sentences = [current_sentences[i]] + overlap_sentences
                        if _span_len(trial_positions, trial_sentences) <= self.chunk_overlap:
                            overlap_sentences = trial_sentences
                            overlap_positions = trial_positions
                        else:
                            break
                    current_sentences = overlap_sentences
                    sentence_positions = overlap_positions
                else:
                    current_sentences = []
                    sentence_positions = []

            # Add the sentence
            current_sentences.append(sentence)
            sentence_positions.append(next_pos)

        # Emit the final chunk
        if current_sentences:
            start_char = sentence_positions[0]
            end_char = sentence_positions[-1] + len(current_sentences[-1])
            chunk_text = text[start_char:end_char]

            result.append(
                {
                    'text': chunk_text,
                    'metadata': {
                        'chunk_index': chunk_index,
                        'start_char': start_char,
                        'end_char': end_char,
                    },
                }
            )

        return result


class TokenChunker(ChunkingStrategy):
    """Split by token count using tiktoken (respects model context windows)."""

    def __init__(self, chunk_size: int = 512, chunk_overlap: int = 50, encoding_name: str = 'cl100k_base'):
        """Initialize with chunk size, overlap, and tiktoken encoding name."""
        if chunk_size <= 0:
            raise ValueError('chunk_size must be positive')
        if chunk_overlap < 0:
            raise ValueError('chunk_overlap must be non-negative')
        if chunk_overlap >= chunk_size:
            raise ValueError('chunk_overlap must be less than chunk_size')
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.encoding_name = encoding_name
        self._encoder = None

    def _get_encoder(self):
        """Lazily initialize the tiktoken encoder."""
        if self._encoder is None:
            import tiktoken

            self._encoder = tiktoken.get_encoding(self.encoding_name)
        return self._encoder

    @staticmethod
    def _token_byte_offsets(encoder, tokens: list[int], source_bytes: bytes) -> array:
        """Return compact cumulative byte offsets after verifying tokenizer bytes."""
        offsets = array('Q', [0])
        byte_offset = 0
        for token_id in tokens:
            try:
                token_bytes = encoder.decode_single_token_bytes(token_id)
            except Exception as exc:  # noqa: BLE001 - tokenizer implementations vary
                raise ValueError(f'Unable to recover bytes for token {token_id}.') from exc

            next_offset = byte_offset + len(token_bytes)
            if source_bytes[byte_offset:next_offset] != token_bytes:
                raise ValueError('Tokenizer byte stream does not match the source text.')
            byte_offset = next_offset
            offsets.append(byte_offset)

        if byte_offset != len(source_bytes):
            raise ValueError('Tokenizer byte stream does not match the source text.')
        return offsets

    def _fit_chunk_end(self, encoder, text: str, start: int, estimated_end: int) -> int:
        """Find a non-empty source prefix that respects the independent token cap."""
        estimated_end = max(start + 1, estimated_end)
        if len(encoder.encode(text[start:estimated_end])) <= self.chunk_size:
            return estimated_end

        first_end = start + 1
        if len(encoder.encode(text[start:first_end])) > self.chunk_size:
            raise ValueError(
                'chunk_size is too small to contain a complete Unicode character '
                f'at character offset {start}; increase chunk_size.'
            )

        # Token counts are normally monotonic for prefixes but need not be
        # strictly so across every BPE merge. The first character is known to
        # fit, which makes this search conservative: it may choose a shorter
        # valid prefix, but it never emits an oversized or empty chunk.
        best = first_end
        low = first_end + 1
        high = estimated_end - 1
        while low <= high:
            candidate = (low + high) // 2
            if len(encoder.encode(text[start:candidate])) <= self.chunk_size:
                best = candidate
                low = candidate + 1
            else:
                high = candidate - 1
        return best

    def _next_start(self, encoder, text: str, start: int, end: int) -> int:
        """Choose a progressing start whose independently encoded overlap fits."""
        if self.chunk_overlap == 0:
            return end

        best = end
        low = start + 1
        high = end
        while low <= high:
            candidate = (low + high) // 2
            if len(encoder.encode(text[candidate:end])) <= self.chunk_overlap:
                best = candidate
                high = candidate - 1
            else:
                low = candidate + 1
        return best

    def chunk(self, text: str) -> list[dict]:
        """Split text by token count with overlap, decoding back to text."""
        if not text or not text.strip():
            return []

        encoder = self._get_encoder()
        tokens = encoder.encode(text)

        if not tokens:
            return []

        source_bytes = text.encode('utf-8')
        token_byte_offsets = self._token_byte_offsets(encoder, tokens, source_bytes)
        del tokens

        result = []
        chunk_index = 0
        start_char = 0
        start_byte = 0

        while start_char < len(text):
            # Use the original token byte stream only to estimate a full-size
            # window. The final cut is always a source character boundary and
            # is independently re-tokenized, because BPE merges can cross
            # character boundaries and change when a substring is isolated.
            start_token = bisect_right(token_byte_offsets, start_byte) - 1
            target_token = min(start_token + self.chunk_size, len(token_byte_offsets) - 1)
            target_byte = token_byte_offsets[target_token]
            estimated_text = source_bytes[start_byte:target_byte].decode('utf-8', errors='ignore')
            estimated_end = start_char + len(estimated_text)
            end_char = self._fit_chunk_end(encoder, text, start_char, estimated_end)
            chunk_text = text[start_char:end_char]

            result.append(
                {
                    'text': chunk_text,
                    'metadata': {
                        'chunk_index': chunk_index,
                        'start_char': start_char,
                        'end_char': end_char,
                    },
                }
            )
            chunk_index += 1

            if end_char >= len(text):
                break

            next_start = self._next_start(encoder, text, start_char, end_char)
            start_byte += len(text[start_char:next_start].encode('utf-8'))
            start_char = next_start

        return result
