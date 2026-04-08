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
# Interface implementation for the Milvus store
# ------------------------------------------------------------------------------
# We now have real requirements, so load them before we start
# loading our driver
import os
from depends import depends  # type: ignore

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

# Load what we need
from typing import List, Callable, Dict, Any, cast
import numpy as np
from pymilvus import MilvusClient, DataType

import re
import json
import uuid
import random
import engLib

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.config import Config

# Default batch size for bulk upsert operations
DEFAULT_BULK_INSERT_BATCH_SIZE = 50

# Default connection timeout in seconds
DEFAULT_TIMEOUT = 60


def _escape_milvus_str(value: object) -> str:
    """Escape a value for safe interpolation into a Milvus filter expression."""
    return str(value).replace('\\', '\\\\').replace("'", "\\'")


class Store(DocumentStoreBase):
    apikey: str = ''
    collection: str = ''
    vectorSize: int = 0
    renderChunkSize: int = 32 * 1024 * 1024
    similarity: str = 'Cosine'
    client: MilvusClient | None = None
    vectorSizePos: int = 1
    vectorIndexType: str = 'IVF_FLAT'
    scalarIndexType: str = 'STL_SORT'

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the milvus vector store.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get our configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Save our parameters
        self.collection = config.get('collection')

        # Remove leading and trailing spaces, leading http/https and :// and trailing slashes
        self.host = re.sub(r'^https?://', '', config.get('host').strip()).rstrip('/')
        self.port = config.get('port')

        # Strip API key also
        self.apikey = config.get('apikey', None)
        if self.apikey is not None:
            self.apikey = self.apikey.strip()

        self.renderChunkSize = config.get('renderChunkSize', self.renderChunkSize)
        self.threshold_search = config.get('score', 0.5)

        # Configurable timeout (seconds) and bulk insert batch size
        self.timeout = max(int(config.get('timeout', DEFAULT_TIMEOUT)), 1)
        self.bulkInsertBatchSize = max(int(config.get('bulkInsertBatchSize', DEFAULT_BULK_INSERT_BATCH_SIZE)), 1)

        profile = config.get('mode')

        # check if the similarity matches milvus configuration options
        similarity = config.get('similarity', 'COSINE')
        if similarity in ['L2', 'IP', 'COSINE', 'JACCARD', 'HAMMING', 'BM25']:
            self.similarity = similarity
        else:
            raise Exception('The metric you provided in the config.json does not match required milvus configurations')

        # Establish a connection to the Milvus instance with configurable timeout
        try:
            if profile != 'local':
                # Init the store (host was stripped of protocol at line 87, so always add https://)
                self.client = MilvusClient(uri=f'https://{self.host}', token=self.apikey, timeout=self.timeout)
            else:
                self.client = MilvusClient(uri=f'http://{self.host}:{self.port}', timeout=self.timeout)
        except Exception as e:
            self.client = None
            raise Exception(f'Failed to connect to Milvus at {self.host}: {e}') from e

        return

    def __del__(self):
        """
        Deinitialize the milvus client.
        """
        # Deinit everything we did
        self.collection = ''
        self.vectorSize = 0
        self.renderChunkSize = 0
        self.similarity = 'COSINE'
        self.client = None
        self.apikey = None

    def _doesCollectionExist(self) -> bool:
        """
        Check if the collection exists.
        """
        if self.client is None:
            return False
        return self.client.has_collection(collection_name=self.collection)

    def _createCollection(self, vectorSize: int) -> bool:
        """
        Create a collection, doesn't return anything.
        """
        # no collection present so far -> Let's build by starting with the parameters for the schema

        schema = MilvusClient.create_schema(
            auto_id=False,
            enable_dynamic_field=False,
        )

        # ID field
        schema.add_field(field_name='id', datatype=DataType.INT64, is_primary=True, max_length=300)

        # create the vector field
        schema.add_field(field_name='vector', datatype=DataType.FLOAT_VECTOR, dim=vectorSize)

        # this is the field for the complete context
        schema.add_field(
            field_name='content',
            datatype=DataType.VARCHAR,
            max_length=65535,  # max length
        )

        # Setup our metadata for filtering
        schema.add_field(field_name='meta', datatype=DataType.JSON)

        # Prepare index parameters
        index_params = self.client.prepare_index_params()

        # Add indexes
        index_params.add_index(field_name='id', index_type=self.scalarIndexType)

        index_params.add_index(
            field_name='vector',
            index_type=self.vectorIndexType,
            metric_type=self.similarity,
            params={'nlist': 1024},  # number of cells in the inverted index
        )

        # Create a collection
        # Note: Use _doesCollectionExist() instead of doesCollectionExist() because
        # this method is called from the base class createCollection() which already
        # holds collectionLock. Using doesCollectionExist() would cause a deadlock.
        if not self._doesCollectionExist():
            try:
                self.client.create_collection(collection_name=self.collection, schema=schema, index_params=index_params)
            except Exception:
                return True
        return False

    def _convertFilter(self, docFilter: DocFilter) -> str:
        """
        Build the generic filter expression based on required permissions, node, parent, etc.
        """
        # Declare the must list to start adding conditions
        must_conditions = []

        if docFilter.nodeId is not None:
            must_conditions.append(f"meta['nodeId'] == '{_escape_milvus_str(docFilter.nodeId)}'")

        if docFilter.isTable is not None:
            (must_conditions.append(f"meta['isTable'] == '{_escape_milvus_str(docFilter.isTable)}'"),)

        if docFilter.tableIds is not None:
            table_ids = ', '.join(f"'{_escape_milvus_str(t)}'" for t in docFilter.tableIds)
            must_conditions.append(f"meta['tableId'] in [{table_ids}]")

        if docFilter.parent is not None:
            must_conditions.append(f"meta['parent'] == '{_escape_milvus_str(docFilter.parent)}'")

        if docFilter.permissions is not None:
            permission_ids = ', '.join(f"'{_escape_milvus_str(p)}'" for p in docFilter.permissions)
            must_conditions.append(f"meta['permissionId'] in [{permission_ids}]")

        if docFilter.objectIds is not None:
            object_ids = ', '.join(f"'{_escape_milvus_str(o)}'" for o in docFilter.objectIds)
            must_conditions.append(f"meta['objectId'] in [{object_ids}]")

        # If we are not going after deleted docs, add a condition
        if docFilter.isDeleted is None or not docFilter.isDeleted:
            must_conditions.append("meta['isDeleted'] == False")

        if docFilter.chunkIds is not None:
            chunk_ids = ', '.join(map(str, docFilter.chunkIds))
            must_conditions.append(f"meta['chunkId'] in [{chunk_ids}]")

            # If we are min chunk id, add a condition
        if docFilter.minChunkId is not None:
            must_conditions.append(f"meta['chunkId'] >= {docFilter.minChunkId}")

        # If we are min chunk id, add a condition
        if docFilter.maxChunkId is not None:
            must_conditions.append(f"meta['chunkId'] <= {docFilter.maxChunkId}")

        return must_conditions

    def _convertToDocs(self, points: List[dict]) -> List[Doc]:
        """
        Convert a list of points or records to a docGroup.

        Groups all document chunks  together
        """
        docs: List[Doc] = []

        # Now, add the documents to the results
        for point in points:
            # Check it
            if not isinstance(point, dict):
                raise Exception('scored search is not a dictionary')

            if not isinstance(point.get('id'), int):
                raise Exception('scored id is not an integer')

            # Get the payload
            entity = point.get('entity')
            if entity is None:
                entity = point
                score = 0
            else:
                # Milvus COSINE distance returns values in the range [0, 2] where 0 is
                # identical. We rescale to [0, 1] with 1 meaning most similar to stay
                # consistent with the rest of the codebase score convention.
                if self.similarity == 'COSINE':
                    score = (point.get('distance') + 1) / 2
                else:
                    score = float(1.0 / (1.0 + np.exp(point.get('distance') / -100)))  # expit function unwrapped
                # Ignore it if it doesn't have a high enough score
                if score < 0.20:
                    continue

            # Process the entity as needed
            content = entity.get('content')
            # Process the entity as needed
            metadata = entity.get('meta')

            # Get the payload content and metadata
            metadata = cast(DocMetadata, metadata)

            # Create a new document
            doc = Doc(score=score, page_content=content, metadata=metadata)

            # Append it to this documents chunks
            docs.append(doc)

        # Return it
        return docs

    def count_documents(self) -> int:
        """
        Return the number of vectors in the document store, not the number of documents themselves.

        Returns how many documents are present in the document store.
        """
        # If the collection does not exists, by definition there are
        # no documents in the collection
        if not self.doesCollectionExist():
            return 0

        # Get cound documents using query
        res = self.client.query(collection_name=self.collection, output_fields=['count(*)'])

        # Parse query result
        return res[0]['count(*)']

    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Keyword search.
        """
        # If the collection does not exists, by definition there are
        # no search results to return
        if not self.doesCollectionExist():
            return []

        # Declare the docs list
        docs: List[Doc] = []

        # Build up the conditions
        must_conditions = self._convertFilter(docFilter=docFilter)

        # Append it
        must_conditions.append(f"content like '%{_escape_milvus_str(query)}%'")

        # Combine all conditions into a single filter expression
        filter_expression = ' and '.join(must_conditions) if must_conditions else None

        # Perform the keyword solo search
        points = self.client.query(
            collection_name=self.collection,
            filter=filter_expression,
            limit=docFilter.limit,
            output_fields=['meta', 'content'],
        )

        docs = self._convertToDocs(points)

        # Return them
        return docs

    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Semantic search.
        """
        # If the collection does not exists, by definition there are
        # no search results to return
        if not self.doesCollectionExist():
            return []

        # Declare the docs list
        docs: List[Doc] = []

        # Build up the conditions
        must_conditions = self._convertFilter(docFilter=docFilter)

        # We know the collection exists, now we can check to make sure the
        # embedding is correct. This will throw if the model doesn't match
        self.doesCollectionExist(query.embedding_model)

        # Check embedding
        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')

        # We cannot support non-zero offsets
        if docFilter.offset:
            raise BaseException('Non-zero offset is not supported in semantic searching')

        # Combine all conditions into a single filter expression
        filter_expression = ' and '.join(must_conditions) if must_conditions else None

        # Perform the search
        points = self.client.search(collection_name=self.collection, data=[query.embedding], filter=filter_expression, limit=25 if docFilter.limit <= 10 else docFilter.limit, output_fields=['meta', 'content'])

        docs = self._convertToDocs(points[0])

        # Return the results
        return docs

    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """
        Retrieve document groups matching a given filter.
        """
        # If the collection does not exists, by definition there are
        # no documents matching the get
        if checkCollection and not self.doesCollectionExist():
            return []

        # Convert filter to Milvus format
        must_conditions = self._convertFilter(docFilter)

        # Combine all conditions into a single filter expression
        filter_expression = ' and '.join(must_conditions) if must_conditions else None

        # Perform the query
        results = self.client.query(collection_name=self.collection, filter=filter_expression, output_fields=['meta', 'content'], offset=docFilter.offset, limit=docFilter.limit)

        # Convert results to Docs
        return self._convertToDocs(results)

    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        Retrieve unique parent paths.
        """
        # If the collection does not exists, by definition there are
        # no paths to return
        if not self.doesCollectionExist():
            return {}

        # Base filter: Only chunk 0
        filter_expr = "meta['chunkId'] == 0"

        # If parent specified, add condition
        if parent is not None:
            filter_expr += f' and meta["parent"] == {json.dumps(parent)}'

        # Perform the query
        results = self.client.query(collection_name=self.collection, filter=filter_expr, output_fields=['meta'], offset=offset, limit=limit)

        # Build paths dictionary
        paths = {}
        for record in results:
            metadata = record.get('meta', {})
            parent_id = metadata.get('parent', None)
            object_id = metadata.get('objectId', None)

            if parent_id and object_id:
                paths[parent_id] = object_id

        return paths

    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        """
        Add document chunks to the document store using batched bulk upsert.
        """
        # If no documents present, get out
        if not len(chunks):
            return

        # Create the collection if needed
        if checkCollection and not self.createCollection(chunks):
            return

        # Clear the object id list
        objectIds: Dict = {}

        # For each document
        for chunk in chunks:
            # Save this object id
            objectIds[chunk.metadata.objectId] = True

        # Erase all documents/chunks associated with that ObjectId in one operation
        # so we can cleanly insert the new version
        if len(objectIds.keys()):
            filter_condition = f"meta['objectId'] in [{', '.join(json.dumps(k) for k in objectIds.keys())}]"
            try:
                # Delete entities
                self.client.delete(collection_name=self.collection, filter=filter_condition)
            except Exception as e:
                engLib.debug(f'Error deleting old chunks: {e}')

        # Collect chunks into batches for bulk upsert instead of one-at-a-time
        batch: List[dict] = []

        def flush_batch():
            nonlocal batch
            if not batch:
                return
            try:
                self.client.upsert(collection_name=self.collection, data=batch)
                engLib.debug(f'Milvus bulk upsert: {len(batch)} chunks inserted')
            except Exception as e:
                engLib.debug(f'Error during bulk upsert ({len(batch)} chunks): {e}')
                raise
            batch = []

        # For each document
        for chunk in chunks:
            # Get the embedding
            embedding = chunk.embedding

            # If we do not have an embedding
            if embedding is None:
                raise Exception('No embedding in document')

            # Append the points // create a unique identifier that fits into an int64 id field
            tmp_struct = {'id': np.int64(((uuid.uuid1().time & 0x1FFFFFFFF) << 27) | random.getrandbits(27)), 'vector': embedding, 'content': chunk.page_content, 'meta': chunk.metadata}

            batch.append(tmp_struct)

            # Flush when batch reaches configured size
            if len(batch) >= self.bulkInsertBatchSize:
                flush_batch()

        # Flush any remaining chunks
        flush_batch()

    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all documents with a matching objectIds from the document store.
        """
        # By definition, if the collection does not exists, there
        # is nothing to delete
        if not self.doesCollectionExist():
            return

        must_conditions = []

        # If a permissionId list was specified
        if objectIds:
            objectIdsJoint = ', '.join(f"'{_escape_milvus_str(o)}'" for o in objectIds)
            must_conditions.append(f"meta['objectId'] in [{objectIdsJoint}]")

        filter_expression = ' and '.join(must_conditions) if must_conditions else None
        if filter_expression:
            try:
                self.client.delete(collection_name=self.collection, filter=filter_expression, timeout=self.timeout)
            except Exception as e:
                engLib.debug(f'Error removing documents: {e}')
                raise

        return

    def _batchUpsertResults(self, results: List[dict], *, isDeleted: bool) -> None:
        """
        Batch-update the isDeleted metadata field on a list of query results.

        Collects results into batches of bulkInsertBatchSize and upserts them
        together, avoiding the performance bottleneck of one-at-a-time upserts.
        """
        batch: List[dict] = []

        for result in results:
            meta = result.get('meta', {})
            meta['isDeleted'] = isDeleted
            result['meta'] = meta
            batch.append(result)

            if len(batch) >= self.bulkInsertBatchSize:
                self.client.upsert(collection_name=self.collection, data=batch)
                batch = []

        # Flush remaining
        if batch:
            self.client.upsert(collection_name=self.collection, data=batch)

    def markDeleted(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as deleted.

        They then will not be returned from the search without specifying deleted=True
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not self.doesCollectionExist():
            return

        must_conditions = []

        # If a permissionId list was specified
        if objectIds:
            objectIdsJoint = ', '.join(f"'{_escape_milvus_str(o)}'" for o in objectIds)
            must_conditions.append(f"meta['objectId'] in [{objectIdsJoint}]")

        filter_expression = ' and '.join(must_conditions) if must_conditions else None
        if not filter_expression:
            return

        results = self.client.query(collection_name=self.collection, filter=filter_expression, output_fields=['id', 'vector', 'content', 'meta'])

        # Batch-update instead of one-at-a-time to avoid performance bottleneck
        self._batchUpsertResults(results, isDeleted=True)
        return

    def markActive(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as active.

        This occurs if a document now "comes back" after begin deleted
        """
        # By definition, if the collection does not exists, there
        # is nothing to mark
        if not self.doesCollectionExist():
            return

        must_conditions = []

        # If a permissionId list was specified
        if objectIds:
            objectIdsJoint = ', '.join(f"'{_escape_milvus_str(o)}'" for o in objectIds)
            must_conditions.append(f"meta['objectId'] in [{objectIdsJoint}]")

        filter_expression = ' and '.join(must_conditions) if must_conditions else None
        if not filter_expression:
            return

        results = self.client.query(collection_name=self.collection, filter=filter_expression, output_fields=['id', 'vector', 'content', 'meta'])

        # Batch-update instead of one-at-a-time to avoid performance bottleneck
        self._batchUpsertResults(results, isDeleted=False)
        return

    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """
        Given an object id, render the complete document.

        Rehydrates all the chunks into the proper order.
        """
        # By definition, if the collection does not exists, there
        # is nothing to render
        if not self.doesCollectionExist():
            return

        must_condition = []

        # Since chunks are returned in any order, and a single objectId
        # may contain tens of thousands of chunks, we grave them one
        # group at a time (renderChunkSize), put them into an array,
        # join them and call the callback
        offset = 0
        while True:
            # Build filter for getting a set of chunks within the offset range
            must_condition = f"(meta['objectId'] == '{_escape_milvus_str(objectId)}') && ({offset - 1} < meta['chunkId'] < {offset + self.renderChunkSize})"

            results = self.client.query(collection_name=self.collection, filter=must_condition, output_fields=['meta', 'content'])

            # Create a renderChunkSize array with empty
            # entries. This will allow us to join even when
            # a chunk doesn't come back
            # Process the results
            text = [''] * self.renderChunkSize
            lastIndex = -1

            for point in results:
                content = point['content']
                chunk = point['chunkId']
                index = chunk - offset

                # Should never happen since we gave it an offset
                if chunk < offset:
                    continue

                text[index] = content
                if index > lastIndex:
                    lastIndex = index

            # Compute the number of items we are going to process
            numberOfItems = lastIndex + 1

            # If we got no items back, we are done
            if numberOfItems < 1:
                break

            # Join it together
            fullText = ''.join(text[0:numberOfItems])

            # Call the output function
            callback(fullText)

            # If we got less than we asked for, must be done
            if numberOfItems < self.renderChunkSize:
                break

            offset += self.renderChunkSize
