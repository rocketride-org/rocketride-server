// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EXPECT: what an output check may ask of the pipeline's output
// =============================================================================

/**
 * Every key an output check's `expect` may hold, with the value it takes and
 * the test it applies (51bd59d2c7's run_output vocabulary). Validation and the
 * run both read this one table, so a key the run would ignore cannot pass
 * validation.
 *
 * The answers are the answers lanes. The text is the text lanes, or the
 * answers when no text lane came back: a pipeline that ends in an LLM answers,
 * and text_match still reads what it said.
 */

import { pyRegex } from './score';

/** What the pipeline produced, by lane type. */
export interface PipelineOutput {
	answers: string[];
	text: string[];
}

/** The output as the tests read it. */
interface Seen {
	answers: string[];
	/** Every answer, one per line. */
	answerText: string;
	/** The text lanes, or the answers when there is no text lane. */
	text: string;
	/** Every answer and text item, one per line. */
	all: string;
	inputChars: number;
}

interface Rule {
	/** The value the key takes, as a validation problem names it. */
	takes: string;
	valid: (v: unknown) => boolean;
	fails: (v: never, seen: Seen) => string[];
}

function isRegex(v: unknown): v is string {
	if (typeof v !== 'string') return false;
	try {
		pyRegex(v);
		return true;
	} catch {
		return false;
	}
}

const matches = (re: string, text: string) => pyRegex(re, 's').test(text);
const isCount = (v: unknown) => Number.isInteger(v) && Number(v) >= 0;

const RULES: Record<string, Rule> = {
	// every answer must match: a translate pipeline that also answers the question in English is the failure build-05 looks for,
	// and build-10's two models must both say it
	answers_match: {
		takes: 'a regex',
		valid: isRegex,
		fails: (re: string, s) => {
			if (!s.answers.length) return [`no answer, wanted one matching ${re}`];
			const misses = s.answers.map((a, i) => (matches(re, a) ? 0 : i + 1)).filter(Boolean);
			return misses.length ? [`answer ${misses.join(', ')} of ${s.answers.length} does not match ${re}`] : [];
		},
	},
	answers_not_match: { takes: 'a regex', valid: isRegex, fails: (re: string, s) => (matches(re, s.answerText) ? [`an answer matches ${re}`] : []) },
	answers_match_all: {
		takes: 'a list of regexes',
		valid: (v) => Array.isArray(v) && v.every(isRegex),
		fails: (res: string[], s) => res.filter((re) => !matches(re, s.answerText)).map((re) => `no answer matches ${re}`),
	},
	answers_count_at_least: { takes: 'a whole number', valid: isCount, fails: (n: number, s) => (s.answers.length < n ? [`${s.answers.length} answers, wanted at least ${n}`] : []) },
	answers_max_sentences: {
		takes: 'a whole number',
		valid: isCount,
		fails: (n: number, s) => {
			const worst = Math.max(0, ...s.answers.map((a) => a.split(/[.!?]+(?:\s+|$)/).filter((x) => x.trim()).length));
			return worst > n ? [`an answer has ${worst} sentences, wanted at most ${n}`] : [];
		},
	},
	nonempty: { takes: 'true', valid: (v) => v === true, fails: (_: true, s) => (s.all.trim() ? [] : ['the output is empty']) },
	shorter_than_input: {
		takes: 'true',
		valid: (v) => v === true,
		fails: (_: true, s) => (s.all.trim().length > 0 && s.all.length < s.inputChars ? [] : [`the output (${s.all.length} characters) is not shorter than the input (${s.inputChars})`]),
	},
	text_match: {
		takes: 'a regex',
		valid: isRegex,
		fails: (re: string, s) => {
			if (!s.text.trim()) return [`no text or answer came back, wanted text matching ${re}`];
			return matches(re, s.text) ? [] : [`the text does not match ${re}`];
		},
	},
	text_not_match: { takes: 'a regex', valid: isRegex, fails: (re: string, s) => (matches(re, s.text) ? [`the text matches ${re}`] : []) },
};

/** The keys an output check's `expect` may hold. */
export const EXPECT_KEYS: readonly string[] = Object.keys(RULES);

/**
 * The problems with an output check's `expect`: a key the run does not read, or a value of the wrong kind.
 *
 * @param expect - The check's expect object.
 * @returns Each problem, as text after the check's label.
 */
export function expectProblems(expect: Record<string, unknown>): string[] {
	return Object.entries(expect).flatMap(([key, v]) => {
		const rule = Object.hasOwn(RULES, key) ? RULES[key] : undefined;
		if (!rule) return [`expect has unknown key ${key}; the runner reads ${EXPECT_KEYS.join(', ')}`];
		return rule.valid(v) ? [] : [`expect ${key} must be ${rule.takes}`];
	});
}

/**
 * Applies a check's `expect` to what the pipeline produced. The expect is valid (expectProblems is empty).
 *
 * @param expect - The check's expectations.
 * @param out - The answers and text.
 * @param inputChars - The length of what was sent.
 * @returns The failures; empty when every expectation holds.
 */
export function expectationFailures(expect: Record<string, unknown>, out: PipelineOutput, inputChars: number): string[] {
	const seen: Seen = {
		answers: out.answers,
		answerText: out.answers.join('\n'),
		text: (out.text.length ? out.text : out.answers).join('\n'),
		all: [...out.answers, ...out.text].join('\n'),
		inputChars,
	};
	return Object.entries(expect).flatMap(([key, v]) => RULES[key].fails(v as never, seen));
}
