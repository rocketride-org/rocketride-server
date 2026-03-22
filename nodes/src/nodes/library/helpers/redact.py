_SENSITIVE_KEYS = ('api_key', 'apikey', 'secret', 'token', 'password', 'credential')


def redact_dict(d):
    """Return a deep copy of *d* with values of sensitive keys replaced."""
    if isinstance(d, dict):
        return {
            k: ('***REDACTED***' if any(p in k.lower() for p in _SENSITIVE_KEYS) else redact_dict(v))
            for k, v in d.items()
        }
    if isinstance(d, (list, tuple)):
        return type(d)(redact_dict(item) for item in d)
    return d
