"""Test-only dependency-conflict fixture node (see services.json). Never shipped.

Pins ``tabulate==0.8.10`` and imports nothing from ``ai.*`` so a pipeline that
uses both ``vtest_alpha`` and ``vtest_beta`` produces a deterministic constraints
conflict isolated to the venv-scoping mechanism.
"""

from .IInstance import IInstance

__all__ = ['IInstance']
