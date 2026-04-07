# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
# =============================================================================

"""
Dev A Tests — visual_similarity_filter node.

Covers Modules 1–3 from test_plan.md. No engine required for any of these.

Modules:
  1. Contract   — services.json structure validation (instant, no GPU)
  2. Embedder   — FrameEmbedder CLIP logic (needs CLIP model ~600MB first run)
  3. Invoke     — IInstance.invoke() lifecycle + thread safety

Test assets (relative to this repo root):
  ../f1-saas-app/test/F1_dpa-1.jpg
  ../f1-saas-app/test/FIA_F1_Austria_2021_Nr._44_Hamilton_(side).jpg

Run all Dev A tests (no engine):
    ./dist/server/python -m pytest nodes/test/test_visual_similarity_filter.py -v

Run a specific module:
    ./dist/server/python -m pytest nodes/test/test_visual_similarity_filter.py::TestVSFContract -v
    ./dist/server/python -m pytest nodes/test/test_visual_similarity_filter.py::TestFrameEmbedder -v
    ./dist/server/python -m pytest nodes/test/test_visual_similarity_filter.py::TestIInstanceInvoke -v
"""

import io
import json
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pytest
from PIL import Image

# ---------------------------------------------------------------------------
# Stub rocketlib so IInstance/IGlobal can be imported without the engine
# ---------------------------------------------------------------------------

_rocketlib_stub = MagicMock()
_rocketlib_stub.IInstanceBase = object
_rocketlib_stub.IGlobalBase = object
_rocketlib_stub.OPEN_MODE = SimpleNamespace(CONFIG='config')
sys.modules.setdefault('rocketlib', _rocketlib_stub)

_ai_config_stub = MagicMock()
_ai_config_stub.Config.getNodeConfig = lambda *a, **kw: {'similarity_threshold': 0.25}
sys.modules.setdefault('ai', MagicMock())
sys.modules.setdefault('ai.common', MagicMock())
sys.modules.setdefault('ai.common.config', _ai_config_stub)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# __file__ = /Users/shashidharbabu/rocketride-server/nodes/test/test_visual_similarity_filter.py
# parent       = nodes/test/
# parent.parent= nodes/
# parent.parent.parent = rocketride-server/  ← ROCKETRIDE_ROOT
ROCKETRIDE_ROOT = Path(__file__).parent.parent.parent
NODE_SRC = ROCKETRIDE_ROOT / 'nodes' / 'src' / 'nodes'
SERVICES_JSON = NODE_SRC / 'visual_similarity_filter' / 'services.json'

# Test image assets live in f1-saas-app/test/ (sibling repo)
ASSETS = ROCKETRIDE_ROOT.parent / 'f1-saas-app' / 'test'
F1_DPA = ASSETS / 'F1_dpa-1.jpg'
HAMILTON = ASSETS / 'FIA_F1_Austria_2021_Nr._44_Hamilton_(side).jpg'

