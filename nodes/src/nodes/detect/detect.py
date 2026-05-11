# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import Any, Dict, List
from ai.common.config import Config


class Detector:
    """
    Wraps YOLO-World for fast open-vocabulary object detection.

    Reads model, threshold, and prompt from node config. The prompt is
    split into a class list that YOLO-World uses for open-vocabulary
    detection - no fixed class list required.

    Attributes:
        model_name (str): YOLO-World model variant.
        threshold (float): Minimum confidence score.
        prompt (str): Raw config prompt string.
        classes (List[str]): Parsed class list from prompt.
        model: YOLOWorld instance.
        device (str): Torch device string.
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Load model and configure from provider settings."""
        from ultralytics import YOLOWorld
        from ai.common.torch import torch

        config = Config.getNodeConfig(provider, connConfig)

        self.model_name = config.get('model', 'yolov8s-worldv2')
        self.threshold = float(config.get('threshold', 0.3))
        self.prompt = config.get('prompt', '')

        # Split prompt on periods or commas: "monster . npc . door" → ["monster","npc","door"]
        self.classes = [c.strip() for c in self.prompt.replace('.', ',').split(',') if c.strip()]

        # Device: prefer MPS on Apple Silicon, CUDA on server, CPU as fallback
        if torch.cuda.is_available():
            self.device = 'cuda:0'
        elif torch.backends.mps.is_available():
            self.device = 'mps'
        else:
            self.device = 'cpu'

        self.model = YOLOWorld(f'{self.model_name}.pt')
        self.model.to(self.device)

        if self.classes:
            self.model.set_classes(self.classes)

    def detect(self, image: Any) -> List[Dict[str, Any]]:
        """
        Run open-vocabulary detection on a PIL Image.

        Args:
            image: PIL Image object (RGB).

        Returns:
            List of {label, score, box: {x1,y1,x2,y2}, centroid: {x,y}} dicts.
        """
        if image is None:
            raise ValueError('Image must not be None')

        results = self.model.predict(image, conf=self.threshold, verbose=False, device=self.device)

        detections = []
        for r in results:
            for box in r.boxes:
                x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
                score = float(box.conf[0])
                label = r.names[int(box.cls[0])]
                detections.append(
                    {
                        'label': label,
                        'score': score,
                        'box': {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2},
                        'centroid': {'x': (x1 + x2) / 2.0, 'y': (y1 + y2) / 2.0},
                    }
                )

        return detections
