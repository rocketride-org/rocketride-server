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

"""
Web Scraper source endpoint (``scraper_beautifulsoup_source://``).

A finite, self-driving source: it needs no input, so it works as the entry
point of a scheduled deployment (a scheduled fire only starts the task).

Delivery follows the engine's DIRECT pipeline mode, like ``filestore_source``:
``scanObjects`` reports one object per enabled configured source through the
scan callback; the engine opens each on the target pipe and calls
``IInstance.renderObject``, which delegates to :meth:`renderSourceObject`.
That fetches the source and sends:

* ``answers`` — one JSON Answer holding every normalized row of the source
  (a list of dicts, all sources sharing one column set), ready for a ``rocketride_sql`` / ``db_postgres`` node's
  ``answers`` ingestion lane (auto-creates the table from the row shape);
* ``text`` — one plain-text document per item (title, URL, metadata, body).

A source whose every URL fails raises, so the engine marks that object
failed; partial failures are logged as warnings and the rows that did load
are still sent. The task completes when all sources are rendered.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List

from ai.common.schema import Answer
from ai.common.utils import config_int
from rocketlib import IEndpointBase, warning

from .IGlobal import DEFAULT_MAX_BODY_CHARS, build_fetcher
from .scrape_sources import (
    DEFAULT_MAX_ITEMS,
    SourceSpec,
    pad_rows,
    parse_sources,
    row_columns,
    rows_to_text,
    run_source,
)


class IEndpoint(IEndpointBase):
    """Run-once web scraping source."""

    _specs: Dict[str, SourceSpec]
    _columns: List[str]

    def _params(self) -> Dict[str, Any]:
        try:
            return self.endpoint.serviceConfig['parameters'] or {}
        except Exception:
            return {}

    def _load_specs(self) -> List[SourceSpec]:
        params = self._params()
        default_max = config_int(params, 'maxItemsPerSource', DEFAULT_MAX_ITEMS, min_value=1, max_value=5000)
        specs = [s for s in parse_sources(params.get('sources'), default_max) if s.enabled]
        if not specs:
            raise ValueError('Web Scraper source: "sources" must define at least one enabled source')
        return specs

    def validateConfig(self, syntaxOnly: bool) -> None:
        self._load_specs()

    def scanObjects(self, path: str, scanCallback: Callable[[Dict[str, Any]], int]) -> None:
        """Report one object per enabled source; content is fetched at render time."""
        specs = self._load_specs()
        self._specs = {s.name: s for s in specs}
        self._columns = row_columns(specs)
        for spec in specs:
            # A non-zero return means the engine wants the scan stopped.
            if scanCallback({'name': spec.name, 'size': len(spec.urls)}):
                break

    def renderSourceObject(self, entry, instance) -> None:
        """Fetch one source and send its rows on the answers and text lanes."""
        specs = getattr(self, '_specs', None) or {s.name: s for s in self._load_specs()}
        columns = getattr(self, '_columns', None) or row_columns(list(specs.values()))
        name = str(entry.name)
        spec = specs.get(name)
        if spec is None:
            raise ValueError(f'Web Scraper source: unknown source {name!r}')

        params = self._params()
        fetcher = build_fetcher(params)
        max_body = config_int(params, 'maxBodyChars', DEFAULT_MAX_BODY_CHARS, min_value=200)
        result = run_source(spec, fetcher, max_body_chars=max_body)

        for err in result.errors:
            warning(f'Web Scraper [{spec.name}] {err}')
        if not result.rows and result.errors:
            raise RuntimeError(f'Web Scraper [{spec.name}]: every URL failed ({len(result.errors)} errors)')

        if result.rows:
            answer = Answer(expectJson=True)
            answer.setAnswer(pad_rows(result.rows, columns))
            instance.sendAnswers(answer)
            for text in rows_to_text(result.rows):
                instance.sendText(text)

        # Task-mode closes the object pipe itself, but dev-mode leaves closure
        # to the source (same contract as filestore_source / telegram).
        instance.sendClose()
