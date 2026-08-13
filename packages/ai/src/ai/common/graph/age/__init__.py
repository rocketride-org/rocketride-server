# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Cypher -> Apache AGE translation layer.

Public surface for graph nodes targeting the RocketRide cloud data-core
(Postgres + Apache AGE). See README.md in this directory for the pipeline
description, verified AGE mechanics, and vendored-code provenance.
"""

from .analysis import CypherFacts, analyze
from .capabilities import AGE_1_5_0, CAPABILITY_TABLES, Capability, CellStatus, DEFAULT_AGE_VERSION
from .decode import decode_agtype
from .emit import TranslatedQuery
from .errors import AgeFirewallRejected, AgeTranslationError, AgeUnsupportedFeature
from .firewall import FirewallConfig
from .translate import TranslateMode, decode_row, translate

__all__ = [
    'AGE_1_5_0',
    'AgeFirewallRejected',
    'AgeTranslationError',
    'AgeUnsupportedFeature',
    'CAPABILITY_TABLES',
    'Capability',
    'CellStatus',
    'CypherFacts',
    'DEFAULT_AGE_VERSION',
    'FirewallConfig',
    'TranslateMode',
    'TranslatedQuery',
    'analyze',
    'decode_agtype',
    'decode_row',
    'translate',
]
