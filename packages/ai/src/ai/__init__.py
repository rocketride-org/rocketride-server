# ------------------------------------------------------------------------------
# Main module
# ------------------------------------------------------------------------------

"""
Warning Suppression for ML Libraries.

Automatically imported by ai.common.models and model server.
Suppresses third-party warnings unless --verbose is specified.

These warnings are suppressed:
- pkg_resources deprecation (ctranslate2) - setuptools migration, not our code
- TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD info message - expected, our security bypass
- torch.distributed redirect warnings - Windows-specific, harmless
- transformers deprecation warnings - upstream, not our code
"""

import os
import sys
import warnings
import logging
from os.path import dirname, join, realpath
from depends import depends  # type: ignore

# =========================================================================
# ENVIRONMENT VARIABLES (must be set before importing torch)
# =========================================================================

# Ensure HuggingFace shows download progress
os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '0'

# PyTorch 2.6+ security: disable weights_only enforcement for trusted HuggingFace models
os.environ['TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD'] = '1'

# Suppress tokenizers parallelism warning
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

# Disable HuggingFace Hub symlinks
os.environ['HF_HUB_DISABLE_SYMLINKS'] = '1'
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'

# Track if we've already run suppression
_suppressed = False

# Determine if we are in verbose mode
def _is_verbose() -> bool:
    """Check if --verbose or -v flag is present on command line."""
    return '--verbose' in sys.argv or '-v' in sys.argv

# Apply warning suppressions
def _apply_suppressions():
    """Apply all warning suppressions (called once on import)."""
    global _suppressed

    if _suppressed:
        return

    # Check for verbose mode
    if _is_verbose():
        _suppressed = True
        return  # Don't suppress anything in verbose mode

    # =========================================================================
    # PYTHON WARNINGS FILTERS
    # =========================================================================

    # --- ctranslate2 ---
    # "pkg_resources is deprecated as an API..."
    warnings.filterwarnings('ignore', message='.*pkg_resources is deprecated.*')

    # --- pytorch_lightning / lightning_fabric ---
    # "Environment variable TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD detected"
    warnings.filterwarnings('ignore', message='.*TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD.*')

    # --- torch.distributed ---
    # "NOTE: Redirects are currently not supported in Windows or MacOs"
    warnings.filterwarnings('ignore', message='.*Redirects are currently not supported.*')
    warnings.filterwarnings('ignore', category=UserWarning, module='torch.distributed')

    # --- transformers ---
    warnings.filterwarnings('ignore', message='.*is deprecated and will be removed.*', module='transformers')

    # --- faster-whisper / ctranslate2 ---
    warnings.filterwarnings('ignore', category=FutureWarning, module='faster_whisper')
    warnings.filterwarnings('ignore', category=FutureWarning, module='ctranslate2')

    # =========================================================================
    # LOGGING CONFIGURATION
    # =========================================================================

    logging.getLogger('torch.distributed.elastic').setLevel(logging.ERROR)
    logging.getLogger('torch.distributed.elastic.multiprocessing.redirects').setLevel(logging.ERROR)

    # Suppress faster-whisper verbose logging
    logging.getLogger('faster_whisper').setLevel(logging.WARNING)

    _suppressed = True


# Apply suppressions on import
_apply_suppressions()

CONST_AI_ROOT = dirname(realpath(__file__))
CONST_AI_NODE_SCRIPT = join(CONST_AI_ROOT, 'node.py')
CONST_AI_REQUIREMENTS = join(CONST_AI_ROOT, 'requirements.txt')

depends(CONST_AI_REQUIREMENTS)
