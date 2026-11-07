"""The engine's dep bootstrapper must survive collection.

Some node test modules replace ``sys.modules['depends']`` with a no-op so that
``import rocketlib`` works without the engine's bootstrapper. If the no-op is
still there when another test runs, ``load_depends()`` installs nothing and the
node that needed a package fails with ``ModuleNotFoundError`` (see #3097:
``test_embedding_image`` and torch). ``tool_git/test_tools.py`` installs its stub
inside ``patch.dict`` for exactly that reason; this test fails if any module
leaks one.
"""

import sys


def test_the_live_dep_bootstrapper_is_the_real_module():
    # Import the module that installs the stub, so this test exercises the leak on its
    # own: run alone, pytest would never collect it and the check could pass regardless.
    import tool_git.test_tools  # noqa: F401

    module = sys.modules.get('depends')
    assert module is not None, 'depends is not importable in this engine runtime'
    assert getattr(module, '__file__', None), 'a test module left a no-op stub in sys.modules["depends"]'
    assert callable(getattr(module, 'load_depends', None)), 'depends.load_depends is not the engine implementation'
