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

"""Custom grounding evaluator for Cobalt experiments.

Evaluates whether an LLM output is grounded in the provided context
documents. Uses sentence-level overlap analysis to detect claims that
cannot be traced back to the source material.

This evaluator is fully deterministic and does not require any
external API calls.
"""

import re


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences using basic punctuation rules.

    Args:
        text: The input text to split.

    Returns:
        A list of non-empty sentence strings.
    """
    raw = re.split(r'(?<=[.!?])\s+', text.strip())
    return [s.strip() for s in raw if s.strip()]


def _extract_content_words(text: str) -> set[str]:
    """Extract content-bearing words, filtering out stop words.

    Args:
        text: The input text.

    Returns:
        A set of lowercase content words.
    """
    stop_words = {
        'a',
        'an',
        'the',
        'is',
        'are',
        'was',
        'were',
        'be',
        'been',
        'being',
        'have',
        'has',
        'had',
        'do',
        'does',
        'did',
        'will',
        'would',
        'could',
        'should',
        'may',
        'might',
        'shall',
        'can',
        'to',
        'of',
        'in',
        'for',
        'on',
        'with',
        'at',
        'by',
        'from',
        'as',
        'into',
        'through',
        'during',
        'before',
        'after',
        'and',
        'but',
        'or',
        'nor',
        'not',
        'so',
        'yet',
        'both',
        'either',
        'neither',
        'it',
        'its',
        'that',
        'this',
        'these',
        'those',
        'their',
        'them',
        'they',
        'what',
        'which',
        'who',
        'whom',
        'whose',
    }
    words = set(re.findall(r'[a-z0-9]+', text.lower()))
    return words - stop_words


def _sentence_grounded_in_context(sentence: str, context_words: set[str]) -> float:
    """Compute how well a single sentence is grounded in the context.

    Measures the fraction of content words in the sentence that also
    appear in the context.

    Args:
        sentence: A single sentence from the output.
        context_words: Content words from all context documents combined.

    Returns:
        A float between 0.0 and 1.0 representing grounding strength.
    """
    sentence_words = _extract_content_words(sentence)
    if not sentence_words:
        return 1.0

    grounded_words = sentence_words & context_words
    return len(grounded_words) / len(sentence_words)


def evaluate_grounding(output: str, context: str, threshold: float = 0.5) -> dict:
    """Evaluate if output is grounded in the provided context.

    Splits the output into sentences and checks what fraction of each
    sentence's content words can be found in the context. The overall
    score is the average grounding across all sentences.

    Args:
        output: The LLM-generated output to evaluate.
        context: The source context (can be multiple documents concatenated).
        threshold: Minimum score to pass (default 0.5).

    Returns:
        A dict with keys: score (float 0-1), passed (bool), reasoning (str),
        and details (list of per-sentence scores).
    """
    if not output and not context:
        return {'score': 1.0, 'passed': True, 'reasoning': 'Both output and context are empty.', 'details': []}

    if not output:
        return {'score': 1.0, 'passed': True, 'reasoning': 'Output is empty; nothing to ground.', 'details': []}

    if not context:
        return {'score': 0.0, 'passed': False, 'reasoning': 'No context provided but output contains claims.', 'details': []}

    context_words = _extract_content_words(context)
    sentences = _split_sentences(output)

    if not sentences:
        return {'score': 1.0, 'passed': True, 'reasoning': 'No parseable sentences in output.', 'details': []}

    sentence_scores = []
    for sentence in sentences:
        score = _sentence_grounded_in_context(sentence, context_words)
        sentence_scores.append({'sentence': sentence, 'score': round(score, 4)})

    avg_score = sum(s['score'] for s in sentence_scores) / len(sentence_scores)
    passed = avg_score >= threshold

    ungrounded = [s for s in sentence_scores if s['score'] < threshold]
    if ungrounded:
        ungrounded_summary = f'{len(ungrounded)}/{len(sentence_scores)} sentences below threshold'
    else:
        ungrounded_summary = 'All sentences adequately grounded'

    reasoning = f'Average grounding: {avg_score:.2f}; {ungrounded_summary}; Threshold: {threshold}; Result: {"PASS" if passed else "FAIL"}'

    return {
        'score': round(avg_score, 4),
        'passed': passed,
        'reasoning': reasoning,
        'details': sentence_scores,
    }
