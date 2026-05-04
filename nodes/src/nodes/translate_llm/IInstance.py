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

from rocketlib import IInstanceBase, Entry
from rocketlib.types import IInvokeLLM
from ai.common.schema import Doc, Question, QuestionType
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Per-stream handler for the LLM Translate node.

    Translates incoming text and document segments using a connected LLM.
    For the documents lane, all segments are translated in a single batched
    LLM call (JSON array format). If the response count mismatches the input,
    falls back to one LLM call per segment. Doc.metadata (including time_stamp
    and time_stamp_end) is passed through unchanged so subtitle timing survives.
    """

    IGlobal: IGlobal

    _STYLE_INSTRUCTIONS: dict = {
        'standard': 'Translate {direction}. Output ONLY the translated text, no explanations.',
        'technical': ('Translate {direction}, preserving all technical terms, acronyms, and domain-specific vocabulary exactly. Output ONLY the translated text.'),
        'formal': ('Translate {direction} using formal, professional register. Output ONLY the translated text.'),
        'casual': ('Translate {direction} using natural, conversational language. Output ONLY the translated text.'),
        'literary': ('Translate {direction} preserving the literary style, rhythm, and artistic intent of the original. Output ONLY the translated text.'),
    }

    def open(self, obj: Entry) -> None:
        """Initialise per-object state.

        Args:
            obj (Entry): The pipeline entry being opened.

        Returns:
            None.
        """
        self._text_buf = ''

    def _direction(self) -> str:
        """Build the translation direction phrase used in prompts.

        Returns:
            str: e.g. 'from English to Spanish' or 'to Spanish'.
        """
        source = self.IGlobal.source_language
        target = self.IGlobal.target_language
        return f'from {source} to {target}' if source else f'to {target}'

    def _build_question(self, text: str, *, expect_json: bool = False) -> Question:
        """Construct a translation Question for the connected LLM.

        Args:
            text (str): The content to translate (plain text or numbered list).
            expect_json (bool): When True sets expectJson so the LLM returns JSON.

        Returns:
            Question: Configured question ready to pass to IInvokeLLM.Ask.
        """
        style = self.IGlobal.style
        direction = self._direction()

        question = Question(
            type=QuestionType.QUESTION,
            role='You are a professional translator.',
        )
        question.expectJson = expect_json

        if style == 'custom' and self.IGlobal.custom_prompt:
            instruction = self.IGlobal.custom_prompt
        else:
            template = self._STYLE_INSTRUCTIONS.get(style, self._STYLE_INSTRUCTIONS['standard'])
            instruction = template.format(direction=direction)

        question.addInstruction('Task', instruction)
        question.addDocuments(text)
        return question

    def writeText(self, text: str) -> None:
        """Accumulate incoming text for translation at stream close.

        Args:
            text (str): Plain text chunk to buffer.

        Returns:
            None.
        """
        self._text_buf += text
        self.preventDefault()

    def writeDocuments(self, docs: list) -> None:
        """Translate a batch of document segments via the connected LLM.

        Sends all segment texts as a JSON array in a single LLM call. Falls back
        to one call per segment if the response count does not match the input.
        Doc.metadata is reused on the output Doc objects so time_stamp and
        time_stamp_end flow through unchanged.

        Args:
            docs (list): List of Doc objects whose page_content should be translated.

        Returns:
            None.
        """
        translations = self._translate_batch([d.page_content for d in docs])
        out = [Doc(page_content=t, metadata=d.metadata) for t, d in zip(translations, docs)]
        self.instance.writeDocuments(out)
        self.preventDefault()

    def _translate_batch(self, texts: list[str]) -> list[str]:
        """Translate a list of strings with a single batched LLM call.

        Sends texts as a JSON array and expects a JSON array back. If the
        returned array length does not match the input, falls back to translating
        each string individually.

        Args:
            texts (list[str]): Strings to translate.

        Returns:
            list[str]: Translated strings in the same order as the input.
        """
        import json

        payload = json.dumps(texts, ensure_ascii=False)
        question = self._build_question(payload, expect_json=True)
        question.addInstruction(
            'Format',
            'Return a JSON array of translated strings in the same order as the input. No extra keys, no explanations — only the JSON array.',
        )
        result = self.instance.invoke(IInvokeLLM.Ask(question=question))
        parsed = result.getJson()

        if isinstance(parsed, list) and len(parsed) == len(texts):
            return [str(t) for t in parsed]

        # Count mismatch or unexpected shape — translate one-by-one as fallback
        return [self._translate_one(t) for t in texts]

    def _translate_one(self, text: str) -> str:
        """Translate a single string with one LLM call.

        Args:
            text (str): The string to translate.

        Returns:
            str: The translated string, or the original text if the response is empty.
        """
        question = self._build_question(text)
        result = self.instance.invoke(IInvokeLLM.Ask(question=question))
        translated = result.getText().strip()
        return translated if translated else text

    def closing(self) -> None:
        """Translate and emit any buffered plain text.

        Returns:
            None.
        """
        if self._text_buf:
            translated = self._translate_one(self._text_buf)
            self.instance.writeText(translated)
