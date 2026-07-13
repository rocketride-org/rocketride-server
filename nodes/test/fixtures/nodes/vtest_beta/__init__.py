"""Test-only dependency-conflict fixture node (see services.json). Never shipped.

Pins ``tabulate==0.9.0`` and imports nothing from ``ai.*`` — the conflicting twin
of ``vtest_alpha``.
"""

from .IInstance import IInstance

__all__ = ['IInstance']
