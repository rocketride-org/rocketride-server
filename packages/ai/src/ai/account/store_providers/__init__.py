"""
Storage backend implementations.

Providers are imported lazily by store.py to avoid blocking the server's
event loop during startup (each provider's __init__.py calls depends() which
acquires a file lock with time.sleep polling).
"""

__all__ = ['FilesystemStore', 'MemoryStore', 'S3Store', 'AzureBlobStore']


def __getattr__(name: str):
    """Lazy-load storage providers on first access."""
    if name == 'FilesystemStore':
        from .filesystem import FilesystemStore

        return FilesystemStore
    if name == 'MemoryStore':
        from .memory import MemoryStore

        return MemoryStore
    if name == 'S3Store':
        from .s3 import S3Store

        return S3Store
    if name == 'AzureBlobStore':
        from .azure import AzureBlobStore

        return AzureBlobStore
    raise AttributeError(f'module {__name__!r} has no attribute {name!r}')
