from typing import Any, Dict, List


class Pipe:
    """
    Pipe processing context.

    Define our class to keep track of a processing pipe.
    """

    def __init__(self, apikey: str = '', loader: Any = None, input: List[str] = [], output: List[str] = [], usage: Dict[str, int] = {}):
        """
        Сreate an instance of the pipe context.
        """
        if usage is None:  # to avoid mutable default argument issues
            usage = {}
        self.apikey = apikey
        self.loader = loader
        self.input = input
        self.output = output
        self.usage = usage


# Define our global mapping of opened endpoints and API keys
pipes: Dict[str, Pipe] = {}
