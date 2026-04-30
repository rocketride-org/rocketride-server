# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Mock google namespace package for llm_gemini and accessibility_describe testing.

When ROCKETRIDE_MOCK is set, this shadows the real google namespace so that
nodes importing 'from google import genai' get the stub instead of calling
the real Google AI API.
"""
