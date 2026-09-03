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

from rocketlib import IInstanceBase, warning, debug
from ai.common.schema import Answer
from .IGlobal import IGlobal
from .connectors.sec import query_sec

import re
import json
import math

_PERIOD_FILTER_KEYS = ('form', 'fy', 'fp', 'end', 'unit', 'frame')


def _normalize_number(value_str: str) -> float | None:
    """Strip currency symbols, commas, and spaces, then parse to float.

    Handles parenthesized negatives and scale suffixes (M, k, B, in thousands).
    Parentheses are unwrapped before suffix stripping so values like '(1.5m)' scale.
    """
    clean_str = value_str.strip().lower()

    # Handle "in thousands", "in millions", etc.
    scale = 1.0
    if 'in thousands' in clean_str:
        scale = 1_000.0
        clean_str = clean_str.replace('in thousands', '')
    elif 'in millions' in clean_str:
        scale = 1_000_000.0
        clean_str = clean_str.replace('in millions', '')
    elif 'in billions' in clean_str:
        scale = 1_000_000_000.0
        clean_str = clean_str.replace('in billions', '')

    # Remove currency, commas, and spaces
    clean_str = re.sub(r'[\$€£¥,\s]', '', clean_str)

    # Handle parenthesized negatives: (1.5) -> -1.5  (before k/m/b suffixes)
    if clean_str.startswith('(') and clean_str.endswith(')'):
        clean_str = '-' + clean_str[1:-1]

    # Handle k, m, b suffixes
    if clean_str.endswith('k'):
        scale *= 1_000.0
        clean_str = clean_str[:-1]
    elif clean_str.endswith('m'):
        scale *= 1_000_000.0
        clean_str = clean_str[:-1]
    elif clean_str.endswith('b'):
        scale *= 1_000_000_000.0
        clean_str = clean_str[:-1]

    try:
        return float(clean_str) * scale
    except ValueError:
        return None


def _period_filters(payload: dict) -> dict:
    """Pull optional SEC period/unit filters from the answer payload."""
    filters = {}
    for key in _PERIOD_FILTER_KEYS:
        if key not in payload:
            continue
        value = payload[key]
        if value in (None, ''):
            continue
        filters[key] = value
    return filters


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def __init__(self):
        super().__init__()

    def writeText(self, text: str):
        """Handle raw text input (used by the test framework).

        The test framework sends data on the ``text`` lane as a plain
        string. This handler parses the JSON payload, constructs a
        proper ``Answer`` object, and delegates to ``writeAnswers``.
        On a match, emit the Answer on the answers lane and suppress
        the default text forward so the original JSON string is not
        also passed downstream.
        """
        text = text.strip()
        if not text:
            warning('Abstaining: empty text received')
            self.preventDefault()
            return

        # Build a real Answer so the rest of the pipeline sees the same type
        answer = Answer()
        answer.setAnswer(text)
        self.writeAnswers(answer)
        # writeAnswers returned normally => match. Convert text -> answers.
        self.instance.writeAnswers(answer)
        self.preventDefault()

    def writeAnswers(self, answer: Answer):
        """Run authoritative cross-check on the answer.

        Extracts the answer text and attempts to verify it against the
        configured regulator database. If the official data does not match,
        the node abstains (drops the answer). On a match this method returns
        normally so the engine forwards the unchanged answer once — do not
        also call ``self.instance.writeAnswers``, or the answer is emitted twice.
        """
        regulator_type = self.IGlobal.regulator_type

        # We expect a JSON answer with a 'concept' and a 'value'
        try:
            payload = None
            text_val = answer.getText()

            if answer.isJson():
                payload = answer.getJson()
            else:
                if isinstance(text_val, dict):
                    payload = text_val
                else:
                    payload = json.loads(text_val)

            if not isinstance(payload, dict):
                raise ValueError(f'Payload is not a dictionary, it is {type(payload)}')

            concept = str(payload.get('concept', ''))
            text = str(payload.get('value', ''))
            filters = _period_filters(payload)
        except Exception as e:
            warning(f"Abstaining: Expected JSON answer with 'concept' and 'value'. Error: {e}")
            self.preventDefault()
            return

        text = text.strip()
        concept = concept.strip()

        if not text or not concept:
            warning('Abstaining: Missing concept or value in answer')
            self.preventDefault()
            return

        if not filters:
            warning(
                'Abstaining: no filing period specified; provide form, fy, fp, or end '
                'so the match is scoped to a single report.'
            )
            self.preventDefault()
            return

        normalized_text = _normalize_number(text)
        if normalized_text is None:
            warning(f"Abstaining: Could not normalize extracted text '{text}' into a number.")
            self.preventDefault()
            return

        if regulator_type != 'sec':
            warning(f'Unknown regulator type: {regulator_type}')
            self.preventDefault()
            return

        try:
            official_data = query_sec(concept, cik=self.IGlobal.cik, filters=filters)
        except Exception as e:
            warning(f'Failed to query {regulator_type} connector: {str(e)}')
            self.preventDefault()
            return

        if not official_data:
            warning(
                f"Abstaining: Extracted value '{text}' not found in {regulator_type} "
                'authoritative data for the requested period.'
            )
            self.preventDefault()
            return

        if not any(math.isclose(normalized_text, v, rel_tol=1e-9, abs_tol=1e-6) for v in official_data):
            warning(
                f"Abstaining: Value mismatch. Extracted '{text}' (normalized: {normalized_text}) "
                f'does not match official data from {regulator_type}.'
            )
            self.preventDefault()
            return

        debug(f"Authoritative Match: '{text}' verified against {regulator_type} database.")
