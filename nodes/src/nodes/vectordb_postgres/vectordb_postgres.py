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
# Interface implementation for the Postgres store
# ------------------------------------------------------------------------------
import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import List, Callable, Dict, Any, cast
import numpy as np

import psycopg2
from pgvector.psycopg2 import register_vector

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.config import Config
from .IGlobal import VALID_TABLE

# Default PostgreSQL port
DEFAULT_POSTGRES_PORT = 5432

# Minimum similarity score threshold for document filtering
MIN_SIMILARITY_SCORE = 0.20

# SQL Queries
SQL_QUERIES = {
    'check_collection_exists': "SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = %s)",
    # fmt: off
    'create_collection': (
        'CREATE TABLE IF NOT EXISTS {collection} ('
        'id bigserial PRIMARY KEY, '
        'content text, '
        'objectId text, '
        'nodeId text, '
        'parent text, '
        'permissionId int, '
        'isDeleted boolean, '
        'chunkId int, '
        'isTable boolean, '
        'tableId int, '
        'vectorSize int, '
        'modelName text, '
        'embedding vector({vector_size})'
        ');'
    ),
    # fmt: on
    'count_documents': 'SELECT COUNT(*) FROM {collection}',
    'search_keyword': 'SELECT * FROM {collection} WHERE content LIKE %s {where_clause} LIMIT %s',
    'get_documents': 'SELECT * FROM {collection} {where_clause} LIMIT %s',
    'get_paths': 'SELECT parent, objectId FROM {collection} WHERE {where_clause} OFFSET %s LIMIT %s',
    'insert_chunk': 'INSERT INTO {collection} ({columns}) VALUES ({placeholders})',
    'delete_by_object_ids': 'DELETE FROM {collection} WHERE objectId = ANY(%s)',
    'mark_deleted': 'UPDATE {collection} SET isDeleted = TRUE WHERE objectId = ANY(%s)',
    'mark_active': 'UPDATE {collection} SET isDeleted = FALSE WHERE objectId = ANY(%s)',
    'render_document': 'SELECT content, chunkId FROM {collection} WHERE objectId = %s AND chunkId >= %s AND chunkId < %s ORDER BY chunkId',
    'semantic_search': 'SELECT *, embedding {similarity_operator} %s AS distance FROM {collection} {where_clause} ORDER BY distance LIMIT %s',
}


