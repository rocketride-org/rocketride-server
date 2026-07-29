import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace


class StoreGlobalBase:
    pass


ai = ModuleType('ai')
ai_common = ModuleType('ai.common')
ai_common_store = ModuleType('ai.common.store')
ai_common_store.StoreGlobalBase = StoreGlobalBase
rocketlib = ModuleType('rocketlib')
rocketlib.warning = lambda message: None

path = Path(__file__).parents[2] / 'src/nodes/store_pinecone/IGlobal.py'
spec = importlib.util.spec_from_file_location('store_pinecone_IGlobal', path)
assert spec is not None
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
stubs = {
    'ai': ai,
    'ai.common': ai_common,
    'ai.common.store': ai_common_store,
    'rocketlib': rocketlib,
}
originals = {name: sys.modules.get(name) for name in stubs}
sys.modules.update(stubs)
try:
    spec.loader.exec_module(module)
finally:
    for name, original in originals.items():
        if original is None:
            del sys.modules[name]
        else:
            sys.modules[name] = original
IGlobal = module.IGlobal


def _sub_key(apikey: str, profile: str = 'serverless-dense', collection: str = 'shared-index') -> str:
    glb = IGlobal.__new__(IGlobal)
    glb.store = SimpleNamespace(apikey=apikey, profile=profile, collection=collection)
    return glb._sub_key()


def test_sub_key_distinguishes_accounts_without_leaking_api_key() -> None:
    first = _sub_key('pcsk_first_secret')
    second = _sub_key('pcsk_second_secret')

    assert first != second
    assert first.endswith('/serverless-dense/shared-index')
    assert 'pcsk_first_secret' not in first
    assert 'pcsk_second_secret' not in second


def test_sub_key_includes_profile_and_collection() -> None:
    assert _sub_key('pcsk_secret', 'pod-based', 'other-index').endswith('/pod-based/other-index')
