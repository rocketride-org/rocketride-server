# Import the filters
from .IEndpoint import IEndpoint
from .IGlobal import IGlobal
from .IInstance import IInstance


# Allow direct access to the underlying Elasticsearch store
def getStore():
    """
    Get the Elasticsearch store class for this connector.
    """
    from .elasticsearch_store import Store

    return Store


__all__ = [
    'IEndpoint',
    'IGlobal',
    'IInstance',
    'getStore',
]

