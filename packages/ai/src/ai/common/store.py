import importlib
import json
import threading
from abc import abstractmethod, ABC
from typing import List, Callable, Dict, Any, Optional, Tuple
from rocketlib import IInstanceBase, tool_function, warning
from .schema import Doc, DocFilter, DocMetadata, Question, QuestionText, QuestionType, Answer


class DocumentStoreBase(ABC):
    """
    Base class for all vector storage drivers.

    The DocumentStoreBase class is used to abstract the details of the DocumentStore
    so it can be dynamically changed to a different provider. Some methods are abstract
    which must be implemented in the actual providers, but some of the utility functions
    are implemented here but can be overridden
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Define the default constructor.
        """
        self.vectorSize: int = 0
        self.modelName: str = ''
        self.threshold_search = 0.5
        self.collectionLock = threading.Lock()

    @abstractmethod
    def _doesCollectionExist() -> bool:
        """
        Return True if the collection exists, False otherwise.

        This the abstract method that the driver must implement
        """

    @abstractmethod
    def _createCollection() -> bool:
        """
        Create the collection.

        This the abstract method that the driver must implement
        """

    @abstractmethod
    def count_documents(self) -> int:
        """
        Return how many documents are present in the document store.
        """

    @abstractmethod
    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Return the documents that match the filters provided.
        """

    @abstractmethod
    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Return the documents that match the filters provided.
        """

    @abstractmethod
    def get(self, docFilter: DocFilter) -> List[Doc]:
        """
        Perform a database query to get objects.
        """

    @abstractmethod
    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        Query and return all the unique parent paths.
        """

    @abstractmethod
    def addChunks(self, chunks: List[Doc]) -> None:
        """
        Write (or overwrite) documents into the store.
        """

    @abstractmethod
    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all documents with a matching objectIds from the document store.
        """

    @abstractmethod
    def markDeleted(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as deleted.

        They then will not be returned from the search without specifying deleted=True
        """

    @abstractmethod
    def markActive(self, objectIds: List[str]) -> None:
        """
        Mark the set of documents with the given objectId as active.

        This occurs if a document now "comes back" after begin deleted
        """

    @abstractmethod
    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """
        Given an object id, render the complete document.

        Rehydrates all the chunks into the proper order.
        """

    def _getDocKey(self, doc: Doc) -> Tuple[str, int]:
        return (doc.metadata.objectId, doc.metadata.chunkId)

    def _getTableKey(self, doc: Doc) -> Tuple[str, int]:
        return (doc.metadata.objectId, doc.metadata.tableId)

    def _processFullTables(self, documents: Dict[Tuple[str, int], Doc]) -> Dict[Tuple[str, int], Doc]:
        """
        Process tables.

        This is post processing after a search has
        completed which reads the entire table and concatenates
        the documents of the tables into the first entry for
        that table
        """
        # Find the tables we need to process
        tableIds: Dict[str, List[int]] = {}
        tableDocs: Dict[Tuple[str, int], Doc] = {}
        for docKey, doc in documents.items():
            # If this is not a table, skip it
            if not doc.metadata.isTable:
                continue

            # Get the objectId and the table id
            objectId = doc.metadata.objectId
            tableId = doc.metadata.tableId

            # Add this table to the group to find
            if objectId not in tableIds:
                tableIds[objectId] = []

            # Append this table id
            if tableId not in tableIds[objectId]:
                tableIds[objectId].append(tableId)

            # Add this table to the score group
            tableKey = self._getTableKey(doc)
            if tableKey not in tableDocs:
                # Reset the page content, we build it up
                # in the next phase
                doc.page_content = ''

                # Save it
                tableDocs[tableKey] = doc

            # Update the score if this one is higher
            if doc.score > tableDocs[tableKey].score:
                tableDocs[tableKey] = doc.score

        # If there are no tables, done
        if not len(tableIds):
            return documents

        # Now, we can do our queries
        for objectId in tableIds.keys():
            # Build the filter
            tableFilter = DocFilter(isTable=True, objectIds=[objectId], tableIds=tableIds[objectId])

            # Get all the table chunks for these tables in
            # the document
            tableChunks = self.get(tableFilter)

            # Sort them by chunkId
            tableChunks.sort(key=lambda doc: doc.metadata.chunkId)

            # Gather up all the text of the table
            for chunk in tableChunks:
                # Get this chunks table key
                tableKey = self._getTableKey(chunk)

                # Get the object id
                objectId = chunk.metadata.objectId

                # If this is the first part of the table
                if tableKey not in tableDocs:
                    # Add it to the list
                    # TODO: Fix this
                    tableDocs[tableKey] = Doc(objectId=objectId, chunk=doc.metadata.chunkId, score=chunk.score)

                # Append the text
                tableDocs[tableKey].page_content += chunk.page_content

        # Now, we have the new documents built into tableDocs. The
        # key for this is (objectId/tableId). It has the highest score
        # returned in all of our chunks, and now has the page_content
        # containing the entire table. Rip through the original docs
        # and replace the table chunks with the new tableDocs
        newDocs: Dict[Tuple[str, int], Doc] = {}
        for docKey, doc in documents.items():
            # If this is not a table, we are not replacing it
            if not doc.metadata.isTable:
                newDocs[docKey] = doc
                continue

            # Get the table key of this document table
            tableKey = self._getTableKey(doc)

            # If this table is not there, it has already been replaced
            if tableKey not in tableDocs:
                continue

            # Get the new document key for this
            docKey = self._getDocKey(tableDocs[tableKey])

            # Add this to the new docs
            newDocs[docKey] = tableDocs[tableKey]

            # Remove it from the tableDocs
            del tableDocs[tableKey]

        # Return the new document list
        return newDocs

    def _processFullDocuments(self, documents: Dict[Tuple[str, int], Doc]) -> Dict[Tuple[str, int], Doc]:
        # Make sure we only read it once
        objectIds: Dict[str, Doc] = {}

        # Walk through all the source documents
        for docKey, doc in documents.items():
            # Get the object id
            objectId = doc.metadata.objectId

            # If we have already read this document, grab the highest score
            if objectId in objectIds:
                if doc.score > objectIds[objectId].score:
                    objectIds[objectId].score = doc.score
                    continue

            # We will be filling this all in
            doc.page_content = ''
            doc.metadata.chunkId = 0

            # Add it to the list
            objectIds[doc.metadata.objectId] = doc

        # Now, we have a collection of object ids we need to retrieve
        newDocs: Dict[Tuple[str, int], Doc] = {}
        for objectId in objectIds.keys():
            # Build the filter
            docFilter = DocFilter(objectIds=[objectId])

            # Get all the table chunks for these tables in
            # the document
            docChunks = self.get(docFilter)

            # Sort them by chunkId
            docChunks.sort(key=lambda doc: doc.metadata.chunkId)

            # Get the base document
            doc = objectIds[objectId]
            for docChunk in docChunks:
                doc.page_content += docChunk.page_content

            # Get the key and save it
            docKey = self._getDocKey(doc)
            newDocs[docKey] = doc

        # Return the update document list
        return newDocs

    def _queryDocuments(self, question: Question) -> Dict[Tuple[str, int], Doc]:
        # Get the type of question being asked
        type = question.type

        # Keep track of the documents by objectId/chunkId
        documents: Dict[Tuple[str, int], Doc] = {}

        # Add the pending documents to our list
        for doc in question.documents:
            # Add the doc to the list
            key = self._getDocKey(doc)
            documents[key] = doc

        def _addDoc(doc: Doc):
            # If it doesn't meet our score threshold, skip it
            if doc.score < self.threshold_search:
                return

            # Get the key for this document
            key = self._getDocKey(doc)

            # If this is already there, skip
            if key in documents:
                # Use the highest score
                if doc.score > documents[key].score:
                    documents[key].score = doc.score
                return

            # Add it
            documents[key] = doc

        def _addDocs(docs: List[Doc]):
            # For each document, add it
            for doc in docs:
                _addDoc(doc)

        # What type is this?
        if type == QuestionType.PROMPT or type == QuestionType.SEMANTIC or type == QuestionType.QUESTION:
            # For each question
            for query in question.questions:
                # Make sure we have the embeddings
                if not query.embedding_model:
                    raise Exception('You must run your question through an embedding filter')

                # Do a find operation
                docs = self.searchSemantic(query, question.filter)

                # Add the documents we got back
                _addDocs(docs)

        if type == QuestionType.KEYWORD:
            # For each question
            for query in question.questions:
                # Do a find operation
                docs = self.searchKeyword(query, question.filter)

                # Add the documents we got back
                _addDocs(docs)

        elif type == QuestionType.GET:
            # This is a get request
            docs = self.get(question.filter)

            # Add the documents we got back
            _addDocs(docs)

        else:
            # Nothing that we handle, pass it on
            pass

        # Return our 'raw' query documents
        return documents

    def dispatchSearch(self, pSelf: IInstanceBase, question: Question) -> List[Doc]:
        # Perform the raw query
        documents = self._queryDocuments(question)

        # Process full table request
        if question.filter.fullTables and not question.filter.fullDocuments:
            documents = self._processFullTables(documents)

        # Process full document request
        if question.filter.fullDocuments:
            documents = self._processFullDocuments(documents)

        # Get the resulting documents as a list
        documentList = list(documents.values())

        # Sort them by score
        documentList.sort(key=lambda doc: -doc.score)

        # Get the listeners to us
        listeners = pSelf.instance.getListeners()

        # If someone is listening on the documents lane, send it
        if 'documents' in listeners:
            pSelf.instance.writeDocuments(documentList)

        # If someone is listening on the answers lane, send it
        if 'answers' in listeners:
            answer = Answer()
            answer.setAnswer([document.toDict() for document in documentList])
            pSelf.instance.writeAnswers(answer)

        # If someone is listening on the questions lane, send it
        if 'questions' in listeners:
            # If we have a document list
            if documentList:
                # Replace the previous document list
                question.documents = documentList

                # If we don't have a filter list, create it
                if not question.filter.objectIds:
                    question.filter.objectIds = []

                # Add the objects ids to the filter list - this will limit the
                # next set of questions to these documents
                for doc in documentList:
                    # Get the object id
                    objectId = doc.metadata.objectId

                    # Filter to this object id
                    if objectId not in question.filter.objectIds:
                        question.filter.objectIds.append(doc.metadata.objectId)

            # Write the new question
            pSelf.instance.writeQuestions(question)

        # We handled all of our lane outputs
        return pSelf.preventDefault()

    def _checkCollectionExists(self) -> bool:
        """
        Check if collection exists without acquiring locks.

        This method performs the same logic as doesCollectionExist but without
        acquiring locks, allowing it to be called from within collectionLock.

        :return: True if the collection exists, False otherwise.
        """
        try:
            # Perform the actual existence check without locks
            exists = self._doesCollectionExist()

            # If the collection does not exist, return False
            if not exists:
                return False

            # Create a document filter to locate the control document
            filter = DocFilter()
            filter.objectIds = ['schema']  # Looking for the reference schema document
            filter.isDeleted = True  # Ensure it's the correct metadata document

            # Fetch the document using the filter
            doc = self.get(filter, checkCollection=False)

            # The collection should contain exactly one control document, otherwise it's corrupted
            if len(doc) != 1:
                raise Exception(f'Collection does not have control document, found {len(doc)}')

            # Extract and store the vector size and model name from the control document
            self.vectorSize = doc[0].metadata.vectorSize
            self.modelName = doc[0].metadata.modelName

            return True

        except Exception as e:
            raise Exception(f'Error checking collection: {str(e)}')

    def doesCollectionExist(self, modelName: str = None) -> bool:
        """
        Check if the collection exists and verifies its integrity.

        If a `modelName` is provided, it ensures that the existing collection was encoded with the same model.

        :param modelName: Optional name of the embedding model to validate against the collection.
        :return: True if the collection exists and matches the model (if specified), otherwise False.
        """
        # Acquire the lock to ensure thread-safe checking
        with self.collectionLock:
            return self._checkCollectionExists()

    def createCollection(self, documents: List[Doc]):
        """
        Create a new collection if it does not already exist.

        Ensures all documents have the same embedding model and vector size.
        Stores a "bogus" metadata document for validation.

        :param documents: List of document objects to be added to the collection.
        :return: True if the collection was created successfully.
        """
        # Acquire the lock to ensure thread-safe collection creation
        with self.collectionLock:
            # Check if another process/thread has already created the collection
            if self._checkCollectionExists():
                # Collection already exists, validate documents against existing collection
                for doc in documents:
                    if not doc.embedding_model:
                        raise Exception('You must run your documents through an embedding filter')
                    if doc.embedding_model != self.modelName:
                        raise Exception(f'The collection uses {self.modelName} but the document was encoded with {doc.embedding_model}')
                    if len(doc.embedding) != self.vectorSize:
                        raise Exception(f'The collection uses a vector size of {self.vectorSize} but the document has {len(doc.embedding)} vector size')
                return True

            # If no documents are provided, exit early
            if not len(documents):
                return True

            # Use the first document as a reference for embedding model and vector size
            modelName = documents[0].embedding_model
            vectorSize = len(documents[0].embedding)

            # Validate that all documents have the same embedding model and vector size
            for doc in documents:
                if doc.embedding_model != modelName:
                    raise Exception('All documents must have the same embedding model')
                if len(doc.embedding) != vectorSize:
                    raise Exception('All documents must have the same vector size')

            # Store a reference document (first document in the list)
            refdoc = documents[0]

            # Create metadata for the "bogus" document
            metadata = DocMetadata(
                objectId='schema',  # Unique identifier for schema validation
                chunkId=0,  # The chunk id
                vectorSize=vectorSize,  # Store vector size for future validation
                modelName=modelName,  # Store embedding model name
                isDeleted=True,  # Marked as deleted to avoid retrieval in normal searches
            )

            # Create the "bogus" document with empty content and metadata
            doc = Doc(page_content='', metadata=metadata)

            # Assign the same embedding model but use a zeroed-out vector
            doc.embedding_model = refdoc.embedding_model
            doc.embedding = [0] * vectorSize  # List of zeros for validation purposes

            # Create the actual collection with the specified vector size
            self._createCollection(vectorSize)

            # Add the "bogus" document to the collection
            self.addChunks([doc], checkCollection=False)

            # Store the expected model name and vector size for validation
            self.vectorSize = vectorSize
            self.modelName = modelName

            # Validate all provided documents against the newly created collection metadata
            for doc in documents:
                if not doc.embedding_model:
                    raise Exception('You must run your documents through an embedding filter')
                if doc.embedding_model != modelName:
                    raise Exception(f'The collection uses {modelName} but the document was encoded with {doc.embedding_model}')
                if len(doc.embedding) != vectorSize:
                    raise Exception(f'The collection uses a vector size of {vectorSize} but the document has {len(doc.embedding)} vector size')

        # Collection successfully created and validated
        return True


def getStore(provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]) -> DocumentStoreBase:
    """
    Examine the configuration and returns and initializes a store.
    """
    # Build up the module name - it will be in the store dir
    name = 'connectors.' + provider

    # Get the module
    module = importlib.import_module(name)

    # See if this has the proper interface
    if not hasattr(module, 'getStore'):
        raise Exception(f'Module {provider} is not a store provider')

    # Get the class
    cls = getattr(module, 'getStore')()

    # Create an instance of the class
    return cls(provider, connConfig, bag)


# ---------------------------------------------------------------------------
# Vector DB tool mixin
# ---------------------------------------------------------------------------
#
# Rod's review feedback on PR #524 suggested co-locating the tool definitions
# with the underlying store so every vectordb node can "morph into a tool"
# without a separate generic wrapper node. Because the engine dispatches
# ``invoke`` against the node's ``IInstance`` (not the ``DocumentStoreBase``
# subclass, which is composed via ``self.IGlobal.store``), the tool methods
# must live on a class that the ``IInstance`` subclasses. This mixin is that
# class: it lives next to ``DocumentStoreBase`` so the store interface stays
# together in a single file, and it delegates every call to
# ``self.IGlobal.store`` (which is a ``DocumentStoreBase`` instance).
#
# Any vectordb ``IInstance`` that subclasses ``VectorStoreToolMixin`` picks up
# the ``search``, ``upsert`` and ``delete`` tools automatically via
# ``IInstanceBase._collect_tool_methods`` (which walks the full MRO).


_VECTORDB_TOOL_MAX_TOP_K = 100
_VECTORDB_TOOL_DEFAULT_TOP_K = 10
_VECTORDB_DEFAULT_SERVER_NAME = 'vectordb'


def _normalize_vectordb_tool_input(input_obj: Any) -> Dict[str, Any]:
    """Normalize a tool-call payload into a plain ``dict``.

    Handles ``None``, plain dicts, pydantic models (``model_dump`` / ``dict``),
    JSON strings, and nested ``input`` wrappers the host may produce. A
    nested ``input`` value of any supported shape (dict, JSON string,
    pydantic model) is re-normalized before merging with any sibling
    ``extras`` in the outer payload so values like ``{'input': '{"query":
    "x"}'}`` or ``{'input': SomeModel(...)}`` are handled correctly.
    """
    if input_obj is None:
        return {}

    # Pydantic (v2 prefers model_dump; fall back to v1 dict())
    if hasattr(input_obj, 'model_dump') and callable(getattr(input_obj, 'model_dump')):
        input_obj = input_obj.model_dump()
    elif hasattr(input_obj, 'dict') and callable(getattr(input_obj, 'dict')):
        try:
            input_obj = input_obj.dict()
        except TypeError:
            # Not a pydantic-style ``dict()`` (e.g. builtin dict) — leave as is.
            pass

    # JSON string
    if isinstance(input_obj, str):
        try:
            parsed = json.loads(input_obj)
            if isinstance(parsed, dict):
                input_obj = parsed
            else:
                warning(f'vectordb tool: JSON input did not parse to a dict (got {type(parsed).__name__})')
                return {}
        except (json.JSONDecodeError, ValueError) as exc:
            warning(f'vectordb tool: malformed JSON input, returning empty dict: {exc}')
            return {}

    if not isinstance(input_obj, dict):
        warning(f'vectordb tool: unexpected input type {type(input_obj).__name__}')
        return {}

    # Unwrap nested ``input`` wrappers the host may produce. Re-run the
    # normalizer on the inner value so string-, model- or dict-wrapped
    # payloads all get the same treatment.
    if 'input' in input_obj:
        inner_raw = input_obj['input']
        extras = {k: v for k, v in input_obj.items() if k != 'input'}
        inner = _normalize_vectordb_tool_input(inner_raw)
        if isinstance(inner, dict):
            input_obj = {**inner, **extras}

    input_obj.pop('security_context', None)
    return input_obj


class VectorStoreToolMixin:
    """
    Expose vector DB search/upsert/delete as agent tools.

    Any vectordb ``IInstance`` that inherits from this mixin is automatically
    discoverable through the ``tool.*`` control-plane protocol. The mixin
    delegates all storage operations to ``self.IGlobal.store`` (a
    :class:`DocumentStoreBase` implementation) so backend-specific code stays
    in the backend driver.

    To enable tool discovery, the node's ``services.json`` must also include
    ``"tool"`` in its ``classType`` list and ``"invoke"`` in its
    ``capabilities`` list.

    Tool names follow the established ``<serverName>.<toolName>`` convention
    documented in ``ai.common.tools`` and used by the MCP client: every tool
    method on this mixin is exposed as ``<serverName>.search``,
    ``<serverName>.upsert`` and ``<serverName>.delete`` where ``serverName``
    comes from ``self.IGlobal.serverName`` (user-configurable via
    ``services.json``). This prevents tool-name collisions when a pipeline
    contains more than one vectordb node.
    """

    # --- Configuration knobs (override via IGlobal) ------------------------

    def _vectordb_default_top_k(self) -> int:
        glb = getattr(self, 'IGlobal', None)
        value = getattr(glb, 'default_top_k', None)
        try:
            value = int(value) if value is not None else _VECTORDB_TOOL_DEFAULT_TOP_K
        except (TypeError, ValueError):
            value = _VECTORDB_TOOL_DEFAULT_TOP_K
        return max(1, min(value, _VECTORDB_TOOL_MAX_TOP_K))

    def _vectordb_score_threshold(self) -> float:
        glb = getattr(self, 'IGlobal', None)
        value = getattr(glb, 'score_threshold', None)
        try:
            value = float(value) if value is not None else 0.0
        except (TypeError, ValueError):
            value = 0.0
        return max(0.0, min(value, 1.0))

    def _vectordb_store(self) -> 'DocumentStoreBase':
        store = getattr(getattr(self, 'IGlobal', None), 'store', None)
        if store is None:
            raise RuntimeError('vectordb tool: store not initialized')
        return store

    def _vectordb_server_name(self) -> str:
        """Return the namespace prefix for this node's tools.

        Reads ``self.IGlobal.serverName`` (set from the node config). Falls
        back to the provider name (``self.IGlobal.glb.logicalType``) and
        finally to ``'vectordb'`` if neither is available. The returned value
        is stripped of leading/trailing whitespace and ``'.'`` characters to
        guarantee a clean ``<server>.<tool>`` format.
        """
        glb = getattr(self, 'IGlobal', None)
        name = getattr(glb, 'serverName', None)
        if not name:
            # Fall back to the node's logical type (e.g. 'pinecone').
            inner = getattr(glb, 'glb', None)
            name = getattr(inner, 'logicalType', None)
        if not isinstance(name, str):
            name = _VECTORDB_DEFAULT_SERVER_NAME
        name = name.strip().strip('.')
        return name or _VECTORDB_DEFAULT_SERVER_NAME

    def _vectordb_compute_embedding(self, query_text: str) -> Optional[List[float]]:
        """Attempt to compute a query embedding for semantic search.

        Tool invocations run in the control-plane ``invoke()`` path and do
        not pass through the data-lane embedding filters that normally
        populate ``QuestionText.embedding``. This hook gives nodes a chance
        to compute an embedding for the tool path. Override in a subclass or
        provide an ``embed_query`` callable on ``self.IGlobal`` (signature:
        ``embed_query(text: str) -> list[float]``).

        Returns ``None`` if no embedding provider is available; the caller
        will fall back to keyword search.
        """
        glb = getattr(self, 'IGlobal', None)
        embed_fn = getattr(glb, 'embed_query', None)
        if embed_fn is None or not callable(embed_fn):
            return None
        try:
            embedding = embed_fn(query_text)
        except Exception as exc:
            warning(f'vectordb tool: embed_query raised {type(exc).__name__}: {exc}')
            return None
        if not embedding:
            return None
        if not isinstance(embedding, (list, tuple)):
            warning(f'vectordb tool: embed_query returned unexpected type {type(embedding).__name__}')
            return None
        return list(embedding)

    # --- Tool descriptor / dispatch plumbing ------------------------------
    #
    # Override ``_collect_tool_methods`` so that our bare Python method
    # names ``search``/``upsert``/``delete`` are exposed to the engine as
    # namespaced tool names like ``pinecone.search``. The descriptor
    # builder in ``IInstanceBase`` uses the dict key as the outbound
    # ``descriptor['name']``, and the dispatcher looks up the inbound
    # ``tool_name`` in the same dict — so namespacing both sides with one
    # override is sufficient. We still delegate collection to ``super()``
    # so that any further @tool_function methods added in subclasses are
    # picked up (and namespaced) automatically.

    def _collect_tool_methods(self) -> Dict[str, Callable]:
        # Delegate to IInstanceBase (or any intermediate mixin) to discover
        # all @tool_function methods via MRO walking. Fall back to a local
        # walk when this mixin is instantiated outside an IInstance chain
        # (e.g. in unit tests) so ``super()`` wouldn't resolve the method.
        try:
            collected = super()._collect_tool_methods()  # type: ignore[misc]
        except AttributeError:
            collected = {}
            for attr_name in dir(type(self)):
                attr = getattr(type(self), attr_name, None)
                if attr is not None and hasattr(attr, '__tool_meta__'):
                    collected[attr_name] = getattr(self, attr_name)

        server = self._vectordb_server_name()

        # Only namespace methods that actually live on VectorStoreToolMixin —
        # other @tool_function methods a subclass defines should keep their
        # own conventions unless the subclass explicitly opts in.
        owned = set()
        for attr_name in vars(VectorStoreToolMixin):
            attr = getattr(VectorStoreToolMixin, attr_name, None)
            if attr is not None and hasattr(attr, '__tool_meta__'):
                owned.add(attr_name)

        namespaced: Dict[str, Callable] = {}
        for name, method in collected.items():
            if name in owned:
                namespaced[f'{server}.{name}'] = method
            else:
                namespaced[name] = method
        return namespaced

    # --- Tool methods ------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {
                    'type': 'string',
                    'description': 'The search query text. Will be matched against stored documents using semantic similarity.',
                },
                'top_k': {
                    'type': 'integer',
                    'description': 'Maximum number of results to return (default: 10).',
                    'default': _VECTORDB_TOOL_DEFAULT_TOP_K,
                },
                'filter': {
                    'type': 'object',
                    'description': 'Optional metadata filter. Keys are metadata field names, values are the required values. Example: {"nodeId": "my-node", "parent": "/docs"}',
                    'additionalProperties': True,
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'results': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'content': {'type': 'string'},
                            'score': {'type': 'number'},
                            'metadata': {'type': 'object'},
                        },
                    },
                },
                'total': {'type': 'integer'},
            },
        },
        description=(
            'Search for documents in the vector database. If an embedding provider is bound to this '
            'node (via IGlobal.embed_query), performs semantic similarity search. Otherwise falls back '
            'to keyword (substring) matching — bind an upstream embedding module to enable semantic '
            'ranking. Returns matching documents with their content, metadata, and scores.'
        ),
    )
    def search(self, args):
        """Search for documents in the vector database."""
        args = _normalize_vectordb_tool_input(args)
        store = self._vectordb_store()

        query_text = str(args.get('query', '')).strip()
        if not query_text:
            raise ValueError('search requires a non-empty "query" string')

        default_top_k = self._vectordb_default_top_k()
        try:
            top_k = int(args.get('top_k', default_top_k))
        except (TypeError, ValueError):
            top_k = default_top_k
        top_k = max(1, min(top_k, _VECTORDB_TOOL_MAX_TOP_K))

        raw_filter = args.get('filter') or {}
        doc_filter = DocFilter()
        if isinstance(raw_filter, dict):
            object_id = raw_filter.get('objectId')
            if object_id:
                doc_filter.objectIds = [object_id] if isinstance(object_id, str) else list(object_id)
            node_id = raw_filter.get('nodeId')
            if node_id:
                doc_filter.nodeId = node_id
            parent = raw_filter.get('parent')
            if parent:
                doc_filter.parent = parent

        doc_filter.limit = top_k
        question = QuestionText(text=query_text)

        # Attempt to compute an embedding for semantic search. The control-plane
        # invoke() path does not flow through the data-lane embedding filters,
        # so we give nodes a hook (``IGlobal.embed_query``) to plug in their
        # own embedder. If unavailable, we do a keyword-only search — which is
        # lossy but is always better than a hard failure on every call.
        embedding = self._vectordb_compute_embedding(query_text)
        if embedding is not None:
            question.embedding = embedding
            embed_model = getattr(getattr(self, 'IGlobal', None), 'embed_model_name', None)
            if isinstance(embed_model, str) and embed_model:
                question.embedding_model = embed_model
            try:
                docs: List[Doc] = store.searchSemantic(question, doc_filter)
            except Exception as exc:
                warning(f'vectordb tool: semantic search failed ({type(exc).__name__}: {exc}); falling back to keyword search. Check that the store is initialized and the embedding model matches the collection.')
                try:
                    docs = store.searchKeyword(question, doc_filter)
                except Exception as exc2:
                    raise RuntimeError(f'vectordb tool: search failed: {exc2}') from exc2
        else:
            # No embedding available — use keyword search directly. Emit a
            # one-shot warning (via a flag on self) so repeated tool calls
            # don't spam the log.
            if not getattr(self, '_vectordb_keyword_fallback_warned', False):
                warning(f'vectordb tool: no embedding provider bound to IGlobal.embed_query; the {self._vectordb_server_name()}.search tool is running in keyword-only mode. To enable semantic similarity ranking, set IGlobal.embed_query to a callable(text) -> list[float].')
                try:
                    setattr(self, '_vectordb_keyword_fallback_warned', True)
                except Exception:
                    pass
            try:
                docs = store.searchKeyword(question, doc_filter)
            except Exception as exc:
                raise RuntimeError(f'vectordb tool: keyword search failed: {exc}') from exc

        score_threshold = self._vectordb_score_threshold()
        results: List[Dict[str, Any]] = []
        for doc in docs:
            score = getattr(doc, 'score', 0.0) or 0.0
            if score_threshold > 0 and score < score_threshold:
                continue
            meta: Dict[str, Any] = {}
            if doc.metadata:
                meta = {
                    'objectId': doc.metadata.objectId,
                    'nodeId': doc.metadata.nodeId,
                    'parent': doc.metadata.parent,
                    'chunkId': doc.metadata.chunkId,
                }
            results.append(
                {
                    'content': doc.page_content or '',
                    'score': score,
                    'metadata': meta,
                }
            )

        trimmed = results[:top_k]
        return {
            'results': trimmed,
            'total': len(trimmed),
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['documents'],
            'properties': {
                'documents': {
                    'type': 'array',
                    'description': 'Array of documents to upsert.',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'content': {
                                'type': 'string',
                                'description': 'The text content of the document.',
                            },
                            'object_id': {
                                'type': 'string',
                                'description': 'Unique identifier for the document. Used for deduplication.',
                            },
                            'metadata': {
                                'type': 'object',
                                'description': 'Optional metadata key-value pairs to store with the document.',
                                'additionalProperties': True,
                            },
                        },
                        'required': ['content', 'object_id'],
                    },
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'count': {'type': 'integer'},
                'skipped': {'type': 'integer'},
            },
        },
        description='Add or update documents in the vector database. Each document requires content text and an object ID for deduplication. Note: documents are stored as text chunks without embeddings; the backend must be configured to compute embeddings on ingest, or an upstream embedding node must be present in the pipeline.',
    )
    def upsert(self, args):
        """Add or update documents in the vector database."""
        args = _normalize_vectordb_tool_input(args)
        store = self._vectordb_store()

        raw_docs = args.get('documents', [])
        if not isinstance(raw_docs, list) or not raw_docs:
            raise ValueError('upsert requires a non-empty "documents" array')

        docs: List[Doc] = []
        skipped = 0
        for raw in raw_docs:
            if not isinstance(raw, dict):
                skipped += 1
                continue
            content = str(raw.get('content', '')).strip()
            object_id = str(raw.get('object_id', '')).strip()
            if not content or not object_id:
                skipped += 1
                continue

            extra_meta = raw.get('metadata') or {}
            metadata = DocMetadata(
                objectId=object_id,
                nodeId=extra_meta.get('nodeId', 'vectordb_tool'),
                parent=extra_meta.get('parent', '/'),
                chunkId=extra_meta.get('chunkId', 0),
                isDeleted=False,
            )
            doc = Doc(
                page_content=content,
                metadata=metadata,
            )
            docs.append(doc)

        if not docs:
            raise ValueError('upsert: no valid documents provided')

        if any(not getattr(doc, 'embedding', None) for doc in docs):
            warning('vectordb tool: upserting documents without pre-computed embeddings. Ensure the backend is configured to generate embeddings on ingest, or results may not be searchable via semantic search.')

        store.addChunks(docs)
        return {'success': True, 'count': len(docs), 'skipped': skipped}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['object_ids'],
            'properties': {
                'object_ids': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'List of object IDs to delete.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'deleted_count': {'type': 'integer'},
            },
        },
        description='Delete documents from the vector database by their object IDs.',
    )
    def delete(self, args):
        """Delete documents from the vector database by object IDs."""
        args = _normalize_vectordb_tool_input(args)
        store = self._vectordb_store()

        object_ids = args.get('object_ids', [])
        if not isinstance(object_ids, list) or not object_ids:
            raise ValueError('delete requires a non-empty "object_ids" array')

        clean_ids = [str(oid).strip() for oid in object_ids if str(oid).strip()]
        if not clean_ids:
            raise ValueError('delete: no valid object IDs provided')

        store.remove(clean_ids)
        return {'success': True, 'deleted_count': len(clean_ids)}
