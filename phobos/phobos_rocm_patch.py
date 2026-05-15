# phobos_rocm_patch.py — injected via phobos_rocm_patch.pth at Python startup (ROCm venv only).
# This file is ONLY deployed into the ROCm venv's site-packages by PythonEnvManager.
# It must NOT import torch before installing the _distributed_c10d stub, because
# torch itself triggers the crash chain on first import.

import sys
import types
import functools


# ── Patch 2 (must run FIRST, before any torch import): _distributed_c10d stub ──
# torch.distributed.distributed_c10d line 23 unconditionally does:
#   from torch._C._distributed_c10d import (...)
# torch._C is a C extension (not a package) on AMD Windows ROCm, so submodule
# imports raise ModuleNotFoundError.  This fires during `import torch` itself via
# torchao.float8 → torch.distributed._functional_collectives.
# Install the stub BEFORE torch is imported so it's in sys.modules when needed.
_STUB_KEY = 'torch._C._distributed_c10d'
if _STUB_KEY not in sys.modules:
    _stub = types.ModuleType(_STUB_KEY)

    class _NoOp:
        def __init__(self, *a, **kw): pass
        def __call__(self, *a, **kw): return None
        def __getattr__(self, n): return type(self)()
        def __class_getitem__(cls, item): return cls
        def __set_name__(self, owner, name): pass

    for _name in [
        '_DistributedBackendOptions', '_register_process_group',
        '_resolve_process_group', '_unregister_all_process_groups',
        '_unregister_process_group', 'AllgatherOptions',
        'AllreduceCoalescedOptions', 'AllreduceOptions', 'AllToAllOptions',
        'BarrierOptions', 'BroadcastOptions', 'DebugLevel', 'GatherOptions',
        'get_debug_level', 'PrefixStore', 'ProcessGroup', 'ReduceOp',
        'ReduceOptions', 'ReduceScatterOptions', 'ScatterOptions', 'Store',
        'Work', 'HashStore', 'ProcessGroupMPI', 'ProcessGroupNCCL',
        '_ProcessGroupWrapper', 'ProcessGroupGloo', 'ProcessGroupUCC',
        '_broadcast_coalesced', '_compute_bucket_assignment_by_size',
        '_ControlCollectives', '_DEFAULT_FIRST_BUCKET_BYTES',
        '_make_nccl_premul_sum', '_register_builtin_comm_hook',
        '_register_comm_hook', '_StoreCollectives', '_test_python_store',
        '_verify_params_across_processes', 'Backend', 'BuiltinCommHookType',
        'FileStore', 'Logger', 'Reducer', 'set_debug_level',
        'set_debug_level_from_env', 'TCPStore',
    ]:
        setattr(_stub, _name, _NoOp)

    class _ReduceOp(_NoOp):
        SUM = 0; AVG = 1; PRODUCT = 2; MIN = 3; MAX = 4
        BAND = 5; BOR = 6; BXOR = 7; PREMUL_SUM = 8
    _stub.ReduceOp = _ReduceOp

    sys.modules[_STUB_KEY] = _stub


# ── Patch 1 (after stub, safe to import torch): unsloth_zoo.device_type ─────
def _patch_device_type():
    try:
        import torch
    except ImportError:
        return

    version_str = getattr(torch, '__version__', '') or ''
    is_rocmsdk = 'rocmsdk' in version_str.lower()
    if not is_rocmsdk:
        try:
            import ctypes
            ctypes.WinDLL('amdhip64.dll')
            is_rocmsdk = True
        except Exception:
            pass
    if not is_rocmsdk:
        return

    class _DeviceTypePatcher:
        _done = False

        def find_module(self, name, path=None):
            if name == 'unsloth_zoo.device_type' and not self._done:
                return self
            return None

        def load_module(self, name):
            if name in sys.modules:
                return sys.modules[name]
            self._done = True
            import importlib.util
            spec = importlib.util.find_spec(name)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod

            @functools.cache
            def _patched_get_device_type():
                if hasattr(torch, 'cuda') and torch.cuda.is_available():
                    hip = bool(getattr(getattr(torch, 'version', None), 'hip', None))
                    return 'hip' if hip else 'cuda'
                return 'cuda'

            mod.get_device_type = _patched_get_device_type
            spec.loader.exec_module(mod)
            mod.get_device_type = _patched_get_device_type
            if mod.DEVICE_TYPE not in ('cuda', 'hip', 'xpu'):
                mod.DEVICE_TYPE = 'cuda'
                mod.DEVICE_TYPE_TORCH = 'cuda'
            try:
                sys.meta_path.remove(self)
            except ValueError:
                pass
            return mod

    sys.meta_path.insert(0, _DeviceTypePatcher())


_patch_device_type()