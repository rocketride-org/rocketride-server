_SENSITIVE_KEYS = ('api_key', 'apikey', 'secret', 'token', 'password', 'credential')


def redact_dict(d: dict) -> dict:
    """Return a shallow copy of *d* with values of sensitive keys replaced."""
    return {k: ('***REDACTED***' if any(p in k.lower() for p in _SENSITIVE_KEYS) else v) for k, v in d.items()}
