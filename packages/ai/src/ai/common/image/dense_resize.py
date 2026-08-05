"""Shared max-resolution / tiling helpers for dense-output vision nodes (depth, segmentation, background removal).

See vision suite build brief §1.3 and Plan #13. Primary strategy is max-edge resize: bound activation memory by downscaling the input so the long edge <= max_edge, run inference, then upsample the dense output back to the original size with type-appropriate interpolation. Tiling is a future extension point.
"""

from __future__ import annotations
from typing import Literal, Optional, Tuple, Union
import numpy as np
from PIL import Image


# Clamp bounds for max_edge. Below 256 inference quality collapses for most
# dense models; above 4096 the activation memory savings are moot.
_MIN_MAX_EDGE = 256
_MAX_MAX_EDGE = 4096


def default_max_edge(device: str, vram_gb: Optional[float] = None) -> int:
    """Recommended max_edge default per device. User config always wins; this is the fallback when unset/zero.

    cpu -> 512, mps -> 768, cuda -> 1024 (2048 if vram_gb >= 24).

    Args:
        device (str): Device string, e.g. 'cpu', 'mps', 'cuda', 'cuda:0'.
        vram_gb (Optional[float]): Available VRAM in gigabytes; only consulted for cuda.

    Returns:
        int: Recommended max long-edge in pixels.
    """
    device = (device or 'cpu').lower()
    if device.startswith('cuda'):
        return 2048 if (vram_gb or 0) >= 24 else 1024
    if device.startswith('mps'):
        return 768
    return 512


def resize_for_inference(
    image: Image.Image,
    max_edge: int,
) -> Tuple[Image.Image, Tuple[int, int]]:
    """Downscale image so long edge <= max_edge, preserving aspect ratio.

    Returns (resized_image, original_size=(W, H)). No-op (returns original + size) if already within bounds.
    Always uses LANCZOS for the input downscale. ``max_edge`` is clamped to ``[256, 4096]``.

    Args:
        image (Image.Image): Source PIL image.
        max_edge (int): Target maximum long-edge in pixels.

    Returns:
        Tuple[Image.Image, Tuple[int, int]]: (resized_image, (orig_W, orig_H)).
    """
    # Clamp to sane bounds so callers can't accidentally request degenerate sizes.
    max_edge = max(_MIN_MAX_EDGE, min(_MAX_MAX_EDGE, int(max_edge)))

    orig_w, orig_h = image.size  # PIL size is (W, H)

    # If already within bounds, return the original image untouched.
    if max(orig_w, orig_h) <= max_edge:
        return image, (orig_w, orig_h)

    # Compute uniform downscale factor against the long edge.
    scale = max_edge / float(max(orig_w, orig_h))

    # floor() to guarantee we end up <= max_edge on the long side.
    new_w = max(1, int(orig_w * scale))
    new_h = max(1, int(orig_h * scale))

    resized = image.resize((new_w, new_h), resample=Image.LANCZOS)
    return resized, (orig_w, orig_h)


def restore_dense_output(
    dense: Union[Image.Image, np.ndarray],
    original_size: Tuple[int, int],
    *,
    mode: Literal['bilinear', 'nearest', 'alpha'] = 'bilinear',
) -> Union[Image.Image, np.ndarray]:
    """Resize a dense per-pixel output back to original_size=(W, H) with type-appropriate interpolation.

    - mode='bilinear': continuous values (depth, RGB colorized) -> PIL BILINEAR.
    - mode='nearest':  discrete class maps -> PIL NEAREST.
    - mode='alpha':    RGBA -> split, bilinear on RGB, bilinear on alpha, recompose.

    Input type is preserved (PIL in -> PIL out; ndarray in -> ndarray out).

    Args:
        dense: Dense per-pixel output, either a PIL image or a numpy ndarray.
        original_size: Target size as (W, H) in PIL convention.
        mode: Interpolation strategy. See above.

    Returns:
        Resized dense output, matching the input container type.
    """
    target_w, target_h = int(original_size[0]), int(original_size[1])

    # Pick PIL resample filter based on mode.
    if mode == 'nearest':
        resample = Image.NEAREST
    else:
        # 'bilinear' and 'alpha' both use BILINEAR for their per-channel work.
        resample = Image.BILINEAR

    is_ndarray = isinstance(dense, np.ndarray)

    # ---- PIL path -----------------------------------------------------------
    if not is_ndarray:
        # Fast path: PIL handles all dtypes/modes it supports natively.
        if mode == 'alpha':
            # Split RGBA, resize each plane with bilinear, recompose.
            pil = dense if dense.mode == 'RGBA' else dense.convert('RGBA')
            r, g, b, a = pil.split()
            r = r.resize((target_w, target_h), resample=Image.BILINEAR)
            g = g.resize((target_w, target_h), resample=Image.BILINEAR)
            b = b.resize((target_w, target_h), resample=Image.BILINEAR)
            a = a.resize((target_w, target_h), resample=Image.BILINEAR)
            return Image.merge('RGBA', (r, g, b, a))
        return dense.resize((target_w, target_h), resample=resample)

    # ---- ndarray path -------------------------------------------------------
    # We round-trip through PIL to avoid adding scipy/cv2 as deps. This means
    # we have to be careful about dtypes that PIL can't represent directly
    # (e.g. float32 multi-channel, int32 class maps).
    arr: np.ndarray = dense
    orig_dtype = arr.dtype

    if mode == 'alpha':
        # Expect HxWx4 RGBA. Split, resize each plane, restack.
        if arr.ndim != 3 or arr.shape[2] != 4:
            raise ValueError(f"restore_dense_output mode='alpha' requires HxWx4 RGBA ndarray; got shape {arr.shape}")
        out_planes = []
        for c in range(4):
            plane = _resize_ndarray_plane(arr[..., c], target_w, target_h, Image.BILINEAR)
            out_planes.append(plane)
        out = np.stack(out_planes, axis=-1).astype(orig_dtype, copy=False)
        return out

    if arr.ndim == 2:
        # Single-channel: depth map, class map, alpha matte, etc.
        return _resize_ndarray_plane(arr, target_w, target_h, resample).astype(orig_dtype, copy=False)

    if arr.ndim == 3:
        # Multi-channel: resize each channel independently to preserve dtype.
        channels = arr.shape[2]
        out_planes = [_resize_ndarray_plane(arr[..., c], target_w, target_h, resample) for c in range(channels)]
        out = np.stack(out_planes, axis=-1).astype(orig_dtype, copy=False)
        return out

    raise ValueError(f'restore_dense_output expected a 2D or 3D ndarray; got ndim={arr.ndim}, shape={arr.shape}')


