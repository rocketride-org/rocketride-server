import importlib
import threading
from abc import abstractmethod, ABC
from typing import List, Callable, Dict, Any, Tuple
from rocketlib import IInstanceBase
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
        self.collectionLock = threading.RLock()

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
                # Initialize with a deep copy to avoid mutating input documents
                # and reset the page content as we'll rebuild it
                base_doc = doc.model_copy(deep=True)
                base_doc.page_content = ''
                tableDocs[tableKey] = base_doc

            # Update the score if this one is higher
            if doc.score > tableDocs[tableKey].score:
                tableDocs[tableKey].score = doc.score

        # If there are no tables, done
        if not tableIds:
            return documents

        # Now, we can do our queries
        for objectId, table_ids in tableIds.items():
            # Build the filter
            tableFilter = DocFilter(isTable=True, objectIds=[objectId], tableIds=table_ids)

            # Get all the table chunks for these tables in
            # the document
            tableChunks = self.get(tableFilter)

            # Sort them by chunkId
            tableChunks.sort(key=lambda doc: doc.metadata.chunkId)

            # Gather up all the text of the table
            for chunk in tableChunks:
                # Get this chunks table key
                tableKey = self._getTableKey(chunk)

                # If this is the first part of the table we've encountered in the fetch
                if tableKey not in tableDocs:
                    # Initialize a new document for this table, preserving
                    # the first chunk's chunkId to avoid key collisions
                    metadata = chunk.metadata.model_copy(deep=True)
                    tableDocs[tableKey] = Doc(
                        page_content='',
                        metadata=metadata,
                        score=chunk.score,
                    )

                # Append the text safely
                if chunk.page_content:
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

            # If this table is not in our set (shouldn't happen), skip
            if tableKey not in tableDocs:
                continue

            # Use the combined document's key (objectId, first chunkId)
            combined_doc = tableDocs[tableKey]
            newKey = self._getDocKey(combined_doc)

            # Add this to the new docs
            newDocs[newKey] = combined_doc

            # Remove it from the tableDocs so we don't add it multiple times
            # if multiple chunks of the same table were in the input
            del tableDocs[tableKey]

        # Return the new document list
        return newDocs

    def _processFullDocuments(self, documents: Dict[Tuple[str, int], Doc]) -> Dict[Tuple[str, int], Doc]:
        """
        Process full documents by combining all chunks for an object.
        """
        # Map objectIds to their representative 'best' document
        objectIds: Dict[str, Doc] = {}

        # Walk through all the source documents to identify which objects to hydrate
        for docKey, doc in documents.items():
            objectId = doc.metadata.objectId

            if objectId in objectIds:
                # If we found a higher score for this object, update the representative score
                if doc.score > objectIds[objectId].score:
                    objectIds[objectId].score = doc.score
                continue

            # This is the first time we see this object. Create a base doc for it.
            base_doc = doc.model_copy(deep=True)
            base_doc.page_content = ''
            base_doc.metadata.chunkId = 0
            # Clear table-specific metadata so the hydrated full document
            # is not incorrectly labeled as a table
            base_doc.metadata.isTable = False
            base_doc.metadata.tableId = 0
            objectIds[objectId] = base_doc

        # Fetch all chunks in a single batch query
        docFilter = DocFilter(objectIds=list(objectIds.keys()))
        allChunks = self.get(docFilter)

        # Group chunks by objectId
        chunksByObject: Dict[str, List[Doc]] = {}
        for chunk in allChunks:
            oid = chunk.metadata.objectId
            if oid not in chunksByObject:
                chunksByObject[oid] = []
            chunksByObject[oid].append(chunk)

        # Combine chunks into each base document
        newDocs: Dict[Tuple[str, int], Doc] = {}
        for objectId, doc in objectIds.items():
            chunks = chunksByObject.get(objectId, [])
            chunks.sort(key=lambda c: c.metadata.chunkId)

            for chunk in chunks:
                if chunk.page_content:
                    doc.page_content += chunk.page_content

            docKey = self._getDocKey(doc)
            newDocs[docKey] = doc

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
