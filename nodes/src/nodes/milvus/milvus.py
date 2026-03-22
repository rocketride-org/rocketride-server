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


def _escape_milvus_str(value):
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

        profile = config.get('mode')

        # check if the similarity matches milvus configuration options
        similarity = config.get('similarity', 'COSINE')
        if similarity in ['L2', 'IP', 'COSINE', 'JACCARD', 'HAMMING', 'BM25']:
            self.similarity = similarity
        else:
            raise Exception('The metric you provided in the config.json does not match required milvus configurations')

        # Establish a connection // TODO: Revise alternative setup as this connection action is only necessary for the flush() method
        if profile != 'local':
            # Init the store
            if self.host.startswith('https:') or self.host.startswith('http:'):
                self.client = MilvusClient(uri=self.host, token=self.apikey, timeout=20)
            else:
                self.client = MilvusClient(uri=f'https://{self.host}', token=self.apikey, timeout=20)
        else:
            self.client = MilvusClient(uri=f'http://{self.host}:{self.port}', timeout=20)

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
            (must_conditions.append(f"meta['nodeId'] == '{_escape_milvus_str(docFilter.nodeId)}'"),)

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
                # If we are return scaled scores, build it TODO: CHECK IF THIS IS ALSO THE CASE FOR MILVUS (-1 to 1 range) OR MIGHT IT BE CORRECTED ALREADY?
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

            # Create asearc new document
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
        Addsdocument chunks to the document store.
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

        # Erase all documents/chunks associated with that ObjectId in one operation (TODO: Start discussion about better use of upsert() method to increase performance)
        if len(objectIds.keys()):
            filter_condition = f"meta['objectId'] in [{', '.join(json.dumps(k) for k in objectIds.keys())}]"
            try:
                # Delete entities
                self.client.delete(collection_name=self.collection, filter=filter_condition)
            except Exception as e:
                engLib.debug(f'Error deleting old chunks: {e}')

        # TODO: Consider implementing a bulk insertion https://milvus.io/api-reference/pymilvus/v2.4.x/ORM/utility/do_bulk_insert.md
        # Disatvantage here is that is will require to reformat interation data into a JSON file format

        # For each document
        for chunk in chunks:
            # Get the embedding
            embedding = chunk.embedding

            # If we do not have an embedding
            if embedding is None:
                raise Exception('No embedding in document')

            # Append the points // create a unique identifier that fits into an int64 id field
            tmp_struct = {'id': np.int64(((uuid.uuid1().time & 0x1FFFFFFFF) << 27) | random.getrandbits(27)), 'vector': embedding, 'content': chunk.page_content, 'meta': chunk.metadata}

            # TODO: Consider printing out upsert count for debugging and imprement bulk insert
            self.client.upsert(collection_name=self.collection, data=[tmp_struct])

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

        # TODO: Add time out
        filter_expression = ' and '.join(must_conditions) if must_conditions else None
        if filter_expression:
            self.client.delete(collection_name=self.collection, filter=filter_expression)

        return

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

        results = self.client.query(collection_name=self.collection, filter=filter_expression)

        # Update the 'isDeleted' field for each result -> TODO: Might there be a better way to do this? Looping over the
        # vecotrs can be a performance bottleneck and additionally whats the oint if all entries will be deleled shortly after?
        for result in results:
            result['isDeleted'] = True
            # Assuming there's a method to update the document in the client
            self.client.upsert(collection_name=self.collection, data=result)
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

        results = self.client.query(collection_name=self.collection, filter=filter_expression)

        # Update the 'isDeleted' field for each result -> TODO: Might there be a better way to do this? Looping over the
        # vecotrs can be a performance bottleneck and additionally whats the oint if all entries will be deleled shortly after?
        for result in results:
            result['isDeleted'] = False
            # Assuming there's a method to update the document in the client
            self.client.upsert(collection_name=self.collection, data=result)
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

            results = self.client.query(collection_name=self.collection, filter=must_condition)

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
