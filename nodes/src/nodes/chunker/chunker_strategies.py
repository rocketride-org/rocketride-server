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

"""Chunking strategies for splitting text into sized chunks with metadata."""

from __future__ import annotations

import re
from typing import Optional


class ChunkingStrategy:
    """Base class for text chunking strategies."""

    def chunk(self, text: str) -> list[dict]:
        """Return list of {'text': str, 'metadata': {'chunk_index': int, 'start_char': int, 'end_char': int}}."""
        raise NotImplementedError


class RecursiveCharacterChunker(ChunkingStrategy):
    """Split text recursively by separators with overlap."""

    def __init__(self, chunk_size: int = 1000, chunk_overlap: int = 200, separators: Optional[list[str]] = None):
        """Initialize with chunk size, overlap, and optional separators."""
        if chunk_size <= 0:
            raise ValueError('chunk_size must be positive')
        if chunk_overlap < 0:
            raise ValueError('chunk_overlap must be non-negative')
        if chunk_overlap >= chunk_size:
            raise ValueError('chunk_overlap must be less than chunk_size')
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.separators = separators if separators is not None else ['\n\n', '\n', '. ', ' ', '']

    def _split_text(self, text: str, separators: list[str]) -> list[str]:
        """Recursively split text by the first effective separator."""
        if not text:
            return []

        # If text fits within chunk_size, return as-is
        if len(text) <= self.chunk_size:
            return [text]

        # If no separators left, hard-split by chunk_size
        if not separators:
            chunks = []
            start = 0
            while start < len(text):
                end = min(start + self.chunk_size, len(text))
                chunks.append(text[start:end])
                start = end
            return chunks

        separator = separators[0]
        remaining_separators = separators[1:]

        # Split by the current separator
        if separator == '':
            # Empty separator means split char-by-char; fall through to hard-split
            parts = list(text)
        else:
            parts = text.split(separator)

        # Merge parts into chunks that respect chunk_size
        chunks = []
        current = ''
        for i, part in enumerate(parts):
            # Build the candidate string
            if current:
                candidate = current + separator + part
            else:
                candidate = part

            if len(candidate) <= self.chunk_size:
                current = candidate
            else:
                # Current chunk is ready (if non-empty)
                if current:
                    chunks.append(current)
                # If this single part exceeds chunk_size, recurse with next separators
                if len(part) > self.chunk_size:
                    sub_chunks = self._split_text(part, remaining_separators)
                    chunks.extend(sub_chunks)
                    current = ''
                else:
                    current = part

        # Don't forget the last accumulated chunk
        if current:
            chunks.append(current)

        return chunks

    def chunk(self, text: str) -> list[dict]:
        """Split text recursively and add overlap between consecutive chunks."""
        if not text or not text.strip():
            return []

        raw_chunks = self._split_text(text, self.separators)
        if not raw_chunks:
            return []

        # Apply overlap between consecutive chunks
        result = []
        chunk_index = 0
        search_start = 0
        for i, raw in enumerate(raw_chunks):
            # Compute overlap prefix from the previous chunk
            if i > 0 and self.chunk_overlap > 0:
                prev = raw_chunks[i - 1]
                overlap_text = prev[-self.chunk_overlap :]
                chunk_text = overlap_text + raw
            else:
                chunk_text = raw

            # Find start_char position in original text
            start_char = text.find(raw, search_start)
            if start_char == -1:
                start_char = search_start
            # Adjust for overlap prefix
            if i > 0 and self.chunk_overlap > 0:
                overlap_start = max(0, start_char - self.chunk_overlap)
                start_char = overlap_start
            end_char = start_char + len(chunk_text)

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
            # Advance search to after this raw chunk for the next find
            raw_start = text.find(raw, search_start)
            if raw_start >= 0:
                search_start = raw_start + len(raw)

        return result


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

            # If adding this sentence exceeds chunk_size and we have content, finalize current
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

    def chunk(self, text: str) -> list[dict]:
        """Split text by token count with overlap, decoding back to text."""
        if not text or not text.strip():
            return []

        encoder = self._get_encoder()
        tokens = encoder.encode(text)

        if not tokens:
            return []

        result = []
        chunk_index = 0
        start = 0
        step = self.chunk_size - self.chunk_overlap

        # Ensure we advance at least 1 token per iteration
        if step <= 0:
            step = 1

        # Pre-compute cumulative character lengths for each token position to avoid
        # O(n^2) prefix decoding. We decode each step-sized segment once and track
        # the running character offset.
        # Cache: token start index -> cumulative character position
        char_pos_cache: dict[int, int] = {0: 0}

        while start < len(tokens):
            end = min(start + self.chunk_size, len(tokens))
            chunk_tokens = tokens[start:end]

            # Decode tokens back to text, handling errors gracefully
            try:
                chunk_text = encoder.decode(chunk_tokens)
            except Exception:
                chunk_text = encoder.decode(chunk_tokens, errors='replace')

            # Use cached character position for start_char (O(1) lookup)
            start_char = char_pos_cache.get(start)
            if start_char is None:
                # Fallback: decode prefix (should not happen with correct step caching)
                prefix_text = encoder.decode(tokens[:start])
                start_char = len(prefix_text)
                char_pos_cache[start] = start_char
            end_char = start_char + len(chunk_text)

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

            # Pre-compute the character position for the next step start
            next_start = start + step
            if next_start not in char_pos_cache and next_start < len(tokens):
                # Decode only the step-sized segment to get its character length
                step_tokens = tokens[start:next_start]
                try:
                    step_text = encoder.decode(step_tokens)
                except Exception:
                    step_text = encoder.decode(step_tokens, errors='replace')
                char_pos_cache[next_start] = start_char + len(step_text)

            # Advance by step (chunk_size - overlap)
            start += step

            # If we've reached the end, stop
            if end >= len(tokens):
                break

        return result
