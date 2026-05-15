# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the BSD 3-Clause license found in the
# LICENSE file in the root directory of this source tree.

import torch
try:
    import torch.distributed._functional_collectives as funcol
    from torch.distributed._tensor import DTensor
    _DISTRIBUTED_AVAILABLE = True
except (ModuleNotFoundError, ImportError):
    # AMD Windows ROCm: torch._C._distributed_c10d is not built into this torch.
    # Distributed float8 collectives are unused in single-GPU training.
    funcol = None
    DTensor = None
    _DISTRIBUTED_AVAILABLE = False

from torchao.float8.float8_training_tensor import Float8TrainingTensor


def tensor_already_casted_to_fp8(tensor: torch.Tensor) -> bool:
    """
    Check if the tensor is already casted to fp8, works if the local
    tensor is wrapped in DTensor.
    """
    if isinstance(tensor, Float8TrainingTensor):
        return True
    elif _DISTRIBUTED_AVAILABLE and DTensor is not None and isinstance(tensor, DTensor):
        # TODO: shall we stick to public API and directly use tensor.to_local() here?
        return tensor_already_casted_to_fp8(tensor._local_tensor)
    elif _DISTRIBUTED_AVAILABLE and funcol is not None and isinstance(tensor, funcol.AsyncCollectiveTensor):
        return tensor_already_casted_to_fp8(tensor.elem)

    return False
