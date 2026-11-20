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
Instance handler for the Anomaly Detector node.

Every key the detector reads is this call's (``self.settings``): the method,
its sensitivity, window size and thresholds, the metric field and the series
may differ from one call to the next on one control. Each series keeps one
detector, its window, in ``self.state`` (plan 5.7, section 12): a call takes
the series' lock, rebuilds the detector from the stored window, scores its
values in order and writes the window back. The IGlobal holds nothing, so any
replica that serves the series scores it from the same history.
"""

from typing import Any, Dict, List, Mapping

from rocketlib import Entry, IInstanceBase

from ai.common.schema import Doc

from .detector import AnomalyDetector


def series_key(node_id: str, series: str) -> str:
    """
    The node's own part of a series' state key.

    The server prefixes it with the control's owner and address; the node
    id keeps two detectors of one pipeline apart.

    Args:
        node_id: The component id (``config.node.id``).
        series: The series name.

    Returns:
        The key.
    """
    return f'anomaly:{node_id}:{series}'


class IInstance(IInstanceBase):
    """
    Instance handler for Anomaly Detector node.

    Processes individual documents and text, checking numeric values
    for anomalies and annotating results with severity classifications.
    """

    def open(self, obj: Entry):
        """Initialize instance for a new object."""
        pass

    def _series_of(self, metadata: Mapping[str, Any]) -> str:
        """
        The series a document's value belongs to.

        Args:
            metadata: The document's metadata.

        Returns:
            The metadata value named by ``seriesField``, else the call's ``series``.
        """
        field = self.settings.seriesField
        if field:
            named = metadata.get(field)
            if named is not None and str(named) != '':
                return str(named)
        return self.settings.series

    def _with_detector(self, series: str, score) -> Any:
        """
        Run ``score(detector)`` on a series' detector under its lock, writing the window back.

        Args:
            series: The series name.
            score: ``(AnomalyDetector) -> result``; scores the call's values in order.

        Returns:
            What ``score`` returned.
        """
        key = series_key(self.settings.node.id, series)
        with self.state.lock(key):
            detector = AnomalyDetector(self.settings, self.state.get(key))
            result = score(detector)
            if detector.changed:
                self.state.put(key, detector.to_state())
        return result

    def writeText(self, text: str):
        """
        Process text and check for anomalous numeric values.

        Attempts to parse numeric values from text, runs anomaly detection
        on the call's series, and annotates the output with detection results.
        Text with no number passes through without touching the series.
        """
        # preventDefault() raises, so it goes after the forward it guards
        if AnomalyDetector.text_value(text) is None:
            result = text
        else:
            result = self._with_detector(self.settings.series, lambda detector: detector.evaluate_text(text))
        self.instance.writeText(result)
        return self.preventDefault()

    def writeDocuments(self, documents: List[Doc]):
        """
        Process documents and check metric fields for anomalies.

        Reads the call's metric field from each document's metadata, scores
        each series' values in document order under that series' lock, and
        adds the results to the copies it forwards.
        """
        # Step 1: copies, and each document's metadata and series
        enriched: List[Doc] = [doc.model_copy(deep=True) for doc in documents]
        metadata: Dict[int, Dict[str, Any]] = {}
        by_series: Dict[str, List[int]] = {}
        for index, doc in enumerate(enriched):
            if doc.metadata is None:
                continue
            metadata[index] = doc.metadata.model_dump()
            by_series.setdefault(self._series_of(metadata[index]), []).append(index)

        # Step 2: one read-modify-write per series
        results: Dict[int, Dict[str, Any]] = {}
        for series, indexes in by_series.items():

            def score(detector: AnomalyDetector, indexes=indexes) -> None:
                for index in indexes:
                    results[index] = detector.evaluate_document(metadata[index])

            self._with_detector(series, score)

        # Step 3: annotate and forward; preventDefault() suppresses the engine's
        # own forward of the un-enriched originals
        for index, result in results.items():
            target = enriched[index].metadata
            target.anomaly_score = result['score']
            target.anomaly_severity = result['severity']
            target.anomaly_is_anomalous = result['is_anomalous']
            if result.get('details'):
                target.anomaly_details = result['details']
        self.instance.writeDocuments(enriched)
        return self.preventDefault()

    def closing(self):
        """Finalize any pending operations before close."""
        pass

    def close(self):
        """Clean up instance state."""
        pass
