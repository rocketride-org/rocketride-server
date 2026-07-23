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
# Interface implementation for the Qdrant store
# ------------------------------------------------------------------------------
# We now have real requirements, so load them before we start
# loading our driver
import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import List, Callable, Dict, Any, cast
import numpy as np
import re

import weaviate
from weaviate.client import WeaviateClient
from weaviate.classes.init import AdditionalConfig, Timeout, Auth
from weaviate.classes.query import Filter, MetadataQuery
from weaviate.collections.collection import Collection
from weaviate.classes.config import VectorDistances
from weaviate.util import generate_uuid5
import weaviate.classes.config as wc

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.config import Config


class Store(DocumentStoreBase):
    apikey: str | None = None
    node: str = 'weaviate'
    collection: str = ''
    host: str = ''
    port: int = 0
    vectorSize: int = 0
    renderChunkSize: int = 32 * 1024 * 1024
    similarity: str = 'Cosine'
    client: WeaviateClient | None = None
    collectionObj: Collection | None = None
    similarityDict: dict = {
        'cosine': VectorDistances.COSINE,
        'dot': VectorDistances.DOT,
        'l2-squared': VectorDistances.L2_SQUARED,
        'hamming': VectorDistances.HAMMING,
        'manhattan': VectorDistances.MANHATTAN,
    }

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the weaviate vector store.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get our configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Save our parameters
        self.collection = config.get('collection')

        # Remove leading and trailing spaces, leading http/https and :// and trailing slashes
        self.host = re.sub(r'^https?://', '', config.get('host').strip()).rstrip('/')
        self.port = config.get('port', None)
        self.grpc_port = config.get('grpc_port', None)

        # Strip API key also
        self.apikey = config.get('apikey', None)
        if self.apikey is not None:
            self.apikey = self.apikey.strip()

        self.renderChunkSize = config.get('renderChunkSize', self.renderChunkSize)
        self.threshold_search = config.get('score', 0.5)

        profile = config.get('mode')

        # check if the similarity matches milvus configuration options
        similarity = config.get('similarity', 'cosine')
        if similarity in ['cosine', 'dot', 'l2-squared', 'hamming', 'manhattan']:
            self.similarity = self.similarityDict[similarity]
        else:
            raise Exception(
                'The metric you provided in the config.json does not match required weaviate configurations'
            )

        if profile == 'cloud':
            self.client = weaviate.connect_to_weaviate_cloud(
                cluster_url=self.host,
                auth_credentials=Auth.api_key(self.apikey),
                additional_config=AdditionalConfig(
                    timeout=Timeout(init=30, query=60, insert=120)  # Values in seconds
                ),
            )
        else:
            if self.apikey is None or self.apikey == '':
                self.client = weaviate.connect_to_local(
                    host=self.host,
                    port=self.port,
                    grpc_port=self.grpc_port,
                    additional_config=AdditionalConfig(
                        timeout=Timeout(init=30, query=60, insert=120)  # Values in seconds
                    ),
                )
            else:
                self.client = weaviate.connect_to_local(
                    host=self.host,
                    port=self.port,
                    grpc_port=self.grpc_port,
                    auth_credentials=Auth.api_key(self.apikey),
                    additional_config=AdditionalConfig(
                        timeout=Timeout(init=30, query=60, insert=120)  # Values in seconds
                    ),
                )

        return

    def __del__(self):
        """
        Deinitialize the weaviate client.
        """
        # Deinit everything we did
        self.collection = ''
        self.renderChunkSize = 0
        self.similarity = 'cosine'

        # Close the client to omit memory leaks
        if self.client is not None:
            self.client.close()
        self.client = None

        self.apikey = None
        self.vectorSize = 0
        self.collectionObj = None

    def _doesCollectionExist(self) -> bool:
        """
        Check if the collection exists.
        """
        if self.client is None:
            return False
        if self.client.collections.exists(name=self.collection):
            if self.collectionObj is None:
                self.collectionObj = self.client.collections.get(name=self.collection)
            return True
        else:
            return False

    def _createCollection(self, vectorSize: int = 0) -> None:
        """
        Create a collection, doesn't return anything.

        Function has the same parameters for consistency
        """
        self.collectionObj = self.client.collections.create(
            name=self.collection,
            properties=[
                wc.Property(name='content', data_type=wc.DataType.TEXT),
                wc.Property(name='objectId', data_type=wc.DataType.TEXT),
                wc.Property(name='nodeId', data_type=wc.DataType.TEXT),
                wc.Property(name='parent', data_type=wc.DataType.TEXT),
                wc.Property(name='permissionId', data_type=wc.DataType.INT),
                wc.Property(name='isDeleted', data_type=wc.DataType.BOOL),
                wc.Property(name='chunkId', data_type=wc.DataType.INT),
                wc.Property(name='isTable', data_type=wc.DataType.BOOL),
                wc.Property(name='tableId', data_type=wc.DataType.INT),
                wc.Property(name='vectorSize', data_type=wc.DataType.INT),
                wc.Property(name='modelName', data_type=wc.DataType.TEXT),
            ],
            # Define the vectorizer module (none, as we will add our own vectors)
            vectorizer_config=wc.Configure.Vectorizer.none(),
            vector_index_config=wc.Configure.VectorIndex.hnsw(
                distance_metric=self.similarity,
            ),
        )

    def _convertFilter(self, docFilter: DocFilter) -> Filter:
        """
        Build the generic filter based on required permissions, node, parent, etc.
        """
        # Declare the must list to start addding conditions
        must: List[Filter] = []

        # If a nodeId was specified
        if docFilter.nodeId is not None:
            must.append(Filter.by_property('nodeId').equal(docFilter.nodeId))

        if docFilter.isTable is not None:
            must.append(Filter.by_property('isTable').equal(docFilter.isTable))

        if docFilter.tableIds is not None:
            may: List[Filter] = []
            for tableId in docFilter.tableIds:
                may.append(Filter.by_property('tableId').equal(tableId))
            must.append(Filter.any_of(may))

        if docFilter.parent is not None:
            must.append(Filter.by_property('parent').equal(docFilter.parent))

        if docFilter.permissions is not None:
            may: List[Filter] = []
            for permissionId in docFilter.permissions:
                may.append(Filter.by_property('permissionId').equal(permissionId))
            must.append(Filter.any_of(may))

        if docFilter.objectIds is not None:
            may: List[Filter] = []
            for objectId in docFilter.objectIds:
                may.append(Filter.by_property('objectId').equal(objectId))
            must.append(Filter.any_of(may))

        if docFilter.isDeleted is None or not docFilter.isDeleted:
            must.append(Filter.by_property('isDeleted').equal(False))

        if docFilter.chunkIds is not None:
            may: List[Filter] = []
            for chunkId in docFilter.chunkIds:
                may.append(Filter.by_property('chunkId').equal(chunkId))
            must.append(Filter.any_of(may))

        if docFilter.minChunkId is not None:
            must.append(Filter.by_property('chunkId').greater_or_equal(docFilter.minChunkId))

        if docFilter.maxChunkId is not None:
            must.append(Filter.by_property('chunkId').less_or_equal(docFilter.maxChunkId))

        return Filter.all_of(must)

    def _convertToDocs(self, points: Dict) -> List[Doc]:
        """
        Convert a list of points or records to a docGroup.

        Groupsall document chunks  together
        """
        docs: List[Doc] = []

        # Now, add the documents to the results
        for point in points:
            # Get the payload content and metadata
            metadata = cast(
                DocMetadata, {k: v for k, v in point.properties.items() if k not in {'content'} and v is not None}
            )
            content = point.properties.get('content')

            if point.metadata.distance is not None:
                if self.similarity == 'cosine':
                    score = (point.metadata.distance + 1) / 2
                else:
                    score = float(1.0 / (1.0 + np.exp(point.metadata.distance / -100)))

                # Ignore it if it doesn't have a high enough score
                if score < 0.20:
                    continue
            else:
                score = 0.0

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

        response = self.collectionObj.aggregate.over_all(total_count=True)
        return response.total_count

    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Keyword search.
        """
        # If the collection does not exists, by definition there are
        # no search results to return
        if not self.doesCollectionExist():
            return []

        # Declare the results list
        docs: List[Doc] = []

        # Build up the filters
        filter = self._convertFilter(docFilter=docFilter)

        points = self.collectionObj.query.fetch_objects(
            filters=(filter & Filter.by_property('content').like(f'*{query}*')),
            limit=docFilter.limit,
        )

        # Convert the points into groups
        docs = self._convertToDocs(points.objects)

        return docs

    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Semantic search.
        """
        # If the collection does not exists, by definition there are
        # no search results to return
        if not self.doesCollectionExist():
            return []

        # Declare the results list
        docs: List[Doc] = []

        # Build up the filters
        filter = self._convertFilter(docFilter=docFilter)

        # We know the collection exists, now we can check to make sure the
        # embedding is correct. This will throw if the model doesn't match
        self.doesCollectionExist(query.embedding_model)

        # Check embedding
        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')

        # We cannot support non-zero offsets
        if docFilter.offset:
            raise BaseException('Non-zero offset is not supported in semantic searching')

        points = self.collectionObj.query.near_vector(
            near_vector=query.embedding,
            filters=filter,
            limit=25 if docFilter.limit <= 10 else docFilter.limit,
            return_metadata=MetadataQuery(distance=True),
        )

        # Convert the points into groups
        docs = self._convertToDocs(points.objects)

        # Return them
        return docs

    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """
        Retrieve document groups matching a given filter.
        """
        # If the collection does not exists, by definition there are
        # no documents matching the get
        if checkCollection and not self.doesCollectionExist():
            return []

        # Convert filter to Weaviate format
        filter_expr = self._convertFilter(docFilter)

        results = self.collectionObj.query.fetch_objects(filters=filter_expr, limit=docFilter.limit)
        # Convert results to Docs
        return self._convertToDocs(results.objects)

    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        Retrieve unique parent paths.
        """
        # If the collection does not exists, by definition there are
        # no paths to return
        if not self.doesCollectionExist():
            return {}

        must: List[Filter] = []
        must.append(Filter.by_property('chunkId').equal(0))

        # If parent specified, add condition
        if parent is not None:
            must.append(Filter.by_property('parent').equal(parent))

        # Perform the query
        results = self.collectionObj.query.fetch_objects(filters=Filter.all_of(must), offset=offset, limit=limit)

        docs = self._convertToDocs(results.objects)

        # Build paths dictionary
        paths = {}
        for record in docs:
            parent_id = record.metadata['parent']
            object_id = record.metadata['objectId']

            if parent_id and object_id:
                paths[parent_id] = object_id

        return paths

    def addChunks(self, chunks: List[Doc], checkCollection: bool = True) -> None:
        """
        Add document chunks to the document store.
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
        # TODO: Start discussion about better use of upsert() method to increase performance)
        if len(objectIds):
            # Delete entities
            objectIdFilter: List[Filter] = []
            for objectId in objectIds:
                objectIdFilter.append(Filter.by_property('objectId').equal(objectId))
            self.collectionObj.data.delete_many(where=Filter.any_of(objectIdFilter))

        # Enter context manager
        with self.collectionObj.batch.dynamic() as batch:
            # For each document
            for chunk in chunks:
                # Build the object payload
                data = {
                    'content': chunk.page_content,
                }
                data.update(chunk.metadata)

                unique_identifier = ','.join([f'{key}={value}' for key, value in data.items()])
                # Get the embedding
                embedding = chunk.embedding

                # If we do not have an embedding
                if embedding is None:
                    raise Exception('No embedding in document')

                # Add object (including vector) to batch queue
                batch.add_object(properties=data, uuid=generate_uuid5(unique_identifier), vector=chunk.embedding)

        # Check for failed objects
        if len(self.collectionObj.batch.failed_objects) > 0:
            raise Exception(f'Failed to import {len(self.collectionObj.batch.failed_objects)} objects')

        return

    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all documents with a matching objectIds from the document store.
        """
        # By definition, if the collection does not exists, there
        # is nothing to delete
        if not self.doesCollectionExist():
            return

        if not objectIds:
            return

        objectIdsFilter: List[Filter] = []
        for objectId in objectIds:
            objectIdsFilter.append(Filter.by_property('objectId').equal(objectId))
        self.collectionObj.data.delete_many(where=Filter.any_of(objectIdsFilter))
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

        if not objectIds:
            return

        objectIdsFilter: List[Filter] = []
        for objectId in objectIds:
            objectIdsFilter.append(Filter.by_property('objectId').equal(objectId))
        points = self.collectionObj.query.fetch_objects(filters=Filter.any_of(objectIdsFilter))
        for point in points.objects:
            self.collectionObj.data.update(
                uuid=point.uuid,
                properties={
                    'isDeleted': True,
                },
            )
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

        if not objectIds:
            return

        objectIdsFilter: List[Filter] = []
        for objectId in objectIds:
            objectIdsFilter.append(Filter.by_property('objectId').equal(objectId))
        points = self.collectionObj.query.fetch_objects(filters=Filter.any_of(objectIdsFilter))
        for point in points.objects:
            self.collectionObj.data.update(
                uuid=point.uuid,
                properties={
                    'isDeleted': False,
                },
            )
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

        # Since chunks are returned in any order, and a single objectId
        # may contain tens of thousands of chunks, we grave them one
        # group at a time (renderChunkSize), put them into an array,
        # join them and call the callback
        offset = 0
        while True:
            # Build filter for getting a set of chunks within the offset range
            points = self.collectionObj.query.fetch_objects(
                filters=(
                    Filter.by_property('objectId').equal(objectId)
                    & Filter.by_property('chunkId').greater_or_equal(offset)
                    & Filter.by_property('chunkId').less_than(offset + self.renderChunkSize)
                )
            )

            # Create a renderChunkSize array with empty
            # entries. This will allow us to join even when
            # a chunk doesn't come back
            # Process the results
            text = [''] * self.renderChunkSize
            lastIndex = -1

            for point in points.objects:
                content = point.properties.get('content')
                chunk = point.properties.get('chunkId')
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
