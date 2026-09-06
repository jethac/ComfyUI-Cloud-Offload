"""Small compatibility fixture for the ComfyUI V3 schema smoke tests.

The real ``comfy_api`` package is supplied by a ComfyUI checkout and is not a
standalone PyPI dependency.  Keep CI independent of a full ComfyUI install by
providing only the schema surface exercised by these tests.  A real install is
always preferred and is never shadowed.
"""

from __future__ import annotations

import importlib.util
import sys
import types


def _install_schema_fixture() -> None:
    if "comfy_api" in sys.modules:
        return
    try:
        if importlib.util.find_spec("comfy_api") is not None:
            return
    except ModuleNotFoundError:
        pass

    class _Socket:
        def __init__(self, name: str, **kwargs: object) -> None:
            self.name = name
            self.options = kwargs

        @classmethod
        def Input(cls, name: str, **kwargs: object) -> "_Socket":
            return cls(name, **kwargs)

        @classmethod
        def Output(cls, **kwargs: object) -> "_Socket":
            return cls("output", **kwargs)

    class _AnyType:
        Input = _Socket.Input
        Output = _Socket.Output

    class _IO:
        ComfyNode = object
        NodeOutput = lambda value=None, **kwargs: (value, kwargs)
        Schema = lambda **kwargs: types.SimpleNamespace(**kwargs)
        Custom = staticmethod(lambda _name: _Socket)
        String = _Socket
        Combo = _Socket
        Int = _Socket
        AnyType = _AnyType

    latest = types.ModuleType("comfy_api.latest")
    latest.ComfyExtension = object
    latest.io = _IO
    package = types.ModuleType("comfy_api")
    package.__path__ = []
    package.latest = latest
    sys.modules["comfy_api"] = package
    sys.modules["comfy_api.latest"] = latest


_install_schema_fixture()
