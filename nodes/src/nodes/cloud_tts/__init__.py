# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""cloud_tts node: shared engine for the OpenAI and ElevenLabs cloud TTS vendors."""

from .IGlobal import IGlobal
from .IInstance import IInstance

__all__ = ['IGlobal', 'IInstance']
