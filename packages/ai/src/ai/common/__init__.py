import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)


def _register_attachment_file_store_factory():
    """Teach rocketlib tool nodes how to resolve a per-account FileStore.

    Tool-node attachment resolution lives in dependency-free rocketlib, so it
    cannot import the account layer itself. We push the ``ai``-layer builder
    in here (dependency direction stays ai -> rocketlib). The factory body
    defers the heavy import to call time so this stays cheap at package
    import. Best-effort: if rocketlib lacks the hook, tool attachment
    resolution simply no-ops as before.
    """
    try:
        from rocketlib.filters import set_attachment_file_store_factory
    except Exception:
        return

    def _factory(_node):
        from ai.common.file_store import build_sync_account_file_store

        return build_sync_account_file_store()

    set_attachment_file_store_factory(_factory)


_register_attachment_file_store_factory()

# __all__ = ['normalize', 'safeString', 'parseJson', 'parsePython', 'obfuscate_string']
