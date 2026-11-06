from abc import abstractmethod, ABC
from typing import List, Dict, Any
from .schema import Question
from .schema import Doc


class EmbeddingBase(ABC):
    """
    Base class for all embedding drivers.
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Define the default constructor."""
        pass

    """
    The embedding base allows the actual embedding internals to be extracted
    into provider implementations. They will usually be a SentenceTransformet,
    a Transformer or Gpt4All
    """

    @abstractmethod
    def getVectorSize(self) -> int:
        """
        Return the vector size of the embedding module.
        """

    @abstractmethod
    def getMaximumTokens(self) -> int:
        """
        Return the maximum number of tokens in a request.
        """

    @abstractmethod
    def encodeQuestion(self, question: Question) -> None:
        """
        Encode the question into a vector.
        """

    @abstractmethod
    def encodeChunks(self, documents: List[Doc]) -> None:
        """
        Encode the chunks into a vector.
        """
