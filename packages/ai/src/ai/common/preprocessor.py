import importlib
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


def getPreprocessor(provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]) -> PreProcessorBase:
    """
    Examine the configuration and returns and initializes a preprocessor.
    """
    # Build up the module name - it will be in the store dir
    name = 'connectors.' + provider

    # Get the module
    module = importlib.import_module(name)

    # See if this has the proper interface
    if not hasattr(module, 'getPreProcessor'):
        raise Exception(f'Module {provider} is not a preprocessing provider')

    # Get the class
    cls = getattr(module, 'getPreProcessor')()

    # Create an instance of the class
    return cls(provider, connConfig, bag)
