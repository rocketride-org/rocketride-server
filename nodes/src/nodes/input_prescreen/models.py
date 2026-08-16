# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Data models for the Static Input Pre-Screen node."""

from dataclasses import dataclass, field
import re
from typing import Optional


@dataclass
class HeuristicRule:
    """A single heuristic detection rule."""

    id: str
    pattern: str
    category: str  # "override_attempt", "delimiter_injection", "encoding_evasion", etc.
    severity: str  # "critical" | "high" | "medium" | "low"
    description: str
    enabled: bool = True
    compiled: Optional[re.Pattern] = field(default=None, repr=False)


@dataclass
class RuleMatch:
    """A single rule match within scanned text."""

    rule_id: str
    category: str
    severity: str
    matched_text: str  # Truncated to 100 characters
    position: int  # Zero-based character offset of match start


@dataclass
class ScanResult:
    """Result of scanning text against the heuristic ruleset."""

    passed: bool
    matches: list  # list[RuleMatch]
    scan_time_us: int  # Scan duration in microseconds
    text_length: int


@dataclass
class FencedPayload:
    """Output of nonce-fencing operation."""

    nonce: str
    fenced_text: str
    system_addendum: str
    original_length: int
    fenced_length: int


@dataclass
class PreScreenConfig:
    """Static Input Pre-Screen .pipe configuration."""

    block_ignore_instructions: bool = True
    enable_nonce_fencing: bool = True
    nonce_length: int = 16
    policy_mode: str = 'block'  # 'block' | 'warn' | 'log'
    custom_rules: list = field(default_factory=list)
    max_input_length: int = 0  # 0 = no limit
