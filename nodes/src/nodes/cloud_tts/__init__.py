# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""cloud_tts node: shared engine for the OpenAI, ElevenLabs and Rime cloud TTS vendors."""

from .IGlobal import IGlobal
from .IInstance import IInstance

__all__ = ['IGlobal', 'IInstance']
