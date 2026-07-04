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

# ------------------------------------------------------------------------------
# This class controls the data shared between all threads for the task
# ------------------------------------------------------------------------------
from rocketlib import OPEN_MODE, warning
from ai.common.config import Config
from ai.common.transform import IGlobalTransform


class IGlobal(IGlobalTransform):
    serverName: str = 'chroma'

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            # Import store definition - even though
            from .chroma import Store

            # Declare store
            self.store: Store | None = None

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get the passed configuration
            connConfig = self.getConnConfig()

            # Resolve the namespace used for agent-facing tool names
            # (chroma.search/upsert/delete). Read from the merged config
            # so it honors both profile defaults and user overrides.
            cfg = Config.getNodeConfig(self.glb.logicalType, connConfig)
            resolved_name = cfg.get('serverName') if isinstance(cfg, dict) or hasattr(cfg, 'get') else None
            if isinstance(resolved_name, str) and resolved_name.strip():
                self.serverName = resolved_name.strip()

            # Create the loader
            self.store = Store(self.glb.logicalType, connConfig, bag)

            # Wire an embedder for the control-plane tool path (search/upsert).
            # Mirrors autopipe pattern: only instantiate when embedding config present.
            self._tool_embedding = None
            self.embed_query = None
            self.embed_model_name = None

            try:
                embed_provider, embed_config = Config.getMultiProviderConfig('embedding', connConfig)
            except Exception:
                embed_provider, embed_config = None, None

            if embed_provider:
                try:
                    from ai.common.embedding import getEmbedding as _getEmbedding

                    self._tool_embedding = _getEmbedding(embed_provider, embed_config, bag)
                except Exception as exc:  # noqa: BLE001
                    warning(f'{self.glb.logicalType}: tool path embedder unavailable: {exc}')
                    self._tool_embedding = None

            if self._tool_embedding is not None:
                from ai.common.schema import Question as _Question, QuestionText as _QuestionText

                def _embed_query(text: str, _emb=self._tool_embedding) -> list:
                    qt = _QuestionText(text=text)
                    q = _Question()
                    q.questions = [qt]
                    _emb.encodeQuestion(q)
                    return list(qt.embedding or [])

                self.embed_query = _embed_query
                self.embed_model_name = getattr(self._tool_embedding, '_model', None)

            # Get the info about our store
            collection = self.store.collection
            host = self.store.host
            port = self.store.port

            # Format it into a subKey
            subKey = f'{host}/{port}/{collection}'

            # Call the base
            super().beginGlobal(subKey)
            return

    def endGlobal(self):
        self._tool_embedding = None
        self.embed_query = None
        self.embed_model_name = None
        self.store = None
