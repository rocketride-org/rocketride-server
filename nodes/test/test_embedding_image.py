"""
Tests for the embedding_image node (in skip_nodes: excluded from default run).

Requires ai.common.models.vision. Marked @pytest.mark.skip_node so they are
excluded by default (same as other skip_nodes). Run with:

    builder nodes:test-full --pytest="-m skip_node -k embedding_image"
    pytest nodes/test/test_embedding_image.py -v -m skip_node
"""

import sys
from pathlib import Path

import pytest

# Add server dist so we can import from nodes and ai
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / 'dist' / 'server'))


def _vision_available():
    """Check if ai.common.models.vision is available."""
    try:
        from ai.common.models.vision import CLIPModel, ViTModel  # noqa: F401
        return True
    except ImportError:
        return False


@pytest.mark.skip_node
def test_embedding_image_create_embedding():
    """
    Test that the embedding_image node's Embedding class produces a normalized
    embedding from a small image. Skips if vision module is not implemented.
    """
    if not _vision_available():
        pytest.skip('ai.common.models.vision not available')

    from PIL import Image
    import numpy as np

    # Minimal 224x224 RGB image (typical CLIP/ViT input size)
    arr = np.zeros((224, 224, 3), dtype=np.uint8)
    arr[:] = 128
    pil_image = Image.fromarray(arr)

    # Use the same embedding class the node uses
    from nodes.embedding_image.embedding import Embedding
    from ai.common.config import Config

    # Minimal config: provider and connConfig with default model
    provider = 'embedding_image'
    connConfig = {
        'embedding_image': {
            'model': 'openai/clip-vit-base-patch16',
        },
    }
    bag = {}

    embedding_driver = Embedding(provider, connConfig, bag)

    # Node uses create_image_embedding(Image) -> List[float]
    result = embedding_driver.create_image_embedding(pil_image)

    assert isinstance(result, list), f'Expected list of floats, got {type(result)}'
    assert len(result) > 0, 'Embedding should not be empty'
    assert all(isinstance(x, (int, float)) for x in result), 'Embedding should be numeric'

    arr = np.array(result, dtype=np.float64)
    norm = np.linalg.norm(arr)
    assert 0.99 < norm < 1.01, f'Expected normalized embedding, got norm={norm:.4f}'
    assert arr.ndim == 1, f'Expected 1D embedding, got shape {arr.shape}'
