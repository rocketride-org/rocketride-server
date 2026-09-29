# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pytest conftest for the Input Pre-Screen node suite.

Installs the shared security-node engine stubs before the test modules import
``input_prescreen`` (see nodes/test/_security_stubs.py).
"""

from .._security_stubs import install_security_stubs

install_security_stubs()
