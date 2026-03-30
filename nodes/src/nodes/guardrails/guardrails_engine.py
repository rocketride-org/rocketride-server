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

"""Guardrails engine for input/output safety checks on AI pipelines."""

import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class GuardrailsViolation(Exception):
    """Raised when a guardrails check fails in block mode."""

    def __init__(self, violations: List[Dict[str, Any]]):
        """Initialize with a list of violation result dicts."""
        self.violations = violations
        messages = [v.get('details', v.get('rule', 'unknown violation')) for v in violations]
        super().__init__(f'Guardrails violation: {"; ".join(messages)}')


class GuardrailsEngine:
    """Comprehensive input/output guardrails engine for AI safety.

    Provides configurable checks for prompt injection, topic restriction,
    input length, hallucination detection, content safety, PII leak detection,
    and format compliance.
    """

    # -------------------------------------------------------------------------
    # Prompt injection detection patterns
    # -------------------------------------------------------------------------
    INJECTION_PATTERNS: List[re.Pattern] = [
        # Direct instruction override attempts
        re.compile(r'ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions|guidelines)', re.IGNORECASE),
        re.compile(r'disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions|guidelines)', re.IGNORECASE),
        re.compile(r'forget\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions|guidelines)', re.IGNORECASE),
        re.compile(r'override\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions|guidelines)', re.IGNORECASE),
        # System prompt extraction
        re.compile(r'(show|reveal|display|print|output|repeat|tell\s+me)\s+(\w+\s+)*(your|the)\s+(system\s+prompt|instructions|rules|initial\s+prompt|original\s+prompt)', re.IGNORECASE),
        re.compile(r'what\s+(are|were)\s+your\s+(system|original|initial)\s+(instructions|prompt|rules)', re.IGNORECASE),
        # Role-play attacks
        re.compile(r'(you\s+are\s+now|act\s+as|pretend\s+to\s+be|roleplay\s+as|behave\s+as)\s+(a\s+)?(DAN|unrestricted|unfiltered|jailbroken|evil)', re.IGNORECASE),
        re.compile(r'(enter|switch\s+to|activate)\s+(DAN|developer|god|admin|sudo|unrestricted)\s+mode', re.IGNORECASE),
        # Delimiter injection / context manipulation
        re.compile(r'<\|?(system|endoftext|im_start|im_end|end_of_turn)\|?>', re.IGNORECASE),
        re.compile(r'\[SYSTEM\]|\[INST\]|\[/INST\]|\[ASSISTANT\]', re.IGNORECASE),
        re.compile(r'###\s*(system|instruction|new\s+instruction)', re.IGNORECASE),
        # Encoding evasion (base64 instruction smuggling)
        re.compile(r'(decode|execute|run|eval)\s+(this\s+)?(base64|hex|rot13|encoded)', re.IGNORECASE),
        # Multi-step jailbreak patterns
        re.compile(r'(first|step\s+1).*ignore.*instructions.*then', re.IGNORECASE | re.DOTALL),
        # Do Anything Now (DAN) pattern
        re.compile(r'\bDAN\b.*\b(mode|prompt|jailbreak)\b', re.IGNORECASE),
    ]

    # Injection keywords with scoring weights
    INJECTION_KEYWORDS: Dict[str, float] = {
        'jailbreak': 0.8,
        'bypass': 0.4,
        'unrestricted': 0.5,
        'unfiltered': 0.5,
        'no restrictions': 0.6,
        'no limitations': 0.5,
        'without rules': 0.6,
        'ignore safety': 0.7,
        'disable safety': 0.7,
        'override safety': 0.7,
    }

    INJECTION_KEYWORD_THRESHOLD = 0.7

    # -------------------------------------------------------------------------
    # Content safety patterns
    # -------------------------------------------------------------------------
    CONTENT_SAFETY_PATTERNS: Dict[str, List[re.Pattern]] = {
        'self_harm': [
            re.compile(r'\b(how\s+to\s+)?(commit\s+suicide|kill\s+(myself|yourself|oneself)|end\s+my\s+life|self[- ]?harm)\b', re.IGNORECASE),
            re.compile(r'\b(methods?\s+(of|for)\s+)(suicide|self[- ]?harm|ending\s+(my|your|one\'?s)\s+life)\b', re.IGNORECASE),
        ],
        'violence': [
            re.compile(r'\b(how\s+to\s+)(make|build|create|construct)\s+(a\s+)?(bomb|explosive|weapon|poison|toxic\s+(gas|substance))\b', re.IGNORECASE),
            re.compile(r'\b(instructions?\s+for|guide\s+to|steps?\s+to)\s+(making|building|creating|assembling)\s+(a[n]?\s+)?(bomb|explosive\s*(device)?|weapon)\b', re.IGNORECASE),
        ],
        'illegal_activity': [
            re.compile(r'\b(how\s+to\s+)(hack|crack|break\s+into|exploit)\s+(a\s+)?(computer|server|network|system|account|password)\b', re.IGNORECASE),
            re.compile(r'\b(how\s+to\s+)(steal|forge|counterfeit|launder)\b', re.IGNORECASE),
        ],
    }

    # -------------------------------------------------------------------------
    # PII detection patterns
    # -------------------------------------------------------------------------
    PII_PATTERNS: Dict[str, re.Pattern] = {
        'email': re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'),
        'phone_us': re.compile(r'\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b'),
        'ssn': re.compile(r'\b(?!000|666|9\d{2})\d{3}[-\s]?(?!00)\d{2}[-\s]?(?!0000)\d{4}\b'),
        'credit_card': re.compile(r'\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b'),
        'ip_address': re.compile(r'\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b'),
    }

    def __init__(self, config: Dict[str, Any]):
        """Initialize the guardrails engine with configuration.

        Args:
            config: Configuration dict with keys like policy_mode,
                    enable_prompt_injection, enable_content_safety, etc.
        """
        self.policy_mode = config.get('policy_mode', 'warn')
        self.enable_prompt_injection = config.get('enable_prompt_injection', True)
        self.enable_content_safety = config.get('enable_content_safety', True)
        self.enable_pii_detection = config.get('enable_pii_detection', True)
        self.enable_hallucination_check = config.get('enable_hallucination_check', True)
        self.max_input_length = config.get('max_input_length', 0)
        self.max_tokens_estimate = config.get('max_tokens_estimate', 0)
        self.blocked_topics = [t.strip().lower() for t in config.get('blocked_topics', []) if t.strip()]
        self.allowed_topics = [t.strip().lower() for t in config.get('allowed_topics', []) if t.strip()]
        self.expected_format = config.get('expected_format', '')

    # -------------------------------------------------------------------------
    # Input guardrails
    # -------------------------------------------------------------------------

    def check_prompt_injection(self, text: str) -> Dict[str, Any]:
        """Detect prompt injection attempts using regex patterns and keyword scoring.

        Args:
            text: The input text to check.

        Returns:
            A check result dict with rule, passed, severity, and details.
        """
        # Check regex patterns
        for pattern in self.INJECTION_PATTERNS:
            match = pattern.search(text)
            if match:
                return {
                    'rule': 'prompt_injection',
                    'passed': False,
                    'severity': 'critical',
                    'details': f'Prompt injection detected: matched pattern near "{match.group(0)[:80]}"',
                }

        # Check keyword scoring
        text_lower = text.lower()
        score = 0.0
        matched_keywords = []
        for keyword, weight in self.INJECTION_KEYWORDS.items():
            if keyword in text_lower:
                score += weight
                matched_keywords.append(keyword)

        if score >= self.INJECTION_KEYWORD_THRESHOLD:
            return {
                'rule': 'prompt_injection',
                'passed': False,
                'severity': 'critical',
                'details': f'Prompt injection suspected: keyword score {score:.2f} (threshold {self.INJECTION_KEYWORD_THRESHOLD}), keywords: {", ".join(matched_keywords)}',
            }

        return {
            'rule': 'prompt_injection',
            'passed': True,
            'severity': 'low',
            'details': 'No prompt injection detected',
        }

    def check_topic_restriction(self, text: str, allowed_topics: Optional[List[str]] = None, blocked_topics: Optional[List[str]] = None) -> Dict[str, Any]:
        """Check text against allowed and blocked topic lists.

        Args:
            text: The input text to check.
            allowed_topics: If provided, text must contain at least one of these keywords.
            blocked_topics: If provided, text must not contain any of these keywords.

        Returns:
            A check result dict.
        """
        if allowed_topics is None:
            allowed_topics = self.allowed_topics
        if blocked_topics is None:
            blocked_topics = self.blocked_topics

        text_lower = text.lower()

        # Check blocked topics first
        for topic in blocked_topics:
            if topic and topic in text_lower:
                return {
                    'rule': 'topic_restriction',
                    'passed': False,
                    'severity': 'high',
                    'details': f'Blocked topic detected: "{topic}"',
                }

        # Check allowed topics (if specified, at least one must be present)
        if allowed_topics:
            found = any(topic in text_lower for topic in allowed_topics if topic)
            if not found:
                return {
                    'rule': 'topic_restriction',
                    'passed': False,
                    'severity': 'medium',
                    'details': f'Text does not match any allowed topics: {", ".join(allowed_topics)}',
                }

        return {
            'rule': 'topic_restriction',
            'passed': True,
            'severity': 'low',
            'details': 'Topic check passed',
        }

    def check_input_length(self, text: str, max_chars: int = 0, max_tokens_estimate: int = 0) -> Dict[str, Any]:
        """Check that input does not exceed length limits.

        Args:
            text: The input text to check.
            max_chars: Maximum character count (0 = no limit).
            max_tokens_estimate: Maximum estimated token count (0 = no limit).
                                 Tokens are estimated as word count * 1.3.

        Returns:
            A check result dict.
        """
        if max_chars <= 0:
            max_chars = self.max_input_length
        if max_tokens_estimate <= 0:
            max_tokens_estimate = self.max_tokens_estimate

        char_count = len(text)
        # Rough token estimate: split on whitespace, multiply by 1.3 for subword tokens
        word_count = len(text.split())
        token_estimate = int(word_count * 1.3)

        if max_chars > 0 and char_count > max_chars:
            return {
                'rule': 'input_length',
                'passed': False,
                'severity': 'medium',
                'details': f'Input too long: {char_count} chars exceeds limit of {max_chars}',
            }

        if max_tokens_estimate > 0 and token_estimate > max_tokens_estimate:
            return {
                'rule': 'input_length',
                'passed': False,
                'severity': 'medium',
                'details': f'Input too long: ~{token_estimate} tokens exceeds limit of {max_tokens_estimate}',
            }

        return {
            'rule': 'input_length',
            'passed': True,
            'severity': 'low',
            'details': f'Input length OK: {char_count} chars, ~{token_estimate} tokens',
        }

    # -------------------------------------------------------------------------
    # Output guardrails
    # -------------------------------------------------------------------------

    def check_hallucination(self, output: str, source_documents: Optional[List[str]] = None) -> Dict[str, Any]:
        """Verify that claims in output are grounded in source documents.

        Performs a sentence-level grounding check. Each sentence in the output
        is checked against the source documents for keyword overlap.

        Args:
            output: The LLM output text to verify.
            source_documents: List of source document texts. If empty/None,
                              the check passes with a warning.

        Returns:
            A check result dict.
        """
        if not source_documents:
            return {
                'rule': 'hallucination',
                'passed': True,
                'severity': 'low',
                'details': 'No source documents provided; hallucination check skipped',
            }

        # Combine source documents into one text block for matching
        combined_sources = ' '.join(source_documents).lower()

        # Split output into sentences
        sentences = re.split(r'[.!?]+', output)
        sentences = [s.strip() for s in sentences if len(s.strip()) > 10]

        if not sentences:
            return {
                'rule': 'hallucination',
                'passed': True,
                'severity': 'low',
                'details': 'Output too short for hallucination check',
            }

        ungrounded = []
        for sentence in sentences:
            # Extract meaningful words (3+ chars, not stop words)
            words = re.findall(r'\b[a-zA-Z]{3,}\b', sentence.lower())
            # Filter common stop words
            stop_words = {
                'the',
                'and',
                'for',
                'are',
                'but',
                'not',
                'you',
                'all',
                'can',
                'had',
                'her',
                'was',
                'one',
                'our',
                'out',
                'has',
                'have',
                'been',
                'will',
                'with',
                'this',
                'that',
                'from',
                'they',
                'were',
                'said',
                'each',
                'which',
                'their',
                'there',
                'would',
                'about',
                'could',
                'other',
                'into',
                'more',
                'some',
                'than',
                'them',
                'very',
                'when',
                'what',
                'your',
            }
            meaningful_words = [w for w in words if w not in stop_words]

            if not meaningful_words:
                continue

            # Check what fraction of meaningful words appear in sources
            found_count = sum(1 for w in meaningful_words if w in combined_sources)
            coverage = found_count / len(meaningful_words) if meaningful_words else 1.0

            if coverage < 0.3:
                ungrounded.append(sentence[:100])

        if ungrounded:
            return {
                'rule': 'hallucination',
                'passed': False,
                'severity': 'high',
                'details': f'Potentially ungrounded claims ({len(ungrounded)} of {len(sentences)} sentences): "{ungrounded[0][:80]}..."',
            }

        return {
            'rule': 'hallucination',
            'passed': True,
            'severity': 'low',
            'details': f'All {len(sentences)} sentences appear grounded in source documents',
        }

    def check_content_safety(self, text: str) -> Dict[str, Any]:
        """Detect harmful or unsafe content patterns.

        Args:
            text: The text to check for harmful content.

        Returns:
            A check result dict.
        """
        for category, patterns in self.CONTENT_SAFETY_PATTERNS.items():
            for pattern in patterns:
                match = pattern.search(text)
                if match:
                    return {
                        'rule': 'content_safety',
                        'passed': False,
                        'severity': 'critical',
                        'details': f'Unsafe content detected (category: {category}): matched near "{match.group(0)[:60]}"',
                    }

        return {
            'rule': 'content_safety',
            'passed': True,
            'severity': 'low',
            'details': 'No unsafe content detected',
        }

    def check_pii_leak(self, text: str) -> Dict[str, Any]:
        """Detect PII patterns in text (emails, phones, SSNs, credit cards, IPs).

        Args:
            text: The text to scan for PII.

        Returns:
            A check result dict.
        """
        found_pii = []
        for pii_type, pattern in self.PII_PATTERNS.items():
            matches = pattern.findall(text)
            if matches:
                found_pii.append(f'{pii_type}: {len(matches)} occurrence(s)')

        if found_pii:
            return {
                'rule': 'pii_leak',
                'passed': False,
                'severity': 'high',
                'details': f'PII detected: {"; ".join(found_pii)}',
            }

        return {
            'rule': 'pii_leak',
            'passed': True,
            'severity': 'low',
            'details': 'No PII detected',
        }

    def check_format_compliance(self, text: str, expected_format: str = '') -> Dict[str, Any]:
        """Verify that output matches an expected structure.

        Supported formats: 'json', 'markdown', 'bullet_list', 'numbered_list'.

        Args:
            text: The output text to check.
            expected_format: The format to validate against.

        Returns:
            A check result dict.
        """
        if not expected_format:
            expected_format = self.expected_format
        if not expected_format:
            return {
                'rule': 'format_compliance',
                'passed': True,
                'severity': 'low',
                'details': 'No format requirement specified',
            }

        fmt = expected_format.lower().strip()

        if fmt == 'json':
            import json as json_mod

            try:
                json_mod.loads(text)
                return {
                    'rule': 'format_compliance',
                    'passed': True,
                    'severity': 'low',
                    'details': 'Output is valid JSON',
                }
            except (json_mod.JSONDecodeError, TypeError):
                return {
                    'rule': 'format_compliance',
                    'passed': False,
                    'severity': 'medium',
                    'details': 'Output is not valid JSON',
                }

        if fmt == 'markdown':
            # Check for at least one markdown element
            has_md = bool(re.search(r'(^#{1,6}\s|^\*\s|^-\s|^\d+\.\s|\*\*.*\*\*|__.*__|`[^`]+`)', text, re.MULTILINE))
            if has_md:
                return {
                    'rule': 'format_compliance',
                    'passed': True,
                    'severity': 'low',
                    'details': 'Output contains markdown formatting',
                }
            return {
                'rule': 'format_compliance',
                'passed': False,
                'severity': 'medium',
                'details': 'Output does not contain expected markdown formatting',
            }

        if fmt == 'bullet_list':
            lines = [line.strip() for line in text.strip().split('\n') if line.strip()]
            bullet_lines = [ln for ln in lines if re.match(r'^[-*+]\s', ln)]
            if lines and len(bullet_lines) >= len(lines) * 0.5:
                return {
                    'rule': 'format_compliance',
                    'passed': True,
                    'severity': 'low',
                    'details': 'Output is a bullet list',
                }
            return {
                'rule': 'format_compliance',
                'passed': False,
                'severity': 'medium',
                'details': 'Output is not formatted as a bullet list',
            }

        if fmt == 'numbered_list':
            lines = [line.strip() for line in text.strip().split('\n') if line.strip()]
            numbered_lines = [ln for ln in lines if re.match(r'^\d+[.)]\s', ln)]
            if lines and len(numbered_lines) >= len(lines) * 0.5:
                return {
                    'rule': 'format_compliance',
                    'passed': True,
                    'severity': 'low',
                    'details': 'Output is a numbered list',
                }
            return {
                'rule': 'format_compliance',
                'passed': False,
                'severity': 'medium',
                'details': 'Output is not formatted as a numbered list',
            }

        return {
            'rule': 'format_compliance',
            'passed': True,
            'severity': 'low',
            'details': f'Unknown format "{expected_format}"; skipping check',
        }

    # -------------------------------------------------------------------------
    # Evaluation
    # -------------------------------------------------------------------------

    def evaluate(self, text: str, mode: str = 'input', context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Run all enabled guardrails checks on the given text.

        Args:
            text: The text to evaluate.
            mode: Either 'input' (pre-LLM) or 'output' (post-LLM).
            context: Optional context dict with keys like 'source_documents',
                     'allowed_topics', 'blocked_topics', 'expected_format'.

        Returns:
            A result dict with keys: passed, violations, scores, action.
        """
        if context is None:
            context = {}

        results = []

        if mode == 'input':
            # Input guardrails
            if self.enable_prompt_injection:
                results.append(self.check_prompt_injection(text))

            if self.blocked_topics or self.allowed_topics or context.get('blocked_topics') or context.get('allowed_topics'):
                results.append(
                    self.check_topic_restriction(
                        text,
                        allowed_topics=context.get('allowed_topics', self.allowed_topics),
                        blocked_topics=context.get('blocked_topics', self.blocked_topics),
                    )
                )

            if self.max_input_length > 0 or self.max_tokens_estimate > 0:
                results.append(self.check_input_length(text))

        elif mode == 'output':
            # Output guardrails
            if self.enable_hallucination_check:
                source_docs = context.get('source_documents', [])
                results.append(self.check_hallucination(text, source_docs))

            if self.enable_content_safety:
                results.append(self.check_content_safety(text))

            if self.enable_pii_detection:
                results.append(self.check_pii_leak(text))

            expected_fmt = context.get('expected_format', self.expected_format)
            if expected_fmt:
                results.append(self.check_format_compliance(text, expected_fmt))

        # Aggregate results
        violations = [r for r in results if not r['passed']]
        scores = {}
        for r in results:
            scores[r['rule']] = r['passed']

        # Determine overall action
        has_critical = any(v['severity'] == 'critical' for v in violations)
        has_high = any(v['severity'] == 'high' for v in violations)
        passed = len(violations) == 0

        if passed:
            action = 'pass'
        elif self.policy_mode == 'block':
            action = 'block'
        elif self.policy_mode == 'warn':
            action = 'warn'
        else:
            action = 'log'

        return {
            'passed': passed,
            'violations': violations,
            'scores': scores,
            'action': action,
            'has_critical': has_critical,
            'has_high': has_high,
        }
