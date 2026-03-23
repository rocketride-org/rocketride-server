from typing import Union

_SENSITIVE_KEYS = ('api_key', 'apikey', 'secret', 'token', 'password', 'credential')

_Redactable = Union[dict, list, tuple]


def redact_secrets(data: _Redactable) -> _Redactable:
    """Return a deep copy of *data* with sensitive values replaced by ``***REDACTED***``.

    Recursively walks dicts, lists, and tuples. A dict key is considered
    sensitive when its lowercased name contains any substring from
    ``_SENSITIVE_KEYS``.
    """
    if isinstance(data, dict):
        return {
            k: ('***REDACTED***' if any(p in k.lower() for p in _SENSITIVE_KEYS) else redact_secrets(v))
            for k, v in data.items()
        }
    if isinstance(data, (list, tuple)):
        return type(data)(redact_secrets(item) for item in data)
    return data
