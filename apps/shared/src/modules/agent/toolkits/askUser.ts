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
// ASK USER — ask_user ends the turn with a question for the user
// =============================================================================

/**
 * `ask_user`: the model asks the user something no tool can answer (a decision, a missing Variable). The turn
 * ends after that wave with the question as its answer and outcome needs_input; the user's next message
 * answers it. For a Variable it reads the account's Variable names (names only) to say whether it is set,
 * never whether a key works.
 */

import { AgentTool, AgentToolkit } from '../tools';
import type { NeedsInputRequest } from '../turn';
import { messageOf, requireClient, type ClientGetter } from './common';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The shape of a Variable the server fills in. */
const VARIABLE_NAME = /^ROCKETRIDE_[A-Z0-9_]+$/;

/** The most choices a question offers. */
const MAX_CHOICES = 4;

/** The longest one choice may be, in characters. */
const MAX_CHOICE_CHARS = 80;

/** What the model reads about asking the user, joined into the prompt with the toolkit. */
const INSTRUCTIONS = `## Asking the user

- When you need something only the user can give, such as a decision or a missing Variable, call ask_user, because the turn then ends with your question and their reply comes as the next message.
- For a Variable the work needs, use kind "variable" with its ROCKETRIDE_ name, because the chat then offers to open Variables. Never ask for the value itself.
- Give choices when the answer is one of a few, because each becomes a button.`;

/** What the model reads about the tool. */
const DESCRIPTION = `Ask the user a question and end the turn. Their reply comes as the next message.

- question: what you need from them, in a sentence or two.
- kind: "question" (default) or "variable" for a Variable they must add.
- choices: for a question, up to ${MAX_CHOICES} short answers to offer as buttons.
- variable: for kind "variable", its name, such as ROCKETRIDE_OPENAI_KEY.

Call it alone or last in a step, because nothing after it in the turn runs.`;

const ASKED = 'Asked the user. The turn ends here; their reply comes as the next message.';

// =============================================================================
// TOOLKIT
// =============================================================================

/** The ask_user toolkit. One per run: it keeps the run's one question. */
export class AskUserToolkit extends AgentToolkit {
	readonly name = 'ask-user';
	readonly instructions = INSTRUCTIONS;

	/** The run's question once ask_user has asked it. */
	request: NeedsInputRequest | null = null;

	/**
	 * @param client - The host's client getter, for the account's Variable names.
	 */
	constructor(private readonly client: ClientGetter) {
		super();
	}

	tools(): AgentTool[] {
		return [
			new AgentTool({
				name: 'ask_user',
				description: DESCRIPTION,
				parameters: {
					type: 'object',
					properties: {
						question: { type: 'string', description: 'What you need from the user' },
						kind: { type: 'string', enum: ['question', 'variable'], description: 'question (default) or variable' },
						choices: { type: 'array', items: { type: 'string' }, description: `Up to ${MAX_CHOICES} short answers to offer` },
						variable: { type: 'string', description: 'For kind variable: its name, such as ROCKETRIDE_OPENAI_KEY' },
					},
					required: ['question'],
					additionalProperties: false,
				},
				execute: (args) => this.ask(args),
			}),
		];
	}

	/**
	 * Keeps the question, which ends the turn after this wave.
	 *
	 * @throws When the arguments are wrong, or the run already asked; the message says how to fix it.
	 */
	private async ask(args: Record<string, unknown>): Promise<string> {
		if (this.request) throw new Error('You already asked the user this turn; wait for their reply.');
		const question = typeof args.question === 'string' ? args.question.trim() : '';
		if (!question) throw new Error('Pass question: what you need from the user.');
		const kind = args.kind ?? 'question';
		if (kind !== 'question' && kind !== 'variable') throw new Error('kind must be "question" or "variable".');
		const id = crypto.randomUUID().slice(0, 8);

		if (kind === 'variable') {
			const variable = typeof args.variable === 'string' ? args.variable.trim() : '';
			if (!VARIABLE_NAME.test(variable)) throw new Error('For kind "variable", pass variable: its name, such as ROCKETRIDE_OPENAI_KEY. Only ROCKETRIDE_ names are filled in.');
			const set = await this.isSet(variable);
			this.request = { id, kind, question, variable, ...(set === undefined ? {} : { variableSet: set }) };
			return ASKED;
		}

		const choices = Array.isArray(args.choices) ? args.choices.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim()) : [];
		if (choices.length > MAX_CHOICES || choices.some((c) => c.length > MAX_CHOICE_CHARS)) throw new Error(`Offer at most ${MAX_CHOICES} choices of up to ${MAX_CHOICE_CHARS} characters each.`);
		this.request = { id, kind, question, ...(choices.length ? { choices } : {}) };
		return ASKED;
	}

	/** Whether a Variable's name is among the account's Variables; undefined when the names cannot be read. */
	private async isSet(name: string): Promise<boolean | undefined> {
		try {
			return (await requireClient(this.client).account.getEnvironmentKeys()).includes(name);
		} catch (err) {
			console.log(`[agent] could not read the Variable names: ${messageOf(err)}`);
			return undefined;
		}
	}
}
