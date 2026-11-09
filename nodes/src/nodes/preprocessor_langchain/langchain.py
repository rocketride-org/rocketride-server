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

import os
import ast
import inspect  # used to filter kwargs by constructor signature
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

# Load what we need
from typing import List, Dict, Any, Mapping
import langchain_text_splitters
from langchain_text_splitters import TextSplitter
from rocketlib import monitorStatus

from ai.common.preprocessor import PreProcessorBase


class PreProcessor(PreProcessorBase):
    """
    The preprocessor class cleans and splits text.
    """

    _preprocessor: TextSplitter

    # conservative token estimator configuration (no transformers import)
    _bytes_per_token: float = 3.0  # conservative default; lower => safer (more tokens estimated)
    _token_limit: int | None = None  # hard cap for model max tokens (minus safety margin)

    def _estimate_tokens(self, text: str) -> int:
        """Estimate token count without importing HF. Conservative by design."""
        # Use UTF-8 byte length; divide by configured bytes/token; ceil to avoid underestimation.
        byte_len = len(text.encode('utf-8'))
        # Avoid division by zero and ensure at least 1 token for non-empty text
        est = int((byte_len + self._bytes_per_token - 1) // self._bytes_per_token)
        return max(est, 1) if text else 0

    def _getEmbeddingLength(self, text: str):
        """
        Determine the number of tokens required for the given string.
        """
        if self._mode == 'strlen':
            # Estimates strlen
            return len(text)
        elif self._mode == 'tokens':
            # Estimates token count using byte-length approximation
            # route through the conservative estimator
            return self._estimate_tokens(text)

    def _parseSeparators(self, user_input: str):
        """
        Parse a quoted, comma-separated string into a list of actual separator strings.
        """
        try:
            # Convert user input into a list
            separators = ast.literal_eval(f'[{user_input}]')

            # Ensure all separators are strings
            if not all(isinstance(s, str) for s in separators):
                raise ValueError('All elements must be strings.')

            return separators
        except (SyntaxError, ValueError) as e:
            raise ValueError(f'Invalid input format: {e}')

    # Keep only kwargs accepted by the target class constructor
    def _filter_kwargs_for(self, cls, kwargs: Dict[str, Any]) -> Dict[str, Any]:
        """
        Filter kwargs so that only parameters accepted by cls.__init__ are passed.

        This prevents 'unexpected keyword argument' errors across splitters.
        """
        try:
            params = set(inspect.signature(cls.__init__).parameters.keys())
            params.discard('self')
            return {k: v for k, v in kwargs.items() if k in params}
        except (ValueError, TypeError):
            # If signature cannot be inspected, return kwargs as-is
            return kwargs

    def _split_safely_by_tokens(self, text: str, max_tokens: int) -> List[str]:
        """
        Force-split a too-long string into pieces that fit the token limit.

        using the conservative _estimate_tokens without importing transformers.
        """
        if self._estimate_tokens(text) <= max_tokens or not text:
            return [text]

        out: List[str] = []
        pending = text

        # Iteratively carve off chunks that fit the budget
        while pending and self._estimate_tokens(pending) > max_tokens:
            # Proportional first cut by chars based on token ratio
            est_tokens = self._estimate_tokens(pending)
            ratio = max_tokens / max(1, est_tokens)
            cut_chars = max(1, int(len(pending) * ratio))

            left = pending[:cut_chars]
            right = pending[cut_chars:]

            # Refine left by halving until it fits
            while self._estimate_tokens(left) > max_tokens and len(left) > 1:
                left = left[: len(left) // 2]
                right = pending[len(left) :]

            out.append(left)
            pending = right

        if pending:
            out.append(pending)

        return out

    def _getSplitter(self, provider: str, config: Dict[str, Any]):
        """
        Dynamically loads the text splitter from LangChain based on the provided configuration.
        """
        # The splitter class is the selector; its branch holds the class's own options
        splitter = config['splitter']

        # The options to pass on: everything but the selector and the size settings
        classConfig = {
            key: value for key, value in config.items() if key not in {'splitter', 'mode', 'strlen', 'tokens'}
        }

        # Determine the overlap and size
        chunk_size = self._splitSize
        chunk_overlap = 0

        # Output some status
        monitorStatus(f'Loading preprocessor {provider}/{splitter}')

        try:
            SplitterClass = getattr(langchain_text_splitters, splitter)
        except AttributeError:
            raise Exception(f"Splitter '{splitter}' not found in LangChain")

        # Base kwargs common to many splitters (will be filtered per class)
        base_kwargs = dict(
            chunk_overlap=chunk_overlap,
            chunk_size=chunk_size,
            length_function=self._getEmbeddingLength,
        )

        # Handle special cases for different splitters
        if splitter == 'RecursiveCharacterTextSplitter':
            # Get the specified sepators
            sep = classConfig.get('separators', '')

            # Get the separators
            if sep:
                separators = self._parseSeparators(sep)
                if not separators:
                    raise ValueError(f'Invalid separators specified {sep}')
            else:
                separators = None

            # Create and return the splitter
            kwargs = dict(base_kwargs)
            if separators is not None:
                kwargs['separators'] = separators
            splitter_instance = SplitterClass(**self._filter_kwargs_for(SplitterClass, kwargs))
            monitorStatus(f'Loading preprocessor complete {provider}/{splitter}')
            return splitter_instance

        elif splitter == 'CharacterTextSplitter':
            # Get the specified sepators
            sep = classConfig.get('separator', '')

            # Get the separators
            if sep:
                separators = self._parseSeparators(sep)
                if not separators or len(separators) != 1:
                    raise ValueError(f'Invalid separators specified {sep}')
                separator = separators[0]
            else:
                separator = None

            # Create and return the splitter
            kwargs = dict(base_kwargs)
            if separator is not None:
                kwargs['separator'] = separator
            splitter_instance = SplitterClass(**self._filter_kwargs_for(SplitterClass, kwargs))
            monitorStatus(f'Loading preprocessor complete {provider}/{splitter}')
            return splitter_instance

        elif splitter == 'MarkdownTextSplitter':
            # Create and return the splitter
            kwargs = dict(base_kwargs)
            kwargs['keep_separator'] = True
            splitter_instance = SplitterClass(**self._filter_kwargs_for(SplitterClass, kwargs))
            monitorStatus(f'Loading preprocessor complete {provider}/{splitter}')
            return splitter_instance

        elif splitter == 'LatexTextSplitter':
            # Create and return the splitter
            kwargs = dict(base_kwargs)
            kwargs['keep_separator'] = True
            splitter_instance = SplitterClass(**self._filter_kwargs_for(SplitterClass, kwargs))
            monitorStatus(f'Loading preprocessor complete {provider}/{splitter}')
            return splitter_instance

        elif splitter == 'NLTKTextSplitter':
            requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'nltk.txt')
            depends(requirements)

            import nltk

            # Ensure required NLTK resources
            try:
                nltk.data.find('tokenizers/punkt')
            except LookupError:
                nltk.download('punkt')
            # NLTK 3.9+ sometimes needs punkt_tab too
            try:
                nltk.data.find('tokenizers/punkt_tab')
            except LookupError:
                try:
                    nltk.download('punkt_tab')
                except Exception:
                    pass

            # Create and return the splitter (no leaking of classConfig)
            kwargs = dict(base_kwargs)
            # Allow language override if provided (e.g., "english", "spanish")
            if 'language' in classConfig:
                kwargs['language'] = classConfig['language']

            splitter_instance = SplitterClass(**self._filter_kwargs_for(SplitterClass, kwargs))
            monitorStatus(f'Loading preprocessor complete {provider}/{splitter}')
            return splitter_instance

        elif splitter == 'SpacyTextSplitter':
            requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'spacy.txt')
            depends(requirements)
            import spacy
            from spacy.cli import download

            # Get the pipeline name
            pipeline = classConfig.get('model', 'en_core_web_sm')
            try:
                spacy.load(pipeline)
            except OSError:
                download(pipeline)
                spacy.load(pipeline)

            # Create and return the splitter
            kwargs = dict(base_kwargs)
            kwargs['pipeline'] = pipeline
            splitter_instance = SplitterClass(**self._filter_kwargs_for(SplitterClass, kwargs))
            monitorStatus(f'Loading preprocessor complete {provider}/{splitter}')
            return splitter_instance

        else:
            # Create and return a default splitter
            splitter_instance = SplitterClass(**self._filter_kwargs_for(SplitterClass, base_kwargs))
            monitorStatus(f'Loading preprocessor complete {provider}/{splitter}')
            return splitter_instance

    def __init__(self, provider: str, config: Mapping, bag: Dict[str, Any]):
        """
        Initialize the preprocessor with the provider, the resolved config, and the bag.

        Args:
            provider: The node's logical type.
            config: The resolved node config (splitter, mode, strlen, tokens and the splitter's options).
            bag: The endpoint's shared bag.
        """
        # Init the base
        super().__init__(provider, config, bag)

        # The measuring mode decides which size setting applies
        self._mode = config['mode']
        self._splitSize = int(config['strlen'] if self._mode == 'strlen' else config['tokens'])

        # Bind the splitter
        self._preprocessor = self._getSplitter(provider, config)

    # Process a document by splitting it into chunks
    def process(self, text: str, path: str = None) -> List[str]:
        # Grab the chunks
        textChunks = self._preprocessor.split_text(text)

        # Safety net for token mode without HF tokenizer:
        # If a chunk still exceeds the model token budget, subdivide it.
        if self._mode == 'tokens' and self._token_limit is not None:
            fixed: List[str] = []
            for ch in textChunks:
                if self._estimate_tokens(ch) <= self._token_limit:
                    fixed.append(ch)
                else:
                    fixed.extend(self._split_safely_by_tokens(ch, self._token_limit))
            textChunks = fixed

        # Return the raw text chunks
        return textChunks
