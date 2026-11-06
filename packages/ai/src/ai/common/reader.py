from typing import Dict, Any
from abc import abstractmethod, ABC


class ReaderBase(ABC):
    """
    The basis for all readers.
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Define the defalt constructor."""
        pass

    @abstractmethod
    def read(self, file) -> str:
        """
        Process some file.
        """