# Add node src to path so we can import frame_embedder directly
NODE_SRC_STR = str(NODE_SRC)
if NODE_SRC_STR not in sys.path:
    sys.path.insert(0, NODE_SRC_STR)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load_image_bytes(path: Path) -> bytes:
    """Load an image file and convert to PNG bytes."""
    img = Image.open(path).convert('RGB')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def _black_frame_bytes(width: int = 64, height: int = 64) -> bytes:
    """Generate a solid black PNG frame."""
    img = Image.new('RGB', (width, height), color=(0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def _load_services_json() -> dict:
    """Load services.json, stripping JS-style // comments."""
    lines = SERVICES_JSON.read_text().splitlines()
    clean = [line for line in lines if not line.strip().startswith('//')]
    return json.loads('\n'.join(clean))


# ---------------------------------------------------------------------------
# Shared fixture — FrameEmbedder (loaded once per session, CLIP is heavy)
# ---------------------------------------------------------------------------


@pytest.fixture(scope='session')
def embedder():
    """Load FrameEmbedder once for the whole test session."""
    from visual_similarity_filter.frame_embedder import FrameEmbedder

    return FrameEmbedder({'similarity_threshold': 0.50})


@pytest.fixture(scope='session')
def f1_dpa_bytes():
    return _load_image_bytes(F1_DPA)


@pytest.fixture(scope='session')
def hamilton_bytes():
    return _load_image_bytes(HAMILTON)


@pytest.fixture(scope='session')
def black_frame_bytes():
    return _black_frame_bytes()


# ---------------------------------------------------------------------------
# Fake IGlobal — avoids needing rocketlib / engine internals
# ---------------------------------------------------------------------------


class FakeIGlobal:
    """Minimal stand-in for IGlobal used to drive IInstance.invoke() tests."""

    def __init__(self, embedder_instance):
        """Set up fake global with a real embedder and empty reference."""
        self.embedder = embedder_instance
        self.reference_patches = None
        self.device_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Module 1 — Contract Tests
# ---------------------------------------------------------------------------


class TestVSFContract:
    """Validate services.json structure. No engine, no GPU, instant."""

    def test_services_json_exists(self):
        assert SERVICES_JSON.exists(), f'services.json not found at {SERVICES_JSON}'

    def test_required_fields_present(self):
        svc = _load_services_json()
        for field in ('title', 'protocol', 'prefix', 'classType', 'capabilities'):
            assert field in svc, f'Missing required field: {field}'

    def test_title_is_string(self):
        svc = _load_services_json()
        assert isinstance(svc['title'], str) and svc['title']

    def test_protocol_ends_with_slash(self):
        svc = _load_services_json()
        assert svc['protocol'].endswith('://'), 'Protocol must end with ://'

    def test_class_type_contains_visual_similarity(self):
        """clip_buffer uses getControllerNodeIds('visual_similarity') — must be present."""
        svc = _load_services_json()
        assert 'visual_similarity' in svc['classType'], "classType must include 'visual_similarity' for clip_buffer to address this node"

    def test_class_type_contains_image(self):
        svc = _load_services_json()
        assert 'image' in svc['classType']

    def test_capabilities_contains_invoke(self):
        """Engine uses capabilities to enable the invoke() control-plane mechanism."""
        svc = _load_services_json()
        assert 'invoke' in svc['capabilities'], "capabilities must include 'invoke' for control-plane invocation to work"

    def test_invoke_block_present(self):
        svc = _load_services_json()
        assert 'invoke' in svc, "Top-level 'invoke' block must be present"

    def test_lanes_empty(self):
        """VSF is not in the data flow — it has no data lanes."""
        svc = _load_services_json()
        assert svc.get('lanes') == {}, 'VSF should have empty lanes (control-plane only)'

    def test_preconfig_default_exists(self):
        svc = _load_services_json()
        preconfig = svc.get('preconfig', {})
        default = preconfig.get('default')
        assert default is not None, 'preconfig.default must be set'
        assert default in preconfig.get('profiles', {}), f"preconfig.default '{default}' not found in profiles"

    def test_default_profile_has_similarity_threshold(self):
        svc = _load_services_json()
        default = svc['preconfig']['default']
        profile = svc['preconfig']['profiles'][default]
        assert 'similarity_threshold' in profile

    def test_node_is_python(self):
        svc = _load_services_json()
        assert svc.get('node') == 'python'

    def test_path_matches_node_name(self):
        svc = _load_services_json()
        assert 'visual_similarity_filter' in svc.get('path', '')


# ---------------------------------------------------------------------------
# Module 2 — FrameEmbedder Unit Tests
# ---------------------------------------------------------------------------


class TestFrameEmbedder:
    """Test raw CLIP embedding logic. Requires CLIP model (~600MB first run)."""

    def test_augment_reference_returns_array(self, embedder, f1_dpa_bytes):
        ref = embedder.augment_reference(f1_dpa_bytes)
        assert ref is not None
        assert isinstance(ref, np.ndarray)

    def test_reference_embedding_is_unit_normalised(self, embedder, f1_dpa_bytes):
        ref = embedder.augment_reference(f1_dpa_bytes)
        norm = float(np.linalg.norm(ref))
        assert abs(norm - 1.0) < 0.001, f'Embedding norm should be ~1.0, got {norm:.4f}'

    def test_embed_patches_returns_same_shape(self, embedder, f1_dpa_bytes):
        ref = embedder.augment_reference(f1_dpa_bytes)
        patches = embedder.embed_patches(f1_dpa_bytes)
        assert patches.shape == ref.shape

    def test_score_same_image_is_near_one(self, embedder, f1_dpa_bytes):
        """Same image compared to itself should score near 1.0."""
        ref = embedder.augment_reference(f1_dpa_bytes)
        patches = embedder.embed_patches(f1_dpa_bytes)
        score = embedder.score(ref, patches)
        assert score >= 0.99, f'Same-image score should be ≥0.99, got {score:.4f}'

    def test_score_black_frame_is_below_threshold(self, embedder, f1_dpa_bytes, black_frame_bytes):
        """Solid black frame should score below the similarity threshold."""
        ref = embedder.augment_reference(f1_dpa_bytes)
        patches = embedder.embed_patches(black_frame_bytes)
        score = embedder.score(ref, patches)
        assert score < embedder.similarity_threshold, f'Black frame score {score:.4f} should be below threshold {embedder.similarity_threshold}'

    def test_score_returns_float_in_valid_range(self, embedder, f1_dpa_bytes, hamilton_bytes):
        """Any two images should produce a score in [-1.0, 1.0]."""
        ref = embedder.augment_reference(f1_dpa_bytes)
        patches = embedder.embed_patches(hamilton_bytes)
        score = embedder.score(ref, patches)
        assert isinstance(score, float)
        assert -1.0 <= score <= 1.0, f'Score out of range: {score:.4f}'

    def test_hamilton_score_is_numeric(self, embedder, f1_dpa_bytes, hamilton_bytes):
        """Different F1 cars — just assert we get a real number, not an error."""
        ref = embedder.augment_reference(f1_dpa_bytes)
        patches = embedder.embed_patches(hamilton_bytes)
        score = embedder.score(ref, patches)
        assert not np.isnan(score), 'Score should not be NaN'
        assert not np.isinf(score), 'Score should not be Inf'


# ---------------------------------------------------------------------------
# Module 3 — IInstance.invoke() Lifecycle Tests
# ---------------------------------------------------------------------------


class TestIInstanceInvoke:
    """Test invoke() state machine. Uses real embedder, fake IGlobal (no engine)."""

    @pytest.fixture
    def instance(self, embedder):
        """Create a bare IInstance with a fake IGlobal bound to a real embedder."""
        from visual_similarity_filter.IInstance import IInstance

        inst = IInstance.__new__(IInstance)
        inst.IGlobal = FakeIGlobal(embedder)
        return inst

    def test_first_invoke_returns_true(self, instance, f1_dpa_bytes):
        """First call always returns True (sets reference)."""
        result = instance.invoke(f1_dpa_bytes)
        assert result is True

    def test_first_invoke_sets_reference(self, instance, f1_dpa_bytes):
        """After first invoke, reference_patches must be populated."""
        assert instance.IGlobal.reference_patches is None
        instance.invoke(f1_dpa_bytes)
        assert instance.IGlobal.reference_patches is not None

    def test_reference_matches_direct_embedding(self, instance, embedder, f1_dpa_bytes):
        """reference_patches set by invoke() must equal a direct augment_reference() call."""
        instance.invoke(f1_dpa_bytes)
        direct = embedder.augment_reference(f1_dpa_bytes)
        np.testing.assert_allclose(instance.IGlobal.reference_patches, direct, rtol=1e-5, err_msg='invoke() reference_patches should match direct augment_reference()')

    def test_second_invoke_same_image_returns_true(self, instance, f1_dpa_bytes):
        """After setting reference, same image must match."""
        instance.invoke(f1_dpa_bytes)  # set reference
        result = instance.invoke(f1_dpa_bytes)
        assert result is True, 'Same image should match reference'

    def test_second_invoke_black_frame_returns_false(self, instance, f1_dpa_bytes, black_frame_bytes):
        """After setting reference, solid black frame must not match."""
        instance.invoke(f1_dpa_bytes)  # set reference
        result = instance.invoke(black_frame_bytes)
        assert result is False, 'Black frame should not match car reference'

    def test_invoke_returns_bool(self, instance, f1_dpa_bytes):
        """invoke() must always return a Python bool, not numpy bool or int."""
        instance.invoke(f1_dpa_bytes)  # set reference
        result = instance.invoke(f1_dpa_bytes)
        assert isinstance(result, bool), f'Expected bool, got {type(result)}'

    def test_thread_safety_reference_set_once(self, embedder, f1_dpa_bytes):
        """10 threads call invoke() simultaneously before reference is set.
        reference_patches must be set exactly once (no double-init, no None race).
        """
        from visual_similarity_filter.IInstance import IInstance

        set_count = []
        lock = threading.Lock()

        original_augment = embedder.augment_reference

        def counting_augment(frame_bytes):
            result = original_augment(frame_bytes)
            with lock:
                set_count.append(1)
            return result

        embedder.augment_reference = counting_augment

        try:
            instances = []
            for _ in range(10):
                inst = IInstance.__new__(IInstance)
                inst.IGlobal = FakeIGlobal(embedder)
                instances.append(inst)

            # All share the same IGlobal (simulate shared global state)
            shared_global = FakeIGlobal(embedder)
            for inst in instances:
                inst.IGlobal = shared_global

            errors = []
            barrier = threading.Barrier(10)

            def worker(inst):
                try:
                    barrier.wait()  # all threads start simultaneously
                    inst.invoke(f1_dpa_bytes)
                except Exception as e:
                    errors.append(e)

            threads = [threading.Thread(target=worker, args=(inst,)) for inst in instances]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            assert not errors, f'Thread errors: {errors}'
            assert shared_global.reference_patches is not None
            assert len(set_count) == 1, f'augment_reference() should be called exactly once, was called {len(set_count)} times'
        finally:
            embedder.augment_reference = original_augment


# ---------------------------------------------------------------------------
# Module 4 — Live Engine Registration Test
# ---------------------------------------------------------------------------


class TestVSFEngineRegistration:
    """
    Verify VSF node is registered and loadable in the live engine.
    Requires engine running at localhost:5565.

    Run:
        python3 -m pytest nodes/test/test_visual_similarity_filter.py::TestVSFEngineRegistration -v
    """

    ENGINE_URI = 'http://localhost:5565'
    ENGINE_KEY = 'MYAPIKEY'

    # Minimal pipeline with just VSF as a standalone control node (no data lanes needed)
    PIPELINE = {
        'source': 'webhook_1',
        'components': [
            {
                'id': 'webhook_1',
                'provider': 'webhook',
                'config': {'mode': 'Source', 'type': 'webhook'},
            },
            {
                'id': 'visual_similarity_filter_1',
                'provider': 'visual_similarity_filter',
                'config': {'profile': 'clip-base'},
                'control': [{'classType': 'visual_similarity', 'from': 'webhook_1'}],
            },
        ],
    }

    @pytest.fixture(scope='class')
    def client(self):
        """Connect to the live engine."""
        import asyncio
        from rocketride import RocketRideClient

        async def _connect():
            c = RocketRideClient(uri=self.ENGINE_URI, auth=self.ENGINE_KEY)
            await c.connect()
            return c

        loop = asyncio.new_event_loop()
        try:
            c = loop.run_until_complete(_connect())
        except Exception as e:
            pytest.skip(f'Engine not reachable at {self.ENGINE_URI}: {e}')
        yield c, loop
        loop.run_until_complete(c.disconnect())
        loop.close()

    def test_engine_is_reachable(self, client):
        """Basic connectivity check."""
        c, loop = client
        result = loop.run_until_complete(c.ping())
        assert result is not None or result is None  # ping returns anything without error

    def test_vsf_pipeline_loads_without_error(self, client):
        """Load a pipeline containing visual_similarity_filter_1 — must not raise InvalidName."""
        c, loop = client
        result = loop.run_until_complete(c.use(pipeline=self.PIPELINE))
        assert 'token' in result, f'Expected token in response, got: {result}'
        token = result['token']
        assert token, 'Pipeline token should not be empty'

    def test_vsf_node_registered_with_correct_classtype(self, client):
        """
        Load the pipeline and verify the node was accepted.
        If classType is wrong, engine would throw InvalidName for 'visual_similarity'.
        The fact that use() succeeds confirms the node registered correctly.
        """
        c, loop = client
        result = loop.run_until_complete(c.use(pipeline=self.PIPELINE))
        # If we get here without exception, classType + capabilities registered fine
        assert result.get('token'), 'VSF node registered with correct classType and capabilities'
