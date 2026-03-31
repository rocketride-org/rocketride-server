from typing import Any, Dict, List, Optional


class Pipe:
    """
    Pipe processing context.

    Define our class to keep track of a processing pipe.
    """

    def __init__(self, apikey: str = '', loader: Any = None, input: Optional[List[str]] = None, output: Optional[List[str]] = None, usage: Optional[Dict[str, int]] = None):
        """
        Сreate an instance of the pipe context.
        """
        self.apikey = apikey
        self.loader = loader
        self.input = input if input is not None else []
        self.output = output if output is not None else []
        self.usage = usage if usage is not None else {}


# Define our global mapping of opened endpoints and API keys
pipes: Dict[str, Pipe] = {}
