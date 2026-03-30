from .IGlobal import IGlobal
from .IInstance import IInstance


def getChat():
    """
    Get the Chat class from the module.
    """
    from .openai_client import Chat

    return Chat


__all__ = [
    'IGlobal',
    'IInstance',
    'getChat',
]
