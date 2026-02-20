import sys
from typing import Any


def get_arg(argkey: str, default: Any = None) -> Any:
    """
    Extract a command-line argument in the form --key=value.

    Attempts to cast the value to the type of the default, if provided.

    Args:
        argkey (str): The argument name (without the '--').
        default (Any): The default value and type hint.

    Returns:
        Any: The parsed and casted argument, or the default value.
    """
    prefix = f'--{argkey}='

    for arg in sys.argv:
        if arg.lower().startswith(prefix):
            raw_value = arg[len(prefix) :]

            if isinstance(default, int):
                try:
                    return int(raw_value)
                except ValueError:
                    raise ValueError(f'Invalid value for {argkey} - must be an integer.')
            elif isinstance(default, float):
                try:
                    return float(raw_value)
                except ValueError:
                    raise ValueError(f'Invalid value for {argkey} - must be a float.')
            else:
                return raw_value

    return default