def _resize_ndarray_plane(
    plane: np.ndarray,
    target_w: int,
    target_h: int,
    resample: int,
) -> np.ndarray:
    """Resize a single 2D ndarray plane via PIL round-trip, preserving dtype range as best PIL allows.

    PIL natively supports uint8 ('L'), int32 ('I'), and float32 ('F') 2D modes. Other dtypes are
    cast to float32 for the resize and cast back at the end.
    """
    src_dtype = plane.dtype

    if src_dtype == np.uint8:
        pil = Image.fromarray(plane, mode='L')
        out = pil.resize((target_w, target_h), resample=resample)
        return np.asarray(out, dtype=np.uint8)

    if src_dtype == np.int32:
        # NEAREST is the safe default for int class maps; bilinear on int32 is
        # uncommon but PIL supports it via mode 'I'.
        pil = Image.fromarray(plane, mode='I')
        out = pil.resize((target_w, target_h), resample=resample)
        return np.asarray(out, dtype=np.int32)

    if src_dtype == np.float32:
        pil = Image.fromarray(plane, mode='F')
        out = pil.resize((target_w, target_h), resample=resample)
        return np.asarray(out, dtype=np.float32)

    # Fallback: cast to float32 for the resize, then back to source dtype.
    as_f32 = plane.astype(np.float32, copy=False)
    pil = Image.fromarray(as_f32, mode='F')
    out = pil.resize((target_w, target_h), resample=resample)
    return np.asarray(out, dtype=np.float32).astype(src_dtype, copy=False)


def restore_rle_mask(rle: dict, original_size: Tuple[int, int]) -> dict:
    """Decode COCO RLE, resize with NEAREST to original_size=(W, H), re-encode.

    Imports ``pycocotools.mask`` lazily; raises ImportError with a clear message if unavailable.
    rle dict format: ``{'size': [h, w], 'counts': str}``.

    Args:
        rle (dict): COCO-format RLE dict.
        original_size (Tuple[int, int]): Target size as (W, H) in PIL convention.

    Returns:
        dict: New COCO RLE dict at the target size.
    """
    try:
        from pycocotools import mask as mask_utils  # type: ignore
    except ImportError as exc:
        raise ImportError(
            "pycocotools is required to resize RLE masks; install it in the segmentation node's requirements."
        ) from exc

    target_w, target_h = int(original_size[0]), int(original_size[1])

    # Decode RLE -> HxW uint8 binary mask. pycocotools returns HxW (sometimes HxWx1).
    decoded = mask_utils.decode(rle)
    if decoded.ndim == 3:
        # Single-instance RLE may still come back as HxWx1; squeeze the trailing axis.
        decoded = decoded[..., 0]

    # NEAREST resize via PIL to preserve binary class identity.
    pil = Image.fromarray(decoded.astype(np.uint8) * 255, mode='L')
    resized = pil.resize((target_w, target_h), resample=Image.NEAREST)
    resized_arr = (np.asarray(resized, dtype=np.uint8) > 0).astype(np.uint8)

    # Re-encode. pycocotools.encode requires Fortran-order uint8.
    fortran = np.asfortranarray(resized_arr)
    encoded = mask_utils.encode(fortran)

    # mask_utils.encode returns counts as bytes; normalize to str for JSON friendliness.
    if isinstance(encoded.get('counts'), bytes):
        encoded['counts'] = encoded['counts'].decode('utf-8')

    return encoded
