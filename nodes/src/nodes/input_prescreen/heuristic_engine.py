# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Heuristic ruleset engine for static prompt injection detection."""

import re
import time
from typing import List

from rocketlib import warning

from .models import HeuristicRule, RuleMatch, ScanResult


# Built-in heuristic rules targeting known prompt injection markers
BUILTIN_RULES: List[HeuristicRule] = [
    HeuristicRule(
        id="override_ignore",
        pattern=r"ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions|guidelines)",
        category="override_attempt",
        severity="critical",
        description="Attempts to override previous instructions",
    ),
    HeuristicRule(
        id="override_disregard",
        pattern=r"disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions|guidelines)",
        category="override_attempt",
        severity="critical",
        description="Attempts to disregard previous instructions",
    ),
    HeuristicRule(
        id="override_forget",
        pattern=r"forget\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions|guidelines)",
        category="override_attempt",
        severity="critical",
        description="Attempts to forget previous instructions",
    ),
    HeuristicRule(
        id="system_prompt_extract",
        pattern=r"(show|reveal|display|print|output|repeat|tell\s+me)\s+(\w+\s+)*(your|the)\s+(system\s+prompt|instructions|rules|initial\s+prompt|original\s+prompt)",
        category="override_attempt",
        severity="high",
        description="System prompt extraction attempt",
    ),
    HeuristicRule(
        id="roleplay_jailbreak",
        pattern=r"(you\s+are\s+now|act\s+as|pretend\s+to\s+be|roleplay\s+as|behave\s+as)\s+(a\s+)?(DAN|unrestricted|unfiltered|jailbroken|evil)",
        category="override_attempt",
        severity="critical",
        description="Jailbreak via roleplay injection",
    ),
    HeuristicRule(
        id="mode_switch",
        pattern=r"(enter|switch\s+to|activate)\s+(DAN|developer|god|admin|sudo|unrestricted)\s+mode",
        category="override_attempt",
        severity="critical",
        description="Mode switch attack",
    ),
    HeuristicRule(
        id="delimiter_token",
        pattern=r"<\|?(system|endoftext|im_start|im_end|end_of_turn)\|?>",
        category="delimiter_injection",
        severity="critical",
        description="Token delimiter injection",
    ),
    HeuristicRule(
        id="delimiter_tag",
        pattern=r"\[SYSTEM\]|\[INST\]|\[/INST\]|\[ASSISTANT\]",
        category="delimiter_injection",
        severity="high",
        description="Instruction tag delimiter injection",
    ),
    HeuristicRule(
        id="delimiter_header",
        pattern=r"###\s*(system|instruction|new\s+instruction)",
        category="delimiter_injection",
        severity="high",
        description="Markdown header delimiter injection",
    ),
    HeuristicRule(
        id="encoding_evasion",
        pattern=r"(decode|execute|run|eval)\s+(this\s+)?(base64|hex|rot13|encoded)",
        category="encoding_evasion",
        severity="high",
        description="Encoding evasion attempt",
    ),
    HeuristicRule(
        id="multistep_jailbreak",
        pattern=r"(first|step\s+1).*ignore.*instructions.*then",
        category="override_attempt",
        severity="critical",
        description="Multi-step jailbreak pattern",
    ),
    HeuristicRule(
        id="dan_pattern",
        pattern=r"\bDAN\b.*\b(mode|prompt|jailbreak)\b",
        category="override_attempt",
        severity="critical",
        description="DAN jailbreak pattern",
    ),
]


class HeuristicRuleset:
    """Compiled ruleset for static prompt injection detection.

    Pre-compiles regex patterns at initialization for high-performance
    scanning during request processing.
    """

    def __init__(self, rules: List[HeuristicRule]) -> None:
        self.rules = list(rules)

    def compile(self) -> None:
        """Pre-compile all regex patterns. Idempotent.

        Invalid patterns are logged, disabled, and skipped.
        """
        for rule in self.rules:
            if not rule.enabled:
                continue
            try:
                rule.compiled = re.compile(rule.pattern, re.IGNORECASE | re.DOTALL)
            except re.error as e:
                warning(f"[PreScreen] Invalid regex in rule '{rule.id}': {e}")
                rule.enabled = False
                rule.compiled = None

    def add_rule(self, rule: HeuristicRule) -> None:
        """Add a single rule to the ruleset (must call compile() after)."""
        self.rules.append(rule)

    def scan(self, text: str) -> ScanResult:
        """Scan input text against all enabled heuristic rules.

        Returns immediately for empty/whitespace-only text.
        Matches are ordered by character offset ascending.
        """
        text_length = len(text)

        if not text.strip():
            return ScanResult(
                passed=True,
                matches=[],
                scan_time_us=0,
                text_length=text_length,
            )

        start_time = time.perf_counter_ns()
        matches: List[RuleMatch] = []

        for rule in self.rules:
            if not rule.enabled:
                continue
            if rule.compiled is None:
                continue

            match = rule.compiled.search(text)
            if match:
                matches.append(
                    RuleMatch(
                        rule_id=rule.id,
                        category=rule.category,
                        severity=rule.severity,
                        matched_text=match.group(0)[:100],
                        position=match.start(),
                    )
                )

        # Sort by character offset ascending
        matches.sort(key=lambda m: m.position)

        elapsed_us = (time.perf_counter_ns() - start_time) // 1000

        return ScanResult(
            passed=len(matches) == 0,
            matches=matches,
            scan_time_us=elapsed_us,
            text_length=text_length,
        )
