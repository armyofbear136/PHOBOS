from datetime import timedelta
from typing import Optional

try:
    from torch._C._distributed_c10d import _DEFAULT_PG_TIMEOUT
except (ModuleNotFoundError, ImportError):
    # AMD Windows ROCm: torch._C is a C extension, not a package.
    _DEFAULT_PG_TIMEOUT = timedelta(seconds=1800)

__all__ = ["default_pg_timeout", "default_pg_nccl_timeout"]

default_pg_timeout: timedelta = _DEFAULT_PG_TIMEOUT

try:
    from torch._C._distributed_c10d import _DEFAULT_PG_NCCL_TIMEOUT
    default_pg_nccl_timeout: Optional[timedelta] = _DEFAULT_PG_NCCL_TIMEOUT
except (ModuleNotFoundError, ImportError):
    default_pg_nccl_timeout = None
