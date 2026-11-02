/*
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { describe, it, expect } from '@jest/globals';
import { Question } from '../src/client/schema/Question';

describe('Question.cachePrefix', () => {
	it('is off unless the caller turns it on', () => {
		expect(new Question().cachePrefix).toBe(false);
		expect(new Question({ cachePrefix: true }).cachePrefix).toBe(true);
	});

	it('is sent with the question and read back, as the Python Question does', () => {
		const question = new Question({ expectJson: true, cachePrefix: true, role: 'You are a planner.' });
		question.addInstruction('Format', 'Reply with JSON.');
		question.addQuestion('What next?');

		const sent = question.toDict();
		const back = Question.fromDict(sent);

		expect(sent.cachePrefix).toBe(true);
		expect(back.cachePrefix).toBe(true);
		expect(back.toDict()).toEqual(sent);
	});

	it('reads a question without the field as off', () => {
		const { cachePrefix, ...older } = new Question().toDict();

		expect(cachePrefix).toBe(false);
		expect(Question.fromDict(older).cachePrefix).toBe(false);
	});
});
