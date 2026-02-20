import importlib
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


def getReader(provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]) -> ReaderBase:
    """
    Examine the configuration and returns and initializes a reader.
    """
    # Build up the module name - it will be in the store dir
    name = 'connectors.' + provider

    # Get the module
    module = importlib.import_module(name)

    # See if this has the proper interface
    if not hasattr(module, 'getReader'):
        raise Exception(f'Module {provider} is not a preprocessing provider')

    # Get the class
    cls = getattr(module, 'getReader')()

    # Create an instance of the class
    return cls(provider, connConfig, bag)
