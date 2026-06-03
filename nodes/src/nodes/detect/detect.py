# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import Any, Dict, List, Optional

from rocketlib import warning
from ai.common.config import Config


# Engine keys → default HuggingFace / package model IDs.
ENGINE_DEFAULTS: Dict[str, str] = {
    'rfdetr': 'PekingU/rtdetr_r50vd',
    'mmgdino': 'IDEA-Research/grounding-dino-tiny',
}

# Engines that require a prompt to do anything useful.
OPEN_VOCAB_ENGINES = {'mmgdino'}


class Detector:
    """
    Object detector facade — RF-DETR (closed-set, default) or MM-Grounding-DINO (open-vocab).

    - ``rfdetr``   RF-DETR closed-set, 80 COCO classes. No prompt needed.
    - ``mmgdino``  Grounding-DINO open-vocab. Requires a prompt.

    Returns canonical detection dicts:
    ``[{label, score, box: {x1, y1, x2, y2}, centroid: {x, y}}]``.

    Attributes:
        engine (str): Selected detection engine key.
        model_name (str): Backing HuggingFace model identifier.
        threshold (float): Minimum confidence score.
        prompt (str): Raw config prompt string (open-vocab only).
        classes (List[str]): Parsed class list from prompt.
        loader: Underlying engine loader instance exposing ``detect``.
        device (str): Torch device string the loader is using.
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Resolve engine + model from config and lazily construct the loader."""
        from ai.common.torch import torch  # noqa: F401  (ensure torch is set up)

        config = Config.getNodeConfig(provider, connConfig)

        self.engine = str(config.get('engine', 'rfdetr')).lower().strip()
        if self.engine not in ENGINE_DEFAULTS:
            warning(f'detect: unknown engine "{self.engine}", defaulting to rfdetr')
            self.engine = 'rfdetr'

        # Probe multiple plausible locations for the prompt — UI config plumbing
        # may surface conditional fields under prefixed keys or inside profile dicts.
        self.prompt = (
            config.get('prompt') or connConfig.get('detect.prompt') or connConfig.get('prompt') or ''
        ).strip()

        warning(
            f'detect: __init__ engine={self.engine!r} prompt={self.prompt!r} '
            f'config_keys={sorted(config.keys())[:30]} '
            f'connConfig_keys={sorted(connConfig.keys())[:30]}'
        )

        self.threshold = float(config.get('threshold', 0.3))

        self.model_name = ENGINE_DEFAULTS[self.engine]

        # Parse prompt: "person . car . dog" → ["person", "car", "dog"]
        self.classes: List[str] = [c.strip() for c in self.prompt.replace('.', ',').split(',') if c.strip()]

        # Open-vocab engines need a prompt. The UI marks `detect.prompt` as
        # required (optional: false) for the mmgdino profile, so reaching this
        # branch means either an out-of-band config or a UI/save race. Fail
        # loud — the previous silent fallback to RF-DETR masked real bugs and
        # cascaded into harder-to-diagnose import errors.
        if self.engine in OPEN_VOCAB_ENGINES and not self.classes:
            raise ValueError(
                f'detect: engine "{self.engine}" requires a non-empty prompt '
                '(detect.prompt). Set a prompt in the UI (e.g. "person . car . dog") '
                'and fully restart the pipeline.'
            )

        self.loader = self._build_loader()
        self.device = getattr(self.loader, 'device', 'cpu')

    def _build_loader(self):
        """Construct the right loader for the resolved engine."""
        from ai.common.models.detection.detection import (
            MmGDinoLoader,
            RFDetrLoader,
        )

        if self.engine == 'mmgdino':
            return MmGDinoLoader(model_name=self.model_name, threshold=self.threshold)
        return RFDetrLoader(model_name=self.model_name, threshold=self.threshold)

    def detect(self, image: Any) -> List[Dict[str, Any]]:
        """
        Run object detection on a PIL Image.

        Returns:
            List of canonical detection dicts:
            ``[{label, score, box: {x1, y1, x2, y2}, centroid: {x, y}}]``.
        """
        if image is None:
            raise ValueError('Image must not be None')

        prompt: Optional[str] = self.prompt if self.classes else None
        return self.loader.detect(image, prompt)
