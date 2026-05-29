"""
Configuration of every Python tree the contract-check framework scans.

Adding a new tree = appending one `Tree` entry to `SCANNED_TREES`. Nothing else
in the framework needs touching.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


# Repo root (= the rocketride-server checkout root). This file lives at
# tools/contract_checks/src/contract_checks/trees.py, so root is four
# parents up: contract_checks -> src -> contract_checks -> tools -> ROOT.
REPO_ROOT = Path(__file__).resolve().parents[4]


@dataclass(frozen=True)
class Tree:
    """
    A Python source tree to scan for third-party import contracts.

    Attributes:
        name:              Short id used in test ids and error messages
                           (e.g., ``nodes``, ``ai``, ``client-python``, ``rocketlib``).
        root:              Absolute path to the tree's source root.
        internal_packages: Top-level import names that belong to this repo
                           (filtered out before contract checking).

    Note: requirements installation is NOT configured per-tree. The CLI's
    install hook (``cli._install_all_requirements``) recursively walks every
    ``requirement*.txt`` under each tree's ``root`` — matching the engine's
    own glob — and feeds each to ``depends()`` (honouring
    ``# contract-check: skip-install`` / ``disable`` markers). There is no
    per-tree requirements finder.
    """

    name: str
    root: Path
    internal_packages: frozenset[str]


# Single source of truth for which trees the framework scans.
SCANNED_TREES: list[Tree] = [
    Tree(
        name='nodes',
        root=REPO_ROOT / 'nodes' / 'src' / 'nodes',
        internal_packages=frozenset({'rocketlib', 'ai', 'nodes', 'engLib', 'depends'}),
    ),
    Tree(
        name='ai',
        root=REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai',
        internal_packages=frozenset({'ai', 'rocketlib', 'engLib', 'depends'}),
    ),
    Tree(
        name='client-python',
        root=REPO_ROOT / 'packages' / 'client-python' / 'src' / 'rocketride',
        internal_packages=frozenset({'rocketride'}),
    ),
    Tree(
        name='rocketlib',
        root=REPO_ROOT / 'packages' / 'server' / 'engine-lib' / 'rocketlib-python' / 'lib',
        internal_packages=frozenset({'rocketlib', 'engLib', 'depends', 'util', 'msauth', 'dbgconn'}),
    ),
]
