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

# Load what we need
from typing import List, Callable, cast, Dict, Any
from uuid import uuid4
import sys
import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import (
    PointStruct,
    Filter,
    FieldCondition,
    Record,
    MatchValue,
    Range,
    SearchParams,
    TextIndexParams,
    TokenizerType,
    PayloadSchemaType,
    TextIndexType,
    ScoredPoint,
)
from qdrant_client.http import models
from qdrant_client.conversions import common_types as types

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.config import Config

"""
NOTE: https://qdrant.tech/documentation/concepts/indexing/

This ***MAY*** be a problem, but since we provide our own embeddings, probably not...
However, this may affect the full text search and the parsing of words in the payload...

Qdrant does not support all languages out of the box:

multilingual - special type of tokenizer based on charabia package. It allows proper
tokenization and lemmatization for multiple languages, including those with non-latin
alphabets and non-space delimiters. See charabia documentation for full list of supported
languages supported normalization options. In the default build configuration, qdrant does
not include support for all languages, due to the increasing size of the resulting
binary. Chinese, Japanese and Korean languages are not enabled by default, but can be
enabled by building qdrant from source with
--features multiling-chinese,multiling-japanese,multiling-korean flags.
"""


class Store(DocumentStoreBase):
    apikey: str | None = None
    node: str = 'qdrant'
    collection: str = ''
    host: str = ''
    port: int = 0
    vectorSize: int = 0
    renderChunkSize: int = 32 * 1024 * 1024
    payload_limit: int = 32 * 1024 * 1024
    similarity: str = 'Cosine'
    threshold_search: float = 0.0
    client: QdrantClient | None = None

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the qdrant vector store.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Save our parameters
        self.collection = config.get('collection')

        self.host = (config.get('host', '') or '').strip().rstrip('/')
        self.port = config.get('port')

        self.apikey = config.get('apikey', None)
        if self.apikey is not None:
            self.apikey = self.apikey.strip()

        self.renderChunkSize = config.get('renderChunkSize', self.renderChunkSize)
        self.payload_limit = config.get('payloadLimit', self.payload_limit)
        self.threshold_search = config.get('score', 0.5)

        similarity = config.get('similarity', 'Cosine')
        if similarity in ['Cosine', 'Euclid', 'Dot', 'Manhattan']:
            self.similarity = similarity
        else:
            raise Exception('The metric you provided in the config.json does not match required qdrant configurations')

        if '://' in self.host:
            url = f'{self.host}:{self.port}'
        else:
            url = f'http://{self.host}:{self.port}'
        self.client = QdrantClient(url=url, api_key=self.apikey, prefer_grpc=False, timeout=60)
        return

    def __del__(self):
        """
        Deinitializes the qdrant client.
        """
        # Deinit everything we did
        self.apikey = None
        self.collection = ''
        self.renderChunkSize = 0
        self.similarity = 'Cosine'
        self.client = None

    def _doesCollectionExist(self) -> bool:
        """
        Check if the collection exists.
        """
        if self.client is None:
            return False
        return self.client.collection_exists(collection_name=self.collection)

    def _createCollection(self, vectorSize: int) -> bool:
        """
        Create a collection, doesn't return anything.

        It must create a new collection even if one already exists.
        The reason for this is that there are actually three parts to
        an the collection:
            1. The collection itself
            2. The payload schema
            3. A bogus record containing the model/vector size
        If the creation fails somewhere along the way, the base Store class
        will recognize that the collection does not exists (intact anyway)
        and call this function to start setting it up again
        """
        # Build the parameters
        vector_params = types.VectorParams(size=vectorSize, distance=self.similarity)

        # Create the collection
        self.client.create_collection(collection_name=self.collection, vectors_config=vector_params)

        # See if we can get the collection info, throws if it does not exist or other error
        info = self.client.get_collection(collection_name=self.collection)

        # If we do not have a payload schema yet
        if not len(info.payload_schema):
            # Setup our payload index so we can query by nodeId
            self.client.create_payload_index(
                collection_name=self.collection, field_name='meta.nodeId', field_type=PayloadSchemaType.KEYWORD
            )

            # Setup our payload index so we can query by object id
            self.client.create_payload_index(
                collection_name=self.collection, field_name='meta.objectId', field_type=PayloadSchemaType.KEYWORD
            )

            # Setup our payload index so we can query by parent path
            self.client.create_payload_index(
                collection_name=self.collection, field_name='meta.parent', field_type=PayloadSchemaType.KEYWORD
            )

            # Setup our payload index so we can query by permission id
            self.client.create_payload_index(
                collection_name=self.collection, field_name='meta.permissionId', field_type=PayloadSchemaType.INTEGER
            )

            # Setup our payload index so we can query by isDeleted
            self.client.create_payload_index(
                collection_name=self.collection, field_name='meta.isDeleted', field_type=PayloadSchemaType.BOOL
            )

            # Setup our payload index so we can query by isTable
            self.client.create_payload_index(
                collection_name=self.collection, field_name='meta.isTable', field_type=PayloadSchemaType.BOOL
            )

            # Setup a full text keyword search on our content
            self.client.create_payload_index(
                collection_name=self.collection,
                field_name='content',
                field_schema=TextIndexParams(
                    type=TextIndexType.TEXT,
                    tokenizer=TokenizerType.WORD,
                    min_token_len=2,
                    max_token_len=15,
                    lowercase=True,
                ),
            )

        return True

    def _convertFilter(self, docFilter: DocFilter) -> Filter:
        """
        Build the generic filter based on required permissions, node, parent, etc.
        """
        # Declare the mist list to start addding conditions
        must: List[models.Condition] = []

        # If a nodeId was specified
        if docFilter.nodeId is not None:
            must.append(models.FieldCondition(key='meta.nodeId', match=models.MatchValue(value=docFilter.nodeId)))

        if docFilter.isTable is not None:
            must.append(models.FieldCondition(key='meta.isTable', match=models.MatchValue(value=docFilter.isTable)))

        if docFilter.tableIds is not None:
            must.append(models.FieldCondition(key='meta.tableId', match=models.MatchAny(any=docFilter.tableIds)))

        # If a parent was specified
        if docFilter.parent is not None:
            must.append(models.FieldCondition(key='meta.parent', match=models.MatchText(text=docFilter.parent)))

        # If a permissionId list was specified
        if docFilter.permissions is not None:
            must.append(
                models.FieldCondition(key='meta.permissionId', match=models.MatchAny(any=docFilter.permissions))
            )

        # If a objectIds list was specified
        if docFilter.objectIds is not None:
            must.append(models.FieldCondition(key='meta.objectId', match=models.MatchAny(any=docFilter.objectIds)))

        # If we are not going after deleted docs, add a condition
        if docFilter.isDeleted is None or not docFilter.isDeleted:
            must.append(models.FieldCondition(key='meta.isDeleted', match=models.MatchValue(value=False)))

        # If we are not going after chunks, add a condition
        if docFilter.chunkIds is not None:
            must.append(models.FieldCondition(key='meta.chunkId', match=models.MatchAny(any=docFilter.chunkIds)))

        # If we are min chunk id, add a condition
        if docFilter.minChunkId is not None:
            must.append(models.FieldCondition(key='meta.chunkId', range=models.Range(gte=docFilter.minChunkId)))

        # If we are min chunk id, add a condition
        if docFilter.maxChunkId is not None:
            must.append(models.FieldCondition(key='meta.chunkId', range=models.Range(lte=docFilter.maxChunkId)))

        # Determine the basic must conditions
        return Filter(must=must)

    def _convertToDocs(self, points: List[ScoredPoint] | List[Record]) -> List[Doc]:
        """
        Convert a list of points or records to a docGroup.

        Groups all document chunks  together
        """
        docs: List[Doc] = []

        # Now, add the documents to the results
        for point in points:
            # If we don't have a payload, skip it
            if point.payload is None:
                continue

            # Get the payload content and meadata
            metadata = DocMetadata(**point.payload['meta'])
            content = point.payload['content']

            # Determine the score of this document
            if isinstance(point, ScoredPoint):
                # If we are return scaled scores, build it
                if self.similarity == 'Cosine':
                    score = (point.score + 1) / 2
                else:
                    score = float(1.0 / (1.0 + np.exp(point.score / -100)))

                # Ignore it if it doesn't have a high enough score
                if score < 0.20:
                    continue
            else:
                score = 0

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

        # Get the collection info
        info: types.CollectionInfo = self.client.get_collection(collection_name=self.collection)

        # Get the vector parameters
        return info.vectors_count

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

        # Build up the filter
        filter = self._convertFilter(docFilter)

        # Add a condition for the keyword
        if filter.must is None:
            filter.must = []

        filter.must.append(models.FieldCondition(key='content', match=models.MatchText(text=query.text)))

        # Perform the search
        records, nextURL = self.client.scroll(
            collection_name=self.collection,
            scroll_filter=filter,
            offset=docFilter.offset,
            limit=docFilter.limit,
            with_vectors=False,
        )

        # Convert the points into groups
        docs = self._convertToDocs(records)

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

        # Declare the results list
        docs: List[Doc] = []

        # Build up the filter
        filter = self._convertFilter(docFilter)

        # We know the collection exists, now we can check to make sure the
        # embedding is correct. This will throw if the model doesn't match
        self.doesCollectionExist(query.embedding_model)

        # Check embedding
        if query.embedding is None:
            raise Exception('To use semantic search, you must bind to an embedding module')

        # We cannot support non-zero offsets
        if docFilter.offset:
            raise BaseException('Non-zero offset is not supported in semantic searching')

        # Perform the search
        points = self.client.query_points(
            collection_name=self.collection,
            query=query.embedding,
            query_filter=filter,
            with_vectors=False,
            with_payload=True,
            limit=docFilter.limit if docFilter.limit is not None else 25,
            score_threshold=self.threshold_search,
            search_params=SearchParams(exact=True),
        ).points

        # Convert the points into groups
        docs = self._convertToDocs(points)

        # Return them
        return docs

    def get(self, docFilter: DocFilter, checkCollection: bool = True) -> List[Doc]:
        """
        Given a filter, this will return the document groups matching the filter.
        """
        # If the collection does not exists, by definition there are
        # no documents matching the get
        if checkCollection and not self.doesCollectionExist():
            return []

        # Build up the filter
        filter = self._convertFilter(docFilter=docFilter)

        # Perform the search
        records, nextPoint = self.client.scroll(
            collection_name=self.collection,
            scroll_filter=filter,
            offset=docFilter.offset,
            limit=docFilter.limit,
            with_vectors=False,
        )

        # Convert the points into documents
        docs = self._convertToDocs(records)
        return docs

    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        Query and return all the unique parent paths.
        """
        # If the collection does not exists, by definition there are
        # no paths to return
        if not self.doesCollectionExist():
            return {}

        # Build the base
        must: List[models.Condition] = [FieldCondition(key='meta.chunkId', match=models.MatchValue(value=0))]

        # If parent specified, match on it
        if parent is not None:
            must.append(FieldCondition(key='meta.parent', match=models.MatchText(text=parent)))

        # Build a filter to just ask for chunk 0
        filter = Filter(must=must)

        # Build up the path list
        paths: Dict[str, str] = {}

        # Perform the search
        records, nextPoint = self.client.scroll(
            collection_name=self.collection,
            scroll_filter=filter,
            offset=offset,
            limit=limit,
            with_vectors=False,
            with_payload=True,
        )

        # Fill it in
        for record in records:
            # Get the payload
            payload = record.payload
            if payload is None:
                continue

            # Get the info
            metadata = cast(DocMetadata, payload['meta'])

            # Get the parent
            parent = metadata.parent

            # Add it
            paths[parent] = metadata.objectId

        # And return what we found
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

        # Clear the points
        points: List[models.PointStruct] = []

        # Clear the object id list
        objectIds: Dict = {}

        def flush():
            nonlocal points
            nonlocal objectIds
            ops = []

            # Build the batch operation for deletion
            if len(objectIds):
                ops.append(
                    models.DeleteOperation(
                        delete=models.FilterSelector(
                            filter=Filter(
                                must=[
                                    FieldCondition(
                                        key='meta.objectId', match=models.MatchAny(any=list(objectIds.keys()))
                                    )
                                ]
                            )
                        )
                    )
                )

            # Build the batch operation for insert
            if len(points):
                ops.append(models.UpsertOperation(upsert=models.PointsList(points=points)))

            # If we have nothing to do, done
            if not len(ops):
                return

            # Perform the batch
            self.client.batch_update_points(collection_name=self.collection, update_operations=ops)

            # Clear them
            objectIds = {}
            points = []

        # For each document
        for chunk in chunks:
            # If we are writing chunk 0, then delete the object
            if not chunk.metadata.chunkId:
                # Save this object id to be deleted
                objectIds[chunk.metadata.objectId] = True

        sum_size = 0
        cur_size = 0
        # For each document
        for chunk in chunks:
            # Get the embedding
            embedding = chunk.embedding

            # If we do not have an embedding
            if embedding is None:
                raise Exception('No embedding in document')

            # Append the points
            tmp_struct = PointStruct(
                id=str(uuid4()), vector=embedding, payload={'content': chunk.page_content, 'meta': chunk.metadata}
            )
            cur_size = sys.getsizeof(tmp_struct)
            sum_size += cur_size
            points.append(tmp_struct)

            if (len(points) >= 500) or (sum_size + cur_size > self.payload_limit):
                flush()
                cur_size = 0
                sum_size = 0

        # Flush any stragglers
        flush()

    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all documents with a matching objectIds from the document store.
        """
        # By definition, if the collection does not exists, there
        # is nothing to delete
        if not self.doesCollectionExist():
            return

        # Build a filter for an object id
        filter_objectId = Filter(must=[FieldCondition(key='meta.objectId', match=models.MatchAny(any=objectIds))])

        # Delete the points with the given object Id
        self.client.delete(collection_name=self.collection, points_selector=filter_objectId, wait=True)
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

        # Build a filter for an object id
        filter_objectId = Filter(must=[FieldCondition(key='meta.objectId', match=models.MatchAny(any=objectIds))])

        # Set all the objects with the given objectId to true
        self.client.set_payload(
            collection_name=self.collection, payload={'meta': {'isDeleted': True}}, points=filter_objectId
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

        # Build a filter for an object id
        filter_objectId = Filter(must=[FieldCondition(key='meta.objectId', match=models.MatchAny(any=objectIds))])

        # Set all the objects with the given objectId to false
        self.client.set_payload(
            collection_name=self.collection, payload={'meta': {'isDeleted': False}}, points=filter_objectId
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
            # Build  filter for getting a set of chunks
            filter_range = FieldCondition(key='meta.chunkId', range=Range(gte=offset, lt=offset + self.renderChunkSize))

            # Build a filter for an object id
            filter_objectId = FieldCondition(key='meta.objectId', match=MatchValue(value=objectId))

            # Perform the query
            records, nextPoint = self.client.scroll(
                collection_name=self.collection,
                scroll_filter=Filter(must=[filter_objectId, filter_range]),
                limit=self.renderChunkSize,
                with_payload=True,
            )

            # Create a renderChunkSize array with empty
            # entries. This will allow us to join even when
            # a chunk doesn't come back
            text: List[str] = [''] * self.renderChunkSize
            lastIndex = -1

            # Now, add the documents to the results
            for record in records:
                # Get the payload
                payload = record.payload
                if payload is None:
                    continue

                # Get the info
                metadata = DocMetadata(**payload['meta'])
                content = payload['content']
                chunk = metadata.chunkId

                # Should never happen since we gave it an offset
                if chunk < offset:
                    continue

                # Should never happen since we gave it a range
                if chunk >= offset + self.renderChunkSize:
                    continue

                # Get the index into the array
                index = chunk - offset

                # Add it to our array
                text[index] = content

                # Determine the highest index we use
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
