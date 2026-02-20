import importlib
import warnings
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


def getEmbedding(provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]) -> EmbeddingBase:
    """
    Examine configuration and return and initializes an embedding.
    """
    # Build up the module name - it will be in the store dir
    name = 'connectors.' + provider

    # Get the module
    module = importlib.import_module(name)

    # See if this has the proper interface
    if not hasattr(module, 'getEmbedding'):
        raise Exception(f'Module {provider} is not an embedding provider')

    # This is a warning from pytorch that the sentence transformers
    # use. We really can't do anything about it at this time except
    # wait for transformers to be updated
    warnings.filterwarnings('ignore', message='TypedStorage is deprecated.*')

    # Get the class
    cls = getattr(module, 'getEmbedding')()

    # Create an instance of the class
    return cls(provider, connConfig, bag)
