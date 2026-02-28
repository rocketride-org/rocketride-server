# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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
# Unified IInstance for Elasticsearch and OpenSearch index search nodes.
#
# Dispatches to the correct backend (IGlobal.backend). Search and ingest flows
# are the same; only the underlying client/store access differs.
# ------------------------------------------------------------------------------
from __future__ import annotations

from typing import Any, Dict, List, Optional

from rocketlib import Entry, debug
from ai.common.schema import Answer, Doc, Question
from ai.common.transform import IInstanceTransform

from .constants import (
    BACKEND_ELASTICSEARCH,
    BACKEND_OPENSEARCH,
    CONTENT_FIELD,
    DEFAULT_INDEX_NAME,
    DEFAULT_SCROLL,
    DEFAULT_TEXT_BATCH_SIZE,
    MODE_INDEX,
)
from .IGlobal import IGlobal


def _get_question_text(question: Question) -> Optional[str]:
    """Extract plain text from a Question (first question text or question.text)."""
    if hasattr(question, 'questions'):
        qs = getattr(question, 'questions') or []
        if qs:
            first = qs[0]
            return getattr(first, 'text', None) or str(first)
    if hasattr(question, 'text'):
        return question.text
    return None


def _get_question_embedding(question: Question) -> Optional[Any]:
    """Extract embedding from the first question in a Question, if present."""
    if not hasattr(question, 'questions'):
        return None
    qs = getattr(question, 'questions') or []
    if not qs:
        return None
    return getattr(qs[0], 'embedding', None)


