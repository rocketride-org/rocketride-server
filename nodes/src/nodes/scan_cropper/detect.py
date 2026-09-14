# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Finding the separate photos inside one scanned page.

The detector makes no assumption about what colour the background is — it works that out from
the scan itself. A pixel is background when it is plain (no local texture), painted in one of
the scan's dominant colours, and part of a region that reaches the edge of the scan; all three
conditions are needed, since texture alone keeps the scanner lid, colour alone eats dark
clothing that matches a dark page, and reachability alone eats a photo touching the scan edge.

Photos mounted edge to edge never come apart by eroding, so a blob is additionally cut along
any straight border that spans it, recursively.

Detection runs on a downscaled copy and the rectangles are scaled back up, which is what makes
a 143 MP scan tractable at all.

Ported from the author's own work in ``autocrop`` (commit ``faf2942``), with ``dedupe`` and the
standard-print-ratio arbitration from ``ScanCropper`` (commit ``120c81b``). Tunables that were
module globals upstream are threaded through :class:`DetectParams` so the node's config
actually reaches ``fit_rect``.
"""

from dataclasses import dataclass

from ai.common.opencv import cv2
import numpy as np

from .geometry import normalise_rect, ratio_error, rect_axes

# How rectangular a blob has to be to be taken as one photo, and how rectangular it has to be
# if it would not split. These are calibrated against *this* detector's texture mask, which
# produces far cleaner blobs than a brightness threshold does — do not import the looser value
# a threshold-based detector needs.
MIN_FILL = 0.88
FALLBACK_FILL = 0.60

# Share of a line that must be photo border before a blob is cut there.
SEAM_COVERAGE = 0.85

# How far outside a photo, relatively, to look for its real border.
SNAP_REACH = 0.25

# Per-channel tolerance when matching a background colour, and the share of the plain pixels a
# colour needs before it counts as background at all (or of the plain pixels in the outer frame,
# which is how the narrow strip of scanner lid gets recognised despite being a tiny share).
COLOUR_TOL = 26
COLOUR_SUPPORT = 0.04
FRAME_SUPPORT = 0.15

# Two neighbouring photos tile a blob evenly; one photo that merely fragmented gives lopsided
# pieces. Minimum smaller/larger area for a cut to read as "two photos".
SPLIT_EVENNESS = 0.5

# Two candidates overlapping this much are the same photo.
DUP_OVERLAP = 0.6


@dataclass(frozen=True)
class DetectParams:
    """
    The node's tunables, resolved once and threaded through the whole detection chain.

    Upstream these were module globals read directly inside ``fit_rect``, which the call chain
    never passed down; carrying them explicitly is what makes the node's config fields do
    anything at all.

    Attributes:
        detect_size: Longest edge, in pixels, that detection runs on.
        texture: Local std-dev below which a pixel counts as plain paper.
        min_area: Smallest accepted photo, as a share of the scan.
        max_area: Largest accepted photo, as a share of the scan.
        max_aspect: Anything longer than this is not a photo.
        min_relative: A find this much smaller than the biggest one is a fragment.
        max_depth: How many times one blob may be cut. 0 disables seam cutting entirely.
        skew: Degrees either side of a blob's own angle to hunt for a seam. Must be > 0.
        ratio_tolerance: Percent a piece may deviate from a standard print ratio when
            arbitrating a seam.
    """

    detect_size: int = 3000
    texture: float = 4.0
    min_area: float = 0.005
    max_area: float = 0.95
    max_aspect: float = 5.0
    min_relative: float = 0.40
    max_depth: int = 4
    skew: float = 1.5
    ratio_tolerance: float = 8.0


def local_std(gray, k: int = 5):
    """
    Local standard deviation: high on photo content, near zero on plain paper.

    Args:
        gray: Grayscale image as float32.
        k: Window size in pixels.

    Returns:
        numpy.ndarray: Per-pixel standard deviation, same shape as ``gray``.
    """
    mu = cv2.blur(gray, (k, k))
    mu2 = cv2.blur(gray * gray, (k, k))
    return np.sqrt(np.maximum(mu2 - mu * mu, 0))


def colour_peaks(code, mask, support: float, limit: int = 8):
    """
    The colours that most of the given pixels are painted in.

    Args:
        code: Per-pixel packed colour index (5 bits per channel).
        mask: Boolean mask selecting the pixels to consider.
        support: Minimum share of the masked pixels a colour needs to qualify.
        limit: Most colours to return.

    Returns:
        list: Packed colour codes, most common first.
    """
    if not mask.any():
        return []
    counts = np.bincount(code[mask].ravel(), minlength=32768)
    total = max(1, int(mask.sum()))
    peaks = []
    for c in np.argsort(counts)[::-1][:limit]:
        if counts[c] <= support * total:
            break  # sorted, so the rest are smaller too
        peaks.append(int(c))
    return peaks


def unpack_colour(code: int):
    """
    Expand a packed colour code back to the centre of its BGR bucket.

    Args:
        code: A packed colour index produced by the 5-bit-per-channel quantisation.

    Returns:
        numpy.ndarray: The representative BGR value as int16.
    """
    return np.array(
        [(code // 1024) * 8 + 4, ((code // 32) % 32) * 8 + 4, (code % 32) * 8 + 4],
        dtype=np.int16,
    )


def foreground_mask(img, params: DetectParams):
    """
    Mark everything that is not background.

    A pixel is background when it is plain, painted in one of the scan's background colours,
    and part of a region reaching the edge of the scan. Every photo border is a strong gradient,
    and treating those pixels as a wall stops the page leaking into a photo through its own
    border and eating the dark clothing or blown-out sky that happens to match a background
    colour. Reachability is judged one colour at a time, since sharing a single mask would let a
    white sky inside a photo touch the dark page beside it and drain away.

    Args:
        img: The (downscaled) scan as a BGR array.
        params: Resolved tunables; only ``texture`` is read here.

    Returns:
        numpy.ndarray | None: A uint8 mask, 255 on photo content, or ``None`` when no background
        colour could be identified at all.
    """
    h, w = img.shape[:2]
    gray = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (3, 3), 0).astype(np.float32)
    plain = local_std(gray) < params.texture

    q = (img >> 3).astype(np.int32)  # 32 levels per channel
    code = q[:, :, 0] * 1024 + q[:, :, 1] * 32 + q[:, :, 2]
    peaks = colour_peaks(code, plain, COLOUR_SUPPORT)

    # A scanner leaves a narrow strip of lid along the edge of the platen. It is far too small a
    # share of the scan to reach the support threshold above, yet it is certainly background, so
    # read the colours of the outer frame as well.
    b = max(4, int(round(0.015 * min(h, w))))
    frame = np.zeros((h, w), dtype=bool)
    frame[:b, :] = frame[-b:, :] = frame[:, :b] = frame[:, -b:] = True
    for c in colour_peaks(code, plain & frame, FRAME_SUPPORT, limit=4):
        if c not in peaks:
            peaks.append(c)
    if not peaks:
        return None

    gx = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3))
    gy = np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))
    edges = gx + gy
    wall = (
        cv2.dilate(
            (edges > max(20.0, 4.0 * float(np.median(edges)))).astype(np.uint8),
            np.ones((3, 3), np.uint8),
        )
        > 0
    )

    img16 = img.astype(np.int16)
    bg = np.zeros((h, w), dtype=bool)
    for c in peaks:
        same = plain & ~wall & (np.abs(img16 - unpack_colour(c)).max(axis=2) < COLOUR_TOL)
        # By keyword: the second positional parameter is the output `labels`, not connectivity.
        _, labels = cv2.connectedComponents(same.astype(np.uint8), connectivity=8)
        at_border = set(labels[0, :]) | set(labels[-1, :]) | set(labels[:, 0]) | set(labels[:, -1])
        at_border.discard(0)
        if at_border:
            bg |= np.isin(labels, list(at_border))

    # The wall itself is only worth keeping where it hugs a photo; elsewhere it is just page
    # grain and dust, which would litter the mask with thin lines.
    near = cv2.dilate((~bg).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    bg |= wall & ~near

    fg = (~bg).astype(np.uint8) * 255
    r = max(3, int(round(0.004 * min(h, w))) | 1)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((r, r), np.uint8))
    return cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((r, r), np.uint8))


def border_maps(img, fg):
    """
    Pixels that could be part of a photo border, split by orientation.

    Args:
        img: The (downscaled) scan region as a BGR array.
        fg: The foreground mask for that region.

    Returns:
        tuple: ``(vx, vy)`` uint8 masks of vertical and horizontal border evidence.
    """
    gray = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (3, 3), 0).astype(np.float32)
    gx = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3))
    gy = np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))
    tx = max(14.0, 2.5 * float(np.median(gx)))
    ty = max(14.0, 2.5 * float(np.median(gy)))
    outline = cv2.morphologyEx(fg, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    return (
        ((gx > tx).astype(np.uint8) * 255) | outline,
        ((gy > ty).astype(np.uint8) * 255) | outline,
    )


def rotate_about_centre(masks, angle: float, shape):
    """
    Rotate masks into a canvas big enough that nothing is clipped off the corners.

    Args:
        masks: Sequence of uint8 masks, all of ``shape``.
        angle: Rotation in degrees.
        shape: ``(h, w)`` of the input masks.

    Returns:
        tuple: ``(rotated, matrix)`` — the rotated masks and the 2x3 affine used, whose rows are
        needed to express the resulting cut back in the blob's own frame.
    """
    h, w = shape
    d = int(np.ceil(np.hypot(h, w))) + 2
    matrix = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), angle, 1.0)
    matrix[0, 2] += (d - w) / 2.0
    matrix[1, 2] += (d - h) / 2.0
    return [cv2.warpAffine(m, matrix, (d, d), flags=cv2.INTER_NEAREST) for m in masks], matrix


def best_seam(
    fg,
    vx,
    vy,
    base: float,
    sweep: float,
    coverage: float = SEAM_COVERAGE,
    max_band: float = 0.02,
    margin: float = 0.12,
    min_extent: float = 0.40,
):
    """
    The strongest straight photo border crossing an entire blob.

    Photos mounted edge to edge never come apart by eroding, but the join is still a straight
    border spanning the blob, so cut there. Coverage is measured over the blob's whole extent
    along the line, which is what keeps a cut from running through a photo: a line that does
    scores only as high as the fraction of its length that happens to be border. The blob is not
    downscaled for this — a border is one pixel across and shrinking dilutes it in exactly the
    direction that matters.

    Args:
        fg: The blob's foreground mask.
        vx: Vertical border evidence, same shape as ``fg``.
        vy: Horizontal border evidence, same shape as ``fg``.
        base: The blob's own angle in degrees, which the sweep is centred on.
        sweep: Degrees either side of ``base`` to search. Must be greater than zero.
        coverage: Share of a line that must be border for it to be a candidate cut.
        max_band: Widest run of qualifying lines still treated as a join rather than content.
        margin: Share of the blob's extent ignored at each end, so its own outer edges are not
            mistaken for an internal join.
        min_extent: Minimum share of the blob's span a line must cross to be scored.

    Returns:
        tuple | None: ``(score, a, b, c)`` where the cut is the line ``a*x + b*y + c = 0``, or
        ``None`` when no line qualifies.
    """
    # roughly one sample per degree, but never fewer than five
    samples = max(5, 2 * int(round(sweep)) + 1)
    step = 2.0 * sweep / (samples - 1)

    best = None
    for delta in np.arange(-sweep, sweep + 1e-9, step):
        (rfg, rvx, rvy), matrix = rotate_about_centre([fg, vx & fg, vy & fg], base + delta, fg.shape)
        on = rfg > 0
        for axis in (0, 1):  # 0 = cut down, 1 = cut across
            marks = ((rvx if axis == 0 else rvy) > 0) & on
            extent = on.sum(axis=axis).astype(np.float32)
            border = marks.sum(axis=axis).astype(np.float32)
            span = float(extent.max())
            if span < 8:
                continue
            used = np.flatnonzero(extent > 0)
            if used.size < 16:
                continue
            lo, hi = used[0], used[-1]
            inset = int((hi - lo) * margin)
            lo, hi = lo + inset, hi - inset
            width = hi - lo
            if width < 8:
                continue
            cover = np.where(extent >= min_extent * span, border / np.maximum(extent, 1), 0.0)

            i = lo
            while i < hi:
                if cover[i] < coverage:
                    i += 1
                    continue
                j = i
                while j < hi and cover[j] >= coverage:
                    j += 1
                if (j - i) <= max_band * width:  # a wide band is content, not a join
                    score = float(cover[i:j].max()) * float(extent[i:j].mean() / span)
                    if best is None or score > best[0]:
                        row = matrix[0] if axis == 0 else matrix[1]
                        best = (score, row[0], row[1], row[2] - (i + j) / 2.0)
                i = j
    return best


def split_on(fg, a: float, b: float, c: float):
    """
    The two half planes of a cut, in the blob's own frame — no resampling.

    Args:
        fg: The blob's foreground mask.
        a: Line coefficient for x.
        b: Line coefficient for y.
        c: Line constant.

    Returns:
        tuple: Two uint8 masks, the parts of ``fg`` either side of the line.
    """
    h, w = fg.shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    side = a * xs + b * ys + c
    keep = fg > 0
    return (
        ((side < 0) & keep).astype(np.uint8) * 255,
        ((side >= 0) & keep).astype(np.uint8) * 255,
    )


def drop_sliver(mask):
    """
    Open away the thin sliver a cut leaves behind.

    A cut is never exactly parallel to the join, so a thin sliver of the far photo stays
    attached to the near one; measuring the piece with that sliver still on it would misjudge
    both its ratio and its area.

    Args:
        mask: One side of a cut.

    Returns:
        numpy.ndarray: The mask with thin attachments opened away.
    """
    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        return mask
    k = max(3, int(0.02 * min(xs.max() - xs.min() + 1, ys.max() - ys.min() + 1)) | 1)
    return cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))


def fit_rect(mask, page_area: float, min_fill: float, params: DetectParams):
    """
    The rectangle of the largest blob in a mask, if it could plausibly be a photo.

    Args:
        mask: A foreground mask.
        page_area: Area of the whole (downscaled) scan, in pixels.
        min_fill: Minimum contour area over bounding-rectangle area.
        params: Resolved tunables; ``min_area``, ``max_area`` and ``max_aspect`` are read here.

    Returns:
        tuple | None: The ``minAreaRect``, or ``None`` when the blob is too small, too large,
        too elongated or too ragged to be a photo.
    """
    cnts = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
    if not cnts:
        return None
    cnt = max(cnts, key=cv2.contourArea)
    area = cv2.contourArea(cnt)
    rect = cv2.minAreaRect(cnt)
    rw, rh = rect[1]
    if rw <= 0 or rh <= 0:
        return None
    if not (page_area * params.min_area < rw * rh < page_area * params.max_area):
        return None
    if max(rw, rh) / min(rw, rh) > params.max_aspect:
        return None
    if area / (rw * rh) < min_fill:
        return None
    return rect


def _accept_split(whole, parts, page_area: float, params: DetectParams) -> bool:
    """
    Decide whether a seam cut really separated two photos, or merely fragmented one.

    Standard print ratios arbitrate here and **only** here — as a veto, never as a requirement.
    Demanding that both pieces be standard would refuse to separate two non-standard prints
    mounted edge to edge, which is the exact case seam cutting exists for. So: take the split
    when its pieces look like prints and tile the blob evenly; keep the blob whole when they do
    not *and* the undivided blob is itself ratio-plausible as a single photo; and when neither
    reading looks standard, trust the seam, which already had to clear ``SEAM_COVERAGE`` to
    exist at all.

    Args:
        whole: The undivided blob's foreground mask.
        parts: The rectangles the cut produced, two or more.
        page_area: Area of the whole (downscaled) scan, in pixels.
        params: Resolved tunables; ``ratio_tolerance`` is read here.

    Returns:
        bool: True to keep the split, False to keep the blob whole.
    """
    sizes = [p[1][0] * p[1][1] for p in parts]
    evenness = min(sizes) / max(sizes) if max(sizes) > 0 else 0.0
    pieces_standard = all(ratio_error(p) <= params.ratio_tolerance for p in parts)

    if pieces_standard and evenness >= SPLIT_EVENNESS:
        return True

    whole_rect = fit_rect(whole, page_area, MIN_FILL, params) or fit_rect(whole, page_area, FALLBACK_FILL, params)
    whole_standard = whole_rect is not None and ratio_error(whole_rect) <= params.ratio_tolerance
    return not whole_standard


def decompose(fg, vx, vy, base: float, page_area: float, depth: int, params: DetectParams):
    """
    Split a mask into its separate parts, then decompose each one on its own.

    Args:
        fg: A foreground mask, possibly holding several disconnected blobs.
        vx: Vertical border evidence for the region.
        vy: Horizontal border evidence for the region.
        base: The region's own angle in degrees.
        page_area: Area of the whole (downscaled) scan, in pixels.
        depth: Current recursion depth.
        params: Resolved tunables.

    Returns:
        list: Accepted rectangles, in region coordinates.
    """
    found = []
    for cnt in cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        if cv2.contourArea(cnt) < page_area * params.min_area * 0.4:
            continue
        part = np.zeros_like(fg)
        cv2.drawContours(part, [cnt], -1, 255, cv2.FILLED)
        found += decompose_one(part, vx, vy, base, page_area, depth, params)
    return found


def decompose_one(fg, vx, vy, base: float, page_area: float, depth: int, params: DetectParams):
    """
    Cut one connected blob along its strongest internal border, recursively.

    Args:
        fg: One connected blob's mask.
        vx: Vertical border evidence for the region.
        vy: Horizontal border evidence for the region.
        base: The region's own angle in degrees.
        page_area: Area of the whole (downscaled) scan, in pixels.
        depth: Current recursion depth.
        params: Resolved tunables; ``max_depth`` and ``skew`` gate the search.

    Returns:
        list: One rectangle if the blob is a photo, several if it split, empty if neither.
    """
    if depth < params.max_depth:
        seam = best_seam(fg, vx, vy, base, sweep=params.skew)
        if seam:
            a, b = split_on(fg, *seam[1:])
            left = decompose(drop_sliver(a), vx, vy, base, page_area, depth + 1, params)
            right = decompose(drop_sliver(b), vx, vy, base, page_area, depth + 1, params)
            parts = left + right
            # A cut that explains no more than the blob did is not worth making.
            if len(parts) >= 2 and _accept_split(fg, parts, page_area, params):
                return parts
    rect = fit_rect(fg, page_area, MIN_FILL, params) or fit_rect(fg, page_area, FALLBACK_FILL, params)
    return [rect] if rect else []


def drop_fragments(rects, min_relative: float):
    """
    Discard finds far smaller than the biggest one on the page.

    A photo that lost part of itself to the background comes back as several small pieces.
    Prints mounted on one page are the same size, so anything much smaller than the biggest find
    is a fragment, not a photo.

    Args:
        rects: Candidate rectangles.
        min_relative: Minimum area relative to the largest find. Zero disables the filter.

    Returns:
        list: The rectangles that survived.
    """
    if not rects or min_relative <= 0:
        return list(rects)
    biggest = max(r[1][0] * r[1][1] for r in rects)
    return [r for r in rects if r[1][0] * r[1][1] >= min_relative * biggest]


def snap_to_border(img, rect, coverage: float = 0.55, reach: float = SNAP_REACH, max_change: float = 0.45):
    """
    Pull a rectangle out onto the photo's real borders.

    Where the mask lost a pale sky or dark clothing along one side the rectangle comes out
    short. The border is still a straight edge running the length of the photo, so look for it a
    little way either side of where we think it is.

    Args:
        img: The (downscaled) scan as a BGR array.
        rect: The rectangle to refine.
        coverage: Share of a line that must be edge for it to be believed.
        reach: How far outside the photo to look, relative to its shorter side.
        max_change: Largest relative area change accepted; beyond this the original is kept.

    Returns:
        tuple: The refined rectangle, or the input unchanged when no better border was found or
        the candidate would be a wild jump.
    """
    rect = normalise_rect(rect)
    (cx, cy), (w, h), angle = rect
    if w < 16 or h < 16:
        return rect

    m = max(8, int(reach * min(w, h)))
    bw, bh = int(round(w)) + 2 * m, int(round(h)) + 2 * m
    u, v = rect_axes(rect)
    c = np.array([cx, cy])
    src = np.array(
        [
            c - bw / 2 * u - bh / 2 * v,
            c + bw / 2 * u - bh / 2 * v,
            c + bw / 2 * u + bh / 2 * v,
            c - bw / 2 * u + bh / 2 * v,
        ],
        dtype=np.float32,
    )
    dst = np.array([[0, 0], [bw - 1, 0], [bw - 1, bh - 1], [0, bh - 1]], dtype=np.float32)
    around = cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, dst), (bw, bh))

    gray = cv2.GaussianBlur(cv2.cvtColor(around, cv2.COLOR_BGR2GRAY), (3, 3), 0).astype(np.float32)
    gx = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3))
    gy = np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))
    down = gx > max(14.0, 2.5 * float(np.median(gx)))
    across = gy > max(14.0, 2.5 * float(np.median(gy)))
    per_col = down[m : bh - m, :].mean(axis=0)
    per_row = across[:, m : bw - m].mean(axis=1)

    def strongest(cover, at):
        """The best-covered line within reach of ``at``, or ``at`` when none is convincing."""
        lo, hi = max(0, at - m), min(len(cover), at + m + 1)
        window = cover[lo:hi]
        if window.size == 0:
            return at
        best = int(np.argmax(window)) + lo
        return best if cover[best] >= coverage else at

    left, right = strongest(per_col, m), strongest(per_col, bw - m)
    top, bottom = strongest(per_row, m), strongest(per_row, bh - m)
    if right - left < 16 or bottom - top < 16:
        return rect

    nw, nh = float(right - left), float(bottom - top)
    if abs(nw * nh - w * h) > max_change * w * h:  # refuse a wild jump
        return rect
    if max(nw, nh) / min(nw, nh) > 5.0:
        return rect
    centre = c + ((left + right) / 2.0 - bw / 2.0) * u + ((top + bottom) / 2.0 - bh / 2.0) * v
    return ((float(centre[0]), float(centre[1])), (nw, nh), angle)


def dedupe(rects, overlap_frac: float = DUP_OVERLAP):
    """
    Drop rectangles that are really the same photo found twice.

    ``decompose`` produces disjoint parts by construction, but ``snap_to_border`` grows
    rectangles afterwards and can push two into overlap, so this runs after the snap pass.

    Args:
        rects: Candidate rectangles.
        overlap_frac: Share of the smaller rectangle that must be covered to count as a
            duplicate.

    Returns:
        list: The rectangles kept, largest first.
    """
    kept = []
    for r in sorted(rects, key=lambda x: x[1][0] * x[1][1], reverse=True):
        area_r = r[1][0] * r[1][1]
        duplicate = False
        for k in kept:
            _, pts = cv2.rotatedRectangleIntersection(r, k)
            if pts is None:
                continue
            overlap = cv2.contourArea(cv2.convexHull(pts))
            area_k = k[1][0] * k[1][1]
            if overlap / max(min(area_r, area_k), 1) > overlap_frac:
                duplicate = True
                break
        if not duplicate:
            kept.append(r)
    return kept


def find_photos(img, params: DetectParams):
    """
    Locate every photo on a scan, as rotated rectangles in full-resolution coordinates.

    Detection runs on a downscaled copy — this is what makes a 143 MP scan tractable — and the
    rectangles are scaled back up at the end.

    Args:
        img: The full-resolution scan as a BGR array.
        params: Resolved tunables.

    Returns:
        list: Normalised ``minAreaRect`` tuples in source coordinates. Empty when nothing was
        found, which is a normal outcome and not an error.
    """
    h, w = img.shape[:2]
    scale = min(1.0, float(params.detect_size) / max(h, w))
    small = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1.0 else img
    sh, sw = small.shape[:2]
    page_area = sh * sw

    fg = foreground_mask(small, params)
    if fg is None:
        return []

    # Scanners leave a thin strip along the edge of the platen. Left in place it threads
    # unrelated photos into one contour spanning the whole scan.
    strip = max(3, int(round(0.012 * min(sh, sw))) | 1)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((strip, strip), np.uint8))

    rects = []
    for cnt in cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        if cv2.contourArea(cnt) < page_area * params.min_area * 0.4:
            continue
        x, y, bw, bh = cv2.boundingRect(cnt)
        x0, y0 = max(0, x - 8), max(0, y - 8)
        x1, y1 = min(sw, x + bw + 8), min(sh, y + bh + 8)
        blob = np.zeros((sh, sw), np.uint8)
        cv2.drawContours(blob, [cnt], -1, 255, cv2.FILLED)
        near = blob[y0:y1, x0:x1]
        vx, vy = border_maps(small[y0:y1, x0:x1], near)

        base = cv2.minAreaRect(cnt)[2]  # photos in one blob share an angle
        base = base + 90 if base < -45 else (base - 90 if base > 45 else base)
        for (cx, cy), size, angle in decompose(near, vx, vy, base, page_area, 0, params):
            rects.append(((cx + x0, cy + y0), size, angle))

    rects = [snap_to_border(small, r) for r in drop_fragments(rects, params.min_relative)]
    rects = dedupe(rects)
    return [
        normalise_rect(((cx / scale, cy / scale), (rw / scale, rh / scale), angle))
        for (cx, cy), (rw, rh), angle in rects
    ]
