#!/usr/bin/env python3
"""
Print installed GPU, CUDA driver, and PyTorch/CUDA compatibility.

Run with the engine's Python or any env that has torch and nvidia-ml-py:
  engine -m scripts.check_gpu
  python scripts/check_gpu.py

Or from repo root with engine from dist/server:
  dist\server\engine.exe ../../scripts/check_gpu.py
"""

from __future__ import annotations

import sys
import subprocess
from typing import Optional


# -----------------------------------------------------------------------------
# 1. GPU and driver (nvidia-smi)
# -----------------------------------------------------------------------------
def get_nvidia_smi() -> Optional[str]:
    try:
        out = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,driver_version,compute_cap', '--format=csv,noheader'],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return None


def get_nvidia_smi_driver() -> Optional[str]:
    try:
        out = subprocess.run(
            ['nvidia-smi', '--query-gpu=driver_version', '--format=csv,noheader'],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip().split('\n')[0].strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return None


# -----------------------------------------------------------------------------
# 2. PyTorch and CUDA (torch)
# -----------------------------------------------------------------------------
def get_torch_info() -> Optional[dict]:
    try:
        import torch

        info = {
            'torch_version': torch.__version__,
            'cuda_available': torch.cuda.is_available(),
            'cuda_version': getattr(torch.version, 'cuda', None) or '',
        }
        if torch.cuda.is_available():
            info['device_name'] = torch.cuda.get_device_name(0)
            info['arch_list'] = torch.cuda.get_arch_list()
            try:
                # compute_capability as (major, minor), e.g. (8, 9) for sm_89
                cap = torch.cuda.get_device_capability(0)
                info['compute_capability'] = f'{cap[0]}.{cap[1]} (sm_{cap[0]}{cap[1]})'
            except Exception:
                info['compute_capability'] = 'unknown'
        else:
            info['device_name'] = None
            info['arch_list'] = []
            info['compute_capability'] = 'N/A (no CUDA)'
        return info
    except ImportError:
        return None


# -----------------------------------------------------------------------------
# 3. Project defaults and compatibility note
# -----------------------------------------------------------------------------
PROJECT_TORCH = '2.8.0+cu128'
PROJECT_CUDA = '12.8'
# PyTorch 2.8.0+cu128 supports sm_61 through sm_120 (including Blackwell RTX 50 / RTX PRO 4000).
COMPAT_NOTE = f'This project pins torch {PROJECT_TORCH} (CUDA {PROJECT_CUDA}). That build supports sm_61, sm_70, sm_75, sm_80, sm_86, sm_90, and sm_120 (Blackwell). Driver must support CUDA 12.8+. See https://pytorch.org/get-started/locally/ for other builds.'


def main() -> int:
    print('=== GPU & CUDA / PyTorch check ===\n')

    # NVIDIA driver / GPU
    nv = get_nvidia_smi()
    if nv:
        print('NVIDIA GPU (nvidia-smi):')
        for line in nv.split('\n'):
            print(f'  {line.strip()}')
        driver = get_nvidia_smi_driver()
        if driver:
            print(f'  Driver version: {driver}')
    else:
        print('NVIDIA GPU: nvidia-smi not found or no GPU reported.\n')

    # PyTorch
    ti = get_torch_info()
    if ti:
        print('\nPyTorch:')
        print(f'  torch version: {ti["torch_version"]}')
        print(f'  CUDA in build: {ti["cuda_version"] or "N/A"}')
        print(f'  CUDA available at runtime: {ti["cuda_available"]}')
        if ti.get('device_name'):
            print(f'  Device name: {ti["device_name"]}')
        if ti.get('compute_capability'):
            print(f'  Compute capability: {ti["compute_capability"]}')
        if ti.get('arch_list'):
            print(f'  torch.cuda.get_arch_list(): {ti["arch_list"]}')
    else:
        print('\nPyTorch: not installed or import failed.\n')

    print('\n---')
    print(COMPAT_NOTE)
    print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
