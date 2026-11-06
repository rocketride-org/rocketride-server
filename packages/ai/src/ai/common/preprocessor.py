from typing import List, Dict, Any
from abc import abstractmethod, ABC


class PreProcessorBase(ABC):
    """
    The basis for all preprocessors.
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Define the defalt constructor."""
        pass

    @abstractmethod
    def process(self, text: str, path: str = None) -> List[str]:
        """
        Process and chunks documents.
        """
