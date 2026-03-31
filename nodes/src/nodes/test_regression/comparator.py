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

import difflib
import json
import math
import re
from collections import Counter


class Comparator:
    """Compares pipeline output against golden snapshots using exact, fuzzy, or semantic matching."""

    def __init__(self, mode: str = 'exact', threshold: float = 0.95) -> None:  # noqa: D107
        self.mode = mode
        self.threshold = threshold

    def compare(self, golden: str, current: str) -> dict:
        """Compare golden and current content, returning match status, score, and diff."""
        if self.mode == 'exact':
            return self._exact(golden, current)
        elif self.mode == 'fuzzy':
            return self._fuzzy(golden, current)
        elif self.mode == 'semantic':
            return self._semantic(golden, current)
        else:
            raise ValueError(f'Unknown match mode: {self.mode}')

    def _makeDiff(self, golden: str, current: str) -> str:
        """Generate a unified diff between golden and current content."""
        golden_lines = golden.splitlines(keepends=True)
        current_lines = current.splitlines(keepends=True)
        diff = difflib.unified_diff(golden_lines, current_lines, fromfile='golden', tofile='current', lineterm='')
        return '\n'.join(diff)

    def _exact(self, golden: str, current: str) -> dict:
        """Exact comparison — attempts JSON-normalized equality first, falls back to string."""
        try:
            golden_obj = json.loads(golden)
            current_obj = json.loads(current)
            is_match = golden_obj == current_obj
        except (json.JSONDecodeError, TypeError):
            is_match = golden == current

        score = 1.0 if is_match else 0.0
        result = {'match': is_match, 'score': score}
        if not is_match:
            result['diff'] = self._makeDiff(golden, current)
        return result

    def _fuzzy(self, golden: str, current: str) -> dict:
        """Fuzzy comparison using SequenceMatcher ratio."""
        score = difflib.SequenceMatcher(None, golden, current).ratio()
        is_match = score >= self.threshold
        result = {'match': is_match, 'score': score}
        if not is_match:
            result['diff'] = self._makeDiff(golden, current)
        return result

    def _semantic(self, golden: str, current: str) -> dict:
        """Semantic comparison using TF-IDF cosine similarity (stdlib only)."""
        score = self._tfidfCosine(golden, current)
        is_match = score >= self.threshold
        result = {'match': is_match, 'score': score}
        if not is_match:
            result['diff'] = self._makeDiff(golden, current)
        return result

    def _tokenize(self, text: str) -> list[str]:
        """Tokenize text using whitespace and punctuation splitting with lowercasing."""
        return re.findall(r'[a-z0-9]+', text.lower())

    def _tfidfCosine(self, text_a: str, text_b: str) -> float:
        """Compute TF-IDF cosine similarity between two documents using only stdlib."""
        tokens_a = self._tokenize(text_a)
        tokens_b = self._tokenize(text_b)

        if not tokens_a or not tokens_b:
            return 0.0

        # Term frequency per document
        tf_a = Counter(tokens_a)
        tf_b = Counter(tokens_b)

        # Document frequency (out of 2 documents)
        all_terms = set(tf_a.keys()) | set(tf_b.keys())
        df: dict[str, int] = {}
        for term in all_terms:
            df[term] = (1 if term in tf_a else 0) + (1 if term in tf_b else 0)

        # IDF: log(N / df) where N = 2
        num_docs = 2
        idf = {term: math.log(num_docs / count) for term, count in df.items()}

        # TF-IDF vectors
        vec_a = {term: freq * idf[term] for term, freq in tf_a.items()}
        vec_b = {term: freq * idf[term] for term, freq in tf_b.items()}

        # Cosine similarity
        dot = sum(vec_a.get(t, 0.0) * vec_b.get(t, 0.0) for t in all_terms)
        mag_a = math.sqrt(sum(v * v for v in vec_a.values()))
        mag_b = math.sqrt(sum(v * v for v in vec_b.values()))

        if mag_a == 0.0 or mag_b == 0.0:
            return 0.0

        return dot / (mag_a * mag_b)
