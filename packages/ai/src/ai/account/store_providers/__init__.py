"""
Storage backend implementations.

Each provider is imported directly by Store.create() based on the
STORE_URL scheme so that only the selected backend's dependencies
(and its ``depends()`` call) are loaded.  Do not re-export providers
here — eager imports would trigger pip dependency checks for every
backend on every startup.
"""