class Store(DocumentStoreBase):
    apikey: str | None = None
    node: str = 'postgres'
    collection: str = ''
    host: str = ''
    port: int = 0
    vectorSize: int = 0
    renderChunkSize: int = 32 * 1024 * 1024
    similarity: str = 'Cosine'
    client: Any | None = None
    similarityDict: dict = {'cosine': '<=>', 'l2': '<->', 'inner_product': '<#>'}

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the postgres vector store.

        @param provider: The name of the provider.
        @param connConfig: The connection configuration.
        @param bag: A dictionary of additional parameters.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get our configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Save our parameters — validate to prevent SQL injection via .format()
        self.collection = ((config.get('table') or config.get('collection')) or '').strip()
        if not self.collection or not VALID_TABLE.fullmatch(self.collection):
            raise ValueError(f'Invalid collection name: {self.collection!r}. Must be a valid PostgreSQL identifier (letters, digits, underscores; max 63 chars).')

        # Remove leading and trailing spaces, leading http/https and :// and trailing slashes
        self.host = config.get('host').strip()
        self.port = config.get('port', DEFAULT_POSTGRES_PORT)
        self.user = config.get('user')
        self.password = config.get('password')
        self.database = config.get('database', 'postgres')

        self.renderChunkSize = config.get('renderChunkSize', self.renderChunkSize)
        self.threshold_search = config.get('score', 0.5)

        # check if the similarity matches milvus configuration options
        similarity = config.get('similarity', 'cosine')
        if similarity in ['cosine', 'l2', 'inner_product']:
            self.similarity = self.similarityDict[similarity]
        else:
            raise Exception('The metric you provided in the config.json does not match required postgres configurations')

        self.client = psycopg2.connect(dbname=self.database, user=self.user, password=self.password, host=self.host, port=self.port)

        register_vector(self.client)

        return

    def __del__(self):
        """
        Deinitializes the postgres client.
        """
        # Deinit everything we did
        self.collection = ''
        self.renderChunkSize = 0
        self.similarity = 'cosine'

        # Close the client to omit memory leaks
        if self.client is not None:
            self.client.close()
        self.client = None

        self.vectorSize = 0

    def _doesCollectionExist(self) -> bool:
        """
        Check if the collection exists.

        @returns: True if the collection exists, False otherwise.
        """
        with self.client.cursor() as cur:
            cur.execute(SQL_QUERIES['check_collection_exists'], (self.collection,))
            return cur.fetchone()[0]

    def _createCollection(self, vectorSize: int = 0) -> None:
        """
        Create a collection.

        @param vectorSize: The size of the vector.
        """
        with self.client.cursor() as cur:
            cur.execute(SQL_QUERIES['create_collection'].format(collection=self.collection, vector_size=vectorSize))
            self.client.commit()

    def _convertFilter(self, docFilter: DocFilter) -> tuple[str, list]:
        """
        Build the generic filter based on required permissions, node, parent, etc.

        @param docFilter: The document filter.
        @returns: A tuple containing the WHERE clause string and a list of parameters.
        """
        where_clauses = []
        params = []

        if docFilter.nodeId is not None:
            where_clauses.append('nodeId = %s')
            params.append(docFilter.nodeId)

        if docFilter.isTable is not None:
            where_clauses.append('isTable = %s')
            params.append(docFilter.isTable)

        if docFilter.tableIds is not None:
            where_clauses.append('tableId = ANY(%s)')
            params.append(list(docFilter.tableIds))

        if docFilter.parent is not None:
            where_clauses.append('parent = %s')
            params.append(docFilter.parent)

        if docFilter.permissions is not None:
            where_clauses.append('permissionId = ANY(%s)')
            params.append(list(docFilter.permissions))

        if docFilter.objectIds is not None:
            where_clauses.append('objectId = ANY(%s)')
            params.append(list(docFilter.objectIds))

        if docFilter.isDeleted is None or not docFilter.isDeleted:
            where_clauses.append('isDeleted = %s')
            params.append(False)

        if docFilter.chunkIds is not None:
            where_clauses.append('chunkId = ANY(%s)')
            params.append(list(docFilter.chunkIds))

        if docFilter.minChunkId is not None:
            where_clauses.append('chunkId >= %s')
            params.append(docFilter.minChunkId)

        if docFilter.maxChunkId is not None:
            where_clauses.append('chunkId <= %s')
            params.append(docFilter.maxChunkId)

        if not where_clauses:
            return '', []

        where_sql = ' AND '.join(where_clauses)
        return 'WHERE ' + where_sql, params

    def _convertToDocs(self, points: List[Any]) -> List[Doc]:
        """
        Convert a list of points or records to a docGroup.

        @param points: A list of points or records.
        @returns: A list of documents.
        """
        docs: List[Doc] = []

        # Now, add the documents to the results
        for point in points:
            # Get the payload content and metadata
            metadata_dict = {k: v for k, v in point.items() if k not in {'content', 'embedding', 'distance'}}

            key_map = {'objectid': 'objectId', 'nodeid': 'nodeId', 'permissionid': 'permissionId', 'isdeleted': 'isDeleted', 'chunkid': 'chunkId', 'istable': 'isTable', 'tableid': 'tableId', 'modelname': 'modelName', 'vectorsize': 'vectorSize'}

            renamed_metadata = {key_map.get(k, k): v for k, v in metadata_dict.items()}

            # Create a new dictionary with only the expected keys
            expected_keys = ['objectId', 'nodeId', 'parent', 'permissionId', 'isDeleted', 'chunkId', 'isTable', 'tableId', 'modelName', 'vectorSize', 'id']
            filtered_metadata = {k: v for k, v in renamed_metadata.items() if k in expected_keys}

            # Ensure modelName and vectorSize have default values if not present or None
            if 'modelName' not in filtered_metadata or filtered_metadata['modelName'] is None:
                filtered_metadata['modelName'] = ''
            if 'vectorSize' not in filtered_metadata or filtered_metadata['vectorSize'] is None:
                filtered_metadata['vectorSize'] = 0

            # Ensure other fields have default values if not present or None
            if 'nodeId' not in filtered_metadata or filtered_metadata['nodeId'] is None:
                filtered_metadata['nodeId'] = ''
            if 'parent' not in filtered_metadata or filtered_metadata['parent'] is None:
                filtered_metadata['parent'] = ''
            if 'permissionId' not in filtered_metadata or filtered_metadata['permissionId'] is None:
                filtered_metadata['permissionId'] = 0
            if 'isTable' not in filtered_metadata or filtered_metadata['isTable'] is None:
                filtered_metadata['isTable'] = False
            if 'tableId' not in filtered_metadata or filtered_metadata['tableId'] is None:
                filtered_metadata['tableId'] = 0

            metadata = cast(DocMetadata, filtered_metadata)
            content = point.get('content')

            score = 0.0
            if 'distance' in point and point['distance'] is not None:
                distance = point['distance']
                if self.similarity == '<=>':  # cosine
                    score = 1 - distance
                elif self.similarity == '<->':  # l2
                    score = 1 / (1 + distance)
                elif self.similarity == '<#>':  # inner product
                    score = -distance
                else:
                    score = 1 - distance

                # Ignore it if it doesn't have a high enough score
                if score < MIN_SIMILARITY_SCORE:
                    continue
            else:
                score = 0.0

            # Create a new document
            doc = Doc(score=score, page_content=content, metadata=metadata)

            # Append it to this documents chunks
            docs.append(doc)

        # Return it
        return docs

    def count_documents(self) -> int:
        """
        Return the number of vectors in the document store, not the number of documents themselves.

        @returns: The number of documents in the document store.
        """
        if not self._doesCollectionExist():
            return 0

        with self.client.cursor() as cur:
            cur.execute(SQL_QUERIES['count_documents'].format(collection=self.collection))
            return cur.fetchone()[0]

    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Perform a keyword search.

        @param query: The query to search for.
        @param docFilter: The document filter.
        @returns: A list of documents that match the query.
        """
        if not self._doesCollectionExist():
            return []

        where_sql, params = self._convertFilter(docFilter)
        query_params = [f'%{query}%'] + params

        with self.client.cursor() as cur:
            where_clause = ('AND ' + where_sql.split('WHERE ')[1]) if where_sql else ''
            cur.execute(SQL_QUERIES['search_keyword'].format(collection=self.collection, where_clause=where_clause), query_params + [docFilter.limit])
            results = cur.fetchall()

        # Convert results to dictionary
        points = [dict(zip([desc[0] for desc in cur.description], row)) for row in results]
        return self._convertToDocs(points)

    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """
        Retrieve document groups matching a given filter.

        @param docFilter: The document filter.
        @param checkCollection: Whether to check if the collection exists.
        @returns: A list of documents that match the filter.
        """
        if checkCollection and not self._doesCollectionExist():
            return []

        where_sql, params = self._convertFilter(docFilter)

        with self.client.cursor() as cur:
            cur.execute(SQL_QUERIES['get_documents'].format(collection=self.collection, where_clause=where_sql), params + [docFilter.limit])
            results = cur.fetchall()

        points = [dict(zip([desc[0] for desc in cur.description], row)) for row in results]
        return self._convertToDocs(points)

    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        Retrieve unique parent paths.

        @param parent: The parent path.
        @param offset: The offset to start from.
        @param limit: The maximum number of paths to return.
        @returns: A dictionary of parent paths and their object IDs.
        """
        if not self._doesCollectionExist():
            return {}

        where_clauses = ['chunkId = 0']
        params = []

        if parent is not None:
            where_clauses.append('parent = %s')
            params.append(parent)

        where_sql = ' AND '.join(where_clauses)

        with self.client.cursor() as cur:
            cur.execute(SQL_QUERIES['get_paths'].format(collection=self.collection, where_clause=where_sql), params + [offset, limit])
            results = cur.fetchall()

        paths = {row[0]: row[1] for row in results}
        return paths

    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        """
        Add document chunks to the document store.

        @param chunks: A list of documents to add.
        @param checkCollection: Whether to check if the collection exists.
        """
        if not chunks:
            return

        if checkCollection and not self.createCollection(chunks):
            return

        objectIds = {chunk.metadata.objectId for chunk in chunks}
        self.remove(list(objectIds))

        with self.client.cursor() as cur:
            for chunk in chunks:
                data = {'content': chunk.page_content, **chunk.metadata.model_dump(), 'embedding': chunk.embedding}
                if 'vectorSize' not in data or data['vectorSize'] is None:
                    data['vectorSize'] = len(chunk.embedding) if chunk.embedding else 0
                if 'modelName' not in data or data['modelName'] is None:
                    data['modelName'] = ''
                columns = ', '.join(data.keys())
                placeholders = ', '.join(['%s'] * len(data))
                cur.execute(SQL_QUERIES['insert_chunk'].format(collection=self.collection, columns=columns, placeholders=placeholders), list(data.values()))
            self.client.commit()

    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all documents with matching objectIds from the document store.

        @param objectIds: A list of object IDs to delete.
        """
        if not self._doesCollectionExist():
            return

        with self.client.cursor() as cur:
            cur.execute(SQL_QUERIES['delete_by_object_ids'].format(collection=self.collection), (objectIds,))
            self.client.commit()

    def markDeleted(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as deleted.

        @param objectIds: A list of object IDs to mark as deleted.
        """
        if not self._doesCollectionExist():
            return

        with self.client.cursor() as cur:
            cur.execute(SQL_QUERIES['mark_deleted'].format(collection=self.collection), (objectIds,))
            self.client.commit()

    def markActive(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as active.

        @param objectIds: A list of object IDs to mark as active.
        """
        if not self._doesCollectionExist():
            return

        with self.client.cursor() as cur:
            cur.execute(SQL_QUERIES['mark_active'].format(collection=self.collection), (objectIds,))
            self.client.commit()

    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """
        Given an object id, renders the complete document.

        @param objectId: The object ID to render.
        @param callback: The callback function to call with the rendered text.
        """
        if not self._doesCollectionExist():
            return

        offset = 0
        while True:
            with self.client.cursor() as cur:
                cur.execute(SQL_QUERIES['render_document'].format(collection=self.collection), (objectId, offset, offset + self.renderChunkSize))
                results = cur.fetchall()

            if not results:
                break

            text = [''] * self.renderChunkSize
            lastIndex = -1

            for content, chunkId in results:
                index = chunkId - offset
                if index >= 0:
                    text[index] = content
                    if index > lastIndex:
                        lastIndex = index

            if lastIndex == -1:
                break

            fullText = ''.join(text[: lastIndex + 1])
            callback(fullText)

            if len(results) < self.renderChunkSize:
                break

            offset += self.renderChunkSize

    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Perform a semantic search.

        @param query: The query to search for.
        @param docFilter: The document filter.
        @returns: A list of documents that match the query.
        """
        if not self._doesCollectionExist():
            return []

        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')

        where_sql, params = self._convertFilter(docFilter)
        embedding_arr = np.array(query.embedding)

        with self.client.cursor() as cur:
            cur.execute(SQL_QUERIES['semantic_search'].format(collection=self.collection, similarity_operator=self.similarity, where_clause=where_sql), (embedding_arr, *params, docFilter.limit))
            results = cur.fetchall()

        # Convert results to dictionary
        points = [dict(zip([desc[0] for desc in cur.description], row)) for row in results]
        return self._convertToDocs(points)