class IInstance(IInstanceTransform):
    """
    Instance transform for index_search: runs search and ingest against
    Elasticsearch or OpenSearch depending on IGlobal.backend.
    """

    IGlobal: IGlobal

    def _highlight_fragments_from_hit(self, hit: Dict[str, Any]) -> List[str]:
        """Return non-empty highlight fragments for the content field from a search hit."""
        highlight = (hit.get('highlight') or {}).get(CONTENT_FIELD) or []
        return [str(f or '') for f in highlight if str(f or '').strip()]

    def _os_get_index(self) -> str:
        """Return the OpenSearch index/collection name (from IGlobal.collection)."""
        idx = getattr(self.IGlobal, 'collection', '') or ''
        result = idx or DEFAULT_INDEX_NAME
        debug(f'Resolved index name: {result}')
        return result

    def _os_get_client(self):
        """Return the OpenSearch client; raises if not initialized."""
        if self.IGlobal.client is None:
            debug('OpenSearch client is not initialized')
            raise Exception('OpenSearch client is not initialized')
        return self.IGlobal.client

    def _os_get_vector_dim(self) -> int:
        """Return configured vector dimension for OpenSearch vstore mode."""
        return int(getattr(self.IGlobal, 'vector_dim', 0) or 0)

    def _os_get_score_threshold(self) -> float:
        """Return minimum score threshold for OpenSearch vector results."""
        try:
            return float(getattr(self.IGlobal, 'score', 0.0) or 0.0)
        except Exception:
            return 0.0

    # -------------------------------------------------------------------------
    # writeQuestions - search dispatch
    # -------------------------------------------------------------------------

    def writeQuestions(self, question: Question) -> None:
        """
        Run a search for the given question and write results to the pipeline.

        In index mode: text (BM25) search. In vstore mode: vector or semantic search.
        Backend (Elasticsearch vs OpenSearch) is taken from IGlobal.
        """
        backend = self.IGlobal.backend
        mode = self.IGlobal.mode

        if mode == MODE_INDEX:
            self._handle_text_search(question)
            return
        if backend == BACKEND_ELASTICSEARCH:
            self.IGlobal.store.dispatchSearch(self, question)
        elif backend == BACKEND_OPENSEARCH:
            self._handle_opensearch_vector_search(question)

    # -------------------------------------------------------------------------
    # Text search (shared between both backends)
    # -------------------------------------------------------------------------

    def _handle_text_search(self, question: Question) -> None:
        """
        Run text (BM25) search in index mode. Works with both Elasticsearch and OpenSearch.
        """
        backend = self.IGlobal.backend
        q_text = _get_question_text(question)
        if not q_text:
            debug('writeQuestions missing question text; skipping')
            return

        if backend == BACKEND_ELASTICSEARCH:
            store = self.IGlobal.store
            if store is None or store.client is None:
                debug('Elasticsearch store/client is not initialized')
                return
            debug(f'writeQuestions text search index={store.index} query="{q_text}" mode=index')
            hits = store.search_text_all(
                query=q_text,
                batch_size=DEFAULT_TEXT_BATCH_SIZE,
                scroll=DEFAULT_SCROLL,
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
                batch_size=DEFAULT_TEXT_BATCH_SIZE,
                scroll=DEFAULT_SCROLL,
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
                base_text = (hit.get('_source', {}) or {}).get(CONTENT_FIELD, '') or ''
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

    def _handle_opensearch_vector_search(self, question: Question) -> None:
        """Run vector (k-NN) search for OpenSearch and write results to the pipeline."""
        client = self._os_get_client()
        index = self._os_get_index()
        score_threshold = self._os_get_score_threshold()
        q_embedding = _get_question_embedding(question)

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
            debug(
                f'writeQuestions vector mode: embedding dim mismatch len={len(q_embedding)} expected={expected_dim}; skipping'
            )
            return
        debug(f'writeQuestions vector search index={index} dim={len(q_embedding)}')
        resp = client.search_vector(index=index, vector=q_embedding, k=10)
        hits = (resp.get('hits') or {}).get('hits') or []
        debug(f'Vector search returned {len(hits)} hits')

        docs_batch_vec: List[Doc] = []
        for hit in hits:
            src = hit.get('_source', {}) or {}
            content = src.get(CONTENT_FIELD, '')
            score = hit.get('_score', 0)
            if score_threshold and score < score_threshold:
                continue
            if not content:
                continue
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

    def writeDocuments(self, documents: List[Doc]) -> None:
        """Ingest documents (with embeddings) into the store. Only supported in vstore mode."""
        backend = self.IGlobal.backend
        mode = self.IGlobal.mode

        if mode == MODE_INDEX:
            debug('Documents lane is only supported in vector store mode (vstore); use text lane for index mode.')
            return
        if backend == BACKEND_ELASTICSEARCH:
            self.IGlobal.store.addChunks(documents)
        elif backend == BACKEND_OPENSEARCH:
            self._os_write_documents_vector(documents)

    def _os_write_documents_vector(self, documents: List[Doc]) -> None:
        """Ingest documents (with embeddings) into the OpenSearch vector index."""
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
                doc_id = f'{meta.objectId}.{chunk_id}' if chunk_id is not None else str(meta.objectId)

            if embedding is None:
                debug('Vector mode requires embeddings; skipping doc without embedding')
                continue
            if vector_dim <= 0:
                debug('Vector mode missing vector_dim; cannot index')
                continue
            client.ensure_index_vector(index=index, dimension=vector_dim)
            metadata_payload = meta.model_dump(exclude_none=True) if meta is not None and hasattr(meta, 'model_dump') else None
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

    def writeText(self, text: str) -> None:
        """Ingest raw text into the index (text lane in index mode)."""
        if not text:
            debug('writeText called with empty text; skipping')
            return
        backend = self.IGlobal.backend

        if backend == BACKEND_ELASTICSEARCH:
            store = self.IGlobal.store
            if store is None or store.client is None:
                debug('Elasticsearch store/client is not initialized')
                return
            debug(f'writeText ingest len={len(text)} index={store.index}')
            store.ensure_index_text()
            store.upsert_text_document(doc_id=None, body={CONTENT_FIELD: text}, refresh=False)
        elif backend == BACKEND_OPENSEARCH:
            client = self._os_get_client()
            index = self._os_get_index()
            debug(f'writeText ingest len={len(text)} index={index}')
            client.ensure_index_text(index=index)
            client.upsert_document(index=index, doc_id=None, body={CONTENT_FIELD: text}, refresh=False)

    # -------------------------------------------------------------------------
    # renderObject (Elasticsearch only - uses DocumentStoreBase)
    # -------------------------------------------------------------------------

    def renderObject(self, object: Entry) -> None:
        """Stream document text to the writeText lane (Elasticsearch only; uses DocumentStoreBase)."""
        def callback(text: str) -> None:
            self.instance.sendText(text)

        if self.IGlobal.backend != BACKEND_ELASTICSEARCH:
            return
        if self.IGlobal.store is None:
            raise Exception('No document store')
        if not object.hasVectorBatchId or not object.vectorBatchId:
            return
        self.IGlobal.store.render(objectId=object.objectId, callback=callback)
        self.preventDefault()

