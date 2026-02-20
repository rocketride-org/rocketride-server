# ------------------------------------------------------------------------------
# Unified IInstance for Elasticsearch and OpenSearch index search connectors.
#
# Delegates to the appropriate backend based on IGlobal.backend.
# Both backends share the same search/ingest logic patterns; the only
# difference is how the underlying client/store is accessed.
# ------------------------------------------------------------------------------
from __future__ import annotations

from typing import Any, Dict, List, Optional

from rocketlib import Entry, debug
from ai.common.schema import Answer, Doc, Question
from ai.common.transform import IInstanceTransform

from .IGlobal import IGlobal


class IInstance(IInstanceTransform):
    IGlobal: IGlobal

    # -------------------------------------------------------------------------
    # Shared helpers
    # -------------------------------------------------------------------------

    def _highlight_fragments_from_hit(self, hit: Dict[str, Any]) -> List[str]:
        """
        Extract non-empty highlight fragments from a search hit.
        """
        highlight = (hit.get('highlight') or {}).get('content') or []
        return [str(f or '') for f in highlight if str(f or '').strip()]

    # -------------------------------------------------------------------------
    # OpenSearch-specific helpers
    # -------------------------------------------------------------------------

    def _os_get_index(self) -> str:
        idx = getattr(self.IGlobal, 'collection', '') or ''
        result = idx or 'rocketlib'
        debug(f'Resolved index name: {result}')
        return result

    def _os_get_client(self):
        if self.IGlobal.client is None:
            debug('OpenSearch client is not initialized')
            raise Exception('OpenSearch client is not initialized')
        return self.IGlobal.client

    def _os_get_vector_dim(self) -> int:
        return int(getattr(self.IGlobal, 'vector_dim', 0) or 0)

    def _os_get_score_threshold(self) -> float:
        try:
            return float(getattr(self.IGlobal, 'score', 0.0) or 0.0)
        except Exception:
            return 0.0

    # -------------------------------------------------------------------------
    # writeQuestions - search dispatch
    # -------------------------------------------------------------------------

    def writeQuestions(self, question: Question):
        """
        Take a question, perform a search, and write the results.

        Supports both vector search and text search (index mode).
        Delegates to the appropriate backend (Elasticsearch or OpenSearch).
        """
        backend = self.IGlobal.backend
        mode = self.IGlobal.mode

        # Index mode: text search (RPN opCodes no longer supported)
        if mode == 'index':
            self._handle_text_search(question)
            return

        # ---------------------------------------------------------------------
        # Vector store mode
        # ---------------------------------------------------------------------
        if backend == 'elasticsearch':
            # Elasticsearch: dispatch to the existing DocumentStoreBase search handler
            self.IGlobal.store.dispatchSearch(self, question)
        elif backend == 'opensearch':
            self._handle_opensearch_vector_search(question)

    # -------------------------------------------------------------------------
    # Text search (shared between both backends)
    # -------------------------------------------------------------------------

    def _handle_text_search(self, question: Question):
        """
        Handle text search in index mode (without RPN opCodes).
        Works with both Elasticsearch and OpenSearch backends.
        """
        backend = self.IGlobal.backend

        # Extract question text
        q_text = None
        if hasattr(question, 'questions'):
            qs = getattr(question, 'questions') or []
            if qs:
                first = qs[0]
                q_text = getattr(first, 'text', None) or str(first)
        if not q_text and hasattr(question, 'text'):
            q_text = question.text

        if not q_text:
            debug('writeQuestions missing question text; skipping')
            return

        # Execute search via appropriate backend
        if backend == 'elasticsearch':
            store = self.IGlobal.store
            if store is None or store.client is None:
                debug('Elasticsearch store/client is not initialized')
                return
            debug(f'writeQuestions text search index={store.index} query="{q_text}" mode=index')
            hits = store.search_text_all(
                query=q_text,
                batch_size=500,
                scroll='1m',
                match_operator=self.IGlobal.search_match_operator,
                match_operator_slop=self.IGlobal.search_exact_slop,
                highlight=self.IGlobal.search_highlight_enabled,
                highlight_fragment_size=self.IGlobal.search_highlight_fragment_size,
            )
        else:
            client = self._os_get_client()
            index = self._os_get_index()
            debug(f'writeQuestions search index={index} query="{q_text}" mode=index')
            hits = client.search_text_all(
                index=index,
                query=q_text,
                batch_size=500,
                scroll='1m',
                match_operator=self.IGlobal.search_match_operator,
                match_operator_slop=self.IGlobal.search_exact_slop,
                highlight=self.IGlobal.search_highlight_enabled,
                highlight_fragment_size=self.IGlobal.search_highlight_fragment_size,
            )

        debug(f'Search returned {len(hits)} hits (scroll/all)')

        fragments: List[Dict[str, Any]] = []
        for hit in hits:
            doc_id = hit.get('_id', '')
            highlight_frags = self._highlight_fragments_from_hit(hit)
            if highlight_frags:
                for frag in highlight_frags:
                    fragments.append({'text': frag, 'doc_id': doc_id})
            else:
                base_text = (hit.get('_source', {}) or {}).get('content', '') or ''
                if base_text:
                    fragments.append({'text': base_text, 'doc_id': doc_id})

        docs_batch: List[Doc] = []

        for fragment in fragments:
            text_out = fragment.get('text') if isinstance(fragment, dict) else fragment
            doc_id = fragment.get('doc_id') if isinstance(fragment, dict) else ''
            if not text_out:
                continue

            ans = Answer()
            if self.instance.hasListener('answers'):
                debug(f'Emitting answer len={len(text_out)} doc_id={doc_id}')
                ans.setAnswer(text_out)
                self.instance.writeAnswers(ans)

            if doc_id:
                try:
                    doc = Doc(page_content=text_out, metadata={'objectId': doc_id, 'chunkId': 0})
                    docs_batch.append(doc)
                except Exception:
                    debug('Failed to build document with doc_id; continuing')

            if self.instance.hasListener('text'):
                debug(f'Emitting text len={len(text_out)}')
                self.instance.writeText(text_out)

        if docs_batch and self.instance.hasListener('documents'):
            try:
                self.instance.writeDocuments(docs_batch)
            except Exception:
                debug('Failed to emit document batch; continuing')

    # -------------------------------------------------------------------------
    # OpenSearch vector search
    # -------------------------------------------------------------------------

    def _handle_opensearch_vector_search(self, question: Question):
        """
        Handle vector search for OpenSearch backend.
        """
        client = self._os_get_client()
        index = self._os_get_index()
        score_threshold = self._os_get_score_threshold()

        # Extract question text and embedding
        q_text: Optional[str] = None
        q_embedding = None
        if hasattr(question, 'questions'):
            qs = getattr(question, 'questions') or []
            if qs:
                first = qs[0]
                q_text = getattr(first, 'text', None) or str(first)
                q_embedding = getattr(first, 'embedding', None)
        if not q_text and hasattr(question, 'text'):
            q_text = question.text

        if q_embedding is None:
            debug('writeQuestions vector mode requires embedding; skipping')
            return
        try:
            q_embedding = [float(x) for x in q_embedding]  # type: ignore
        except Exception:
            debug('writeQuestions vector mode: embedding not convertible to float list; skipping')
            return
        expected_dim = self._os_get_vector_dim()
        if expected_dim and len(q_embedding) != expected_dim:
            debug(f'writeQuestions vector mode: embedding dim mismatch len={len(q_embedding)} expected={expected_dim}; skipping')
            return
        debug(f'writeQuestions vector search index={index} dim={len(q_embedding)}')
        resp = client.search_vector(index=index, vector=q_embedding, k=10)
        hits = (resp.get('hits') or {}).get('hits') or []
        debug(f'Vector search returned {len(hits)} hits')

        docs_batch_vec: List[Doc] = []

        for hit in hits:
            src = hit.get('_source', {}) or {}
            content = src.get('content', '')
            score = hit.get('_score', 0)
            if score_threshold and score < score_threshold:
                continue

            if content:
                ans = Answer()
                if self.instance.hasListener('answers'):
                    debug(f'Emitting answer len={len(content)} from hit id={hit.get("_id")}')
                    ans.setAnswer(content)
                    self.instance.writeAnswers(ans)

                doc_id = hit.get('_id', '')
                if doc_id and self.instance.hasListener('documents'):
                    try:
                        doc = Doc(page_content=content, metadata={'objectId': doc_id, 'chunkId': 0})
                        docs_batch_vec.append(doc)
                    except Exception:
                        debug('Failed to build document with doc_id; continuing')

                if self.instance.hasListener('text'):
                    debug(f'Emitting text len={len(content)} from hit id={hit.get("_id")}')
                    self.instance.writeText(content)

        if docs_batch_vec and self.instance.hasListener('documents'):
            try:
                self.instance.writeDocuments(docs_batch_vec)
            except Exception:
                debug('Failed to emit vector document batch; continuing')

    # -------------------------------------------------------------------------
    # writeDocuments
    # -------------------------------------------------------------------------

    def writeDocuments(self, documents: List[Doc]):
        """
        Take a list of documents and add them to the store.
        """
        backend = self.IGlobal.backend
        mode = self.IGlobal.mode

        if mode == 'index':
            debug('Documents lane is only supported in vector store mode (vstore); use text lane for index mode.')
            return

        if backend == 'elasticsearch':
            # Elasticsearch: use DocumentStoreBase addChunks
            self.IGlobal.store.addChunks(documents)
        elif backend == 'opensearch':
            self._os_write_documents_vector(documents)

    def _os_write_documents_vector(self, documents: List[Doc]):
        """Ingest documents into OpenSearch vector store."""
        if not documents:
            debug('writeDocuments called with no documents; skipping')
            return

        client = self._os_get_client()
        index = self._os_get_index()
        vector_dim = self._os_get_vector_dim()
        debug(f'writeDocuments ingest count={len(documents)} index={index} mode=vstore')

        for doc in documents:
            text = getattr(doc, 'page_content', None) or ''
            embedding = getattr(doc, 'embedding', None)
            meta = getattr(doc, 'metadata', None)
            if embedding is None and meta is not None:
                embedding = getattr(meta, 'embedding', None)

            doc_id: Optional[str] = None
            if meta is not None and getattr(meta, 'objectId', None) is not None:
                chunk_id = getattr(meta, 'chunkId', None)
                doc_id = f'{meta.objectId}.{chunk_id}' if chunk_id is not None else f'{meta.objectId}'

            if embedding is None:
                debug('Vector mode requires embeddings; skipping doc without embedding')
                continue
            if vector_dim <= 0:
                debug('Vector mode missing vector_dim; cannot index')
                continue
            client.ensure_index_vector(index=index, dimension=vector_dim)
            metadata_payload = None
            if meta is not None and hasattr(meta, 'model_dump'):
                metadata_payload = meta.model_dump(exclude_none=True)
            try:
                embedding_list = [float(x) for x in embedding]  # type: ignore
            except Exception:
                debug('Vector mode: embedding not convertible to float list; skipping doc')
                continue
            debug(f'Indexing vector doc id={doc_id} dim={len(embedding_list)}')
            client.upsert_vector_document(
                index=index,
                doc_id=doc_id,
                vector=embedding_list,
                content=text or None,
                metadata=metadata_payload,
                refresh=False,
            )

    # -------------------------------------------------------------------------
    # writeText
    # -------------------------------------------------------------------------

    def writeText(self, text: str):
        """
        Ingest raw text into the index (used by text lane in index mode).
        """
        if not text:
            debug('writeText called with empty text; skipping')
            return

        backend = self.IGlobal.backend

        if backend == 'elasticsearch':
            store = self.IGlobal.store
            if store is None or store.client is None:
                debug('Elasticsearch store/client is not initialized')
                return
            debug(f'writeText ingest len={len(text)} index={store.index}')
            store.ensure_index_text()
            store.upsert_text_document(doc_id=None, body={'content': text}, refresh=False)
        elif backend == 'opensearch':
            client = self._os_get_client()
            index = self._os_get_index()
            debug(f'writeText ingest len={len(text)} index={index}')
            client.ensure_index_text(index=index)
            client.upsert_document(index=index, doc_id=None, body={'content': text}, refresh=False)

    # -------------------------------------------------------------------------
    # renderObject (Elasticsearch only - uses DocumentStoreBase)
    # -------------------------------------------------------------------------

    def renderObject(self, object: Entry):
        """
        Output the document text to the writeText lane.
        """

        def callback(text: str) -> None:
            self.instance.sendText(text)

        backend = self.IGlobal.backend

        if backend == 'elasticsearch':
            # Check it
            if self.IGlobal.store is None:
                raise Exception('No document store')

            # If we do not have a vectorize flag, or we have not vectorized
            # it, allow the next driver to render
            if not object.hasVectorBatchId or not object.vectorBatchId:
                return

            # Render the data on this object from the store and
            # send it to the renderData function
            self.IGlobal.store.render(objectId=object.objectId, callback=callback)

            # Stop right here
            self.preventDefault()

