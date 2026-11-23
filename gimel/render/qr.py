"""Reiner Python-QR-Code-Generator (ISO/IEC 18004, Byte-Modus, ECC Level M, Version 1–10).

Erzeugt echte, von jeder Handy-/Tablet-Kamera lesbare QR-Codes als kompaktes SVG,
ohne zusätzliche Python-Abhängigkeiten. Reicht bis 213 UTF-8-Bytes (Version 10-M) —
mehr als genug für vollständige Laufkarten-URLs.
"""

from __future__ import annotations

import html

# (version): (total_codewords, ec_per_block, blocks_g1, data_g1, blocks_g2, data_g2, alignment_centers)
# Werte nach ISO/IEC 18004 Tabelle 9 (Error Correction Level M) und Anhang E.
_VERSIONS_M: dict[int, tuple[int, int, int, int, int, int, tuple[int, ...]]] = {
    1:  (26,  10, 1, 16, 0, 0,  ()),
    2:  (44,  16, 1, 28, 0, 0,  (6, 18)),
    3:  (70,  26, 1, 44, 0, 0,  (6, 22)),
    4:  (100, 18, 2, 32, 0, 0,  (6, 26)),
    5:  (134, 24, 2, 43, 0, 0,  (6, 30)),
    6:  (172, 16, 4, 27, 0, 0,  (6, 34)),
    7:  (196, 18, 4, 31, 0, 0,  (6, 22, 38)),
    8:  (242, 22, 2, 38, 2, 39, (6, 24, 42)),
    9:  (292, 22, 3, 36, 2, 37, (6, 26, 46)),
    10: (346, 26, 4, 43, 1, 44, (6, 28, 50)),
}

# Version-Information (18 Bit, BCH(18,6)) für Versionen 7–10 (ISO/IEC 18004 Anhang D).
_VERSION_BITS: dict[int, int] = {
    7:  0x07C94,
    8:  0x085BC,
    9:  0x09A99,
    10: 0x0A4D3,
}

# Format-Information (15 Bit) für ECC Level M (Format-Bits 00) und Maske 0..7,
# bereits mit 0x5412 maskiert (ISO/IEC 18004 Anhang C).
_FORMAT_BITS_M: tuple[int, ...] = (
    0x5412,
    0x5125,
    0x5E7C,
    0x5B4B,
    0x45F9,
    0x40CE,
    0x4F97,
    0x4AA0,
)

# GF(256) Tabellen mit Primitivpolynom 0x11D.
_GF_EXP = [0] * 512
_GF_LOG = [0] * 256
_x = 1
for _i in range(255):
    _GF_EXP[_i] = _x
    _GF_LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _GF_EXP[_i] = _GF_EXP[_i - 255]


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _GF_EXP[_GF_LOG[a] + _GF_LOG[b]]


def _rs_generator(degree: int) -> list[int]:
    poly = [1]
    for i in range(degree):
        root = _GF_EXP[i]
        nxt = [0] * (len(poly) + 1)
        for j, coef in enumerate(poly):
            nxt[j] ^= coef
            nxt[j + 1] ^= _gf_mul(coef, root)
        poly = nxt
    return poly


def _rs_remainder(data: list[int], ec_len: int) -> list[int]:
    gen = _rs_generator(ec_len)
    rem = list(data) + [0] * ec_len
    for i in range(len(data)):
        factor = rem[i]
        if factor != 0:
            for j in range(1, len(gen)):
                rem[i + j] ^= _gf_mul(gen[j], factor)
    return rem[len(data):]


def _choose_version(byte_len: int) -> int:
    for v, (_, _, b1, d1, b2, d2, _) in _VERSIONS_M.items():
        data_cap = b1 * d1 + b2 * d2
        # Mode (4 Bit) + Char-Count (8 Bit für V1–9, 16 Bit für V10) + Daten.
        count_bits = 8 if v <= 9 else 16
        needed_bits = 4 + count_bits + byte_len * 8
        if needed_bits <= data_cap * 8:
            return v
    raise ValueError(f"QR-Inhalt zu lang ({byte_len} Bytes, max. 213 Bytes)")


def _encode_codewords(payload: bytes, version: int) -> list[int]:
    _, ec_len, b1, d1, b2, d2, _ = _VERSIONS_M[version]
    data_cap = b1 * d1 + b2 * d2
    bits: list[int] = []

    def push(val: int, width: int) -> None:
        for shift in range(width - 1, -1, -1):
            bits.append((val >> shift) & 1)

    push(0b0100, 4)  # Byte-Modus
    push(len(payload), 8 if version <= 9 else 16)
    for byte in payload:
        push(byte, 8)

    cap_bits = data_cap * 8
    term = min(4, cap_bits - len(bits))
    bits.extend([0] * term)
    while len(bits) % 8 != 0:
        bits.append(0)

    data_bytes = [
        int("".join(str(b) for b in bits[i:i + 8]), 2)
        for i in range(0, len(bits), 8)
    ]
    pad = (0xEC, 0x11)
    pidx = 0
    while len(data_bytes) < data_cap:
        data_bytes.append(pad[pidx & 1])
        pidx += 1

    # Blöcke aufteilen, ECC berechnen, Codewörter verschachteln.
    data_blocks: list[list[int]] = []
    ec_blocks: list[list[int]] = []
    offset = 0
    for count, size in ((b1, d1), (b2, d2)):
        for _ in range(count):
            blk = data_bytes[offset:offset + size]
            offset += size
            data_blocks.append(blk)
            ec_blocks.append(_rs_remainder(blk, ec_len))

    interleaved: list[int] = []
    max_d = max(len(b) for b in data_blocks)
    for i in range(max_d):
        for blk in data_blocks:
            if i < len(blk):
                interleaved.append(blk[i])
    for i in range(ec_len):
        for blk in ec_blocks:
            interleaved.append(blk[i])
    return interleaved


def _build_base_matrix(version: int) -> tuple[list[list[int]], list[list[bool]]]:
    n = 17 + 4 * version
    grid = [[0] * n for _ in range(n)]
    func = [[False] * n for _ in range(n)]

    def set_func(r: int, c: int, val: int) -> None:
        if 0 <= r < n and 0 <= c < n:
            grid[r][c] = val
            func[r][c] = True

    # Finder-Muster + 1-Modul-Trennrahmen
    for fr, fc in ((0, 0), (0, n - 7), (n - 7, 0)):
        for dr in range(-1, 8):
            for dc in range(-1, 8):
                r, c = fr + dr, fc + dc
                if not (0 <= r < n and 0 <= c < n):
                    continue
                if dr in (-1, 7) or dc in (-1, 7):
                    set_func(r, c, 0)
                elif dr in (0, 6) or dc in (0, 6) or (2 <= dr <= 4 and 2 <= dc <= 4):
                    set_func(r, c, 1)
                else:
                    set_func(r, c, 0)

    # Timing-Linien
    for i in range(8, n - 8):
        bit = 1 if i % 2 == 0 else 0
        if not func[6][i]:
            set_func(6, i, bit)
        if not func[i][6]:
            set_func(i, 6, bit)

    # Alignment-Muster
    centers = _VERSIONS_M[version][6]
    for ar in centers:
        for ac in centers:
            if func[ar][ac]:
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    val = 1 if max(abs(dr), abs(dc)) in (0, 2) else 0
                    set_func(ar + dr, ac + dc, val)

    # Dark Module + reservierte Format-Bereiche
    set_func(n - 8, 8, 1)
    for i in range(9):
        if i != 6:
            func[8][i] = True
            func[i][8] = True
    for i in range(8):
        func[8][n - 1 - i] = True
        func[n - 1 - i][8] = True

    # Version-Info für Version 7+
    if version in _VERSION_BITS:
        vbits = _VERSION_BITS[version]
        for i in range(18):
            bit = (vbits >> i) & 1
            r = i // 3
            c = n - 11 + (i % 3)
            set_func(r, c, bit)
            set_func(c, r, bit)

    return grid, func


def _place_data(grid: list[list[int]], func: list[list[bool]], codewords: list[int]) -> None:
    n = len(grid)
    bits: list[int] = []
    for cw in codewords:
        for shift in range(7, -1, -1):
            bits.append((cw >> shift) & 1)

    bidx = 0
    up = True
    col = n - 1
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(n - 1, -1, -1) if up else range(n)
        for row in rows:
            for dc in (0, -1):
                c = col + dc
                if not func[row][c]:
                    grid[row][c] = bits[bidx] if bidx < len(bits) else 0
                    bidx += 1
        up = not up
        col -= 2


def _mask_bit(mask: int, r: int, c: int) -> bool:
    if mask == 0:
        return (r + c) % 2 == 0
    if mask == 1:
        return r % 2 == 0
    if mask == 2:
        return c % 3 == 0
    if mask == 3:
        return (r + c) % 3 == 0
    if mask == 4:
        return ((r // 2) + (c // 3)) % 2 == 0
    if mask == 5:
        return ((r * c) % 2) + ((r * c) % 3) == 0
    if mask == 6:
        return (((r * c) % 2) + ((r * c) % 3)) % 2 == 0
    return (((r + c) % 2) + ((r * c) % 3)) % 2 == 0


def _write_format(grid: list[list[int]], mask: int) -> None:
    n = len(grid)
    fmt = _FORMAT_BITS_M[mask]
    # Bits 14 (MSB) .. 0 (LSB)
    bits = [(fmt >> i) & 1 for i in range(15)]

    # Kopie 1 (um links oben)
    coords1 = [
        (8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8),
        (7, 8), (5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8),
    ]
    for i, (r, c) in enumerate(coords1):
        grid[r][c] = bits[14 - i]

    # Kopie 2 (links unten + rechts oben)
    coords2 = [
        (n - 1, 8), (n - 2, 8), (n - 3, 8), (n - 4, 8), (n - 5, 8), (n - 6, 8), (n - 7, 8),
        (8, n - 8), (8, n - 7), (8, n - 6), (8, n - 5), (8, n - 4), (8, n - 3), (8, n - 2), (8, n - 1),
    ]
    for i, (r, c) in enumerate(coords2):
        grid[r][c] = bits[14 - i]


def _penalty(grid: list[list[int]]) -> int:
    n = len(grid)
    score = 0
    # Regel 1: Läufe gleicher Farbe >= 5
    for r in range(n):
        run_c = grid[r][0]
        run_l = 1
        for c in range(1, n):
            if grid[r][c] == run_c:
                run_l += 1
            else:
                if run_l >= 5:
                    score += 3 + (run_l - 5)
                run_c = grid[r][c]
                run_l = 1
        if run_l >= 5:
            score += 3 + (run_l - 5)
    for c in range(n):
        run_c = grid[0][c]
        run_l = 1
        for r in range(1, n):
            if grid[r][c] == run_c:
                run_l += 1
            else:
                if run_l >= 5:
                    score += 3 + (run_l - 5)
                run_c = grid[r][c]
                run_l = 1
        if run_l >= 5:
            score += 3 + (run_l - 5)
    # Regel 2: 2x2 Blöcke
    for r in range(n - 1):
        for c in range(n - 1):
            v = grid[r][c]
            if v == grid[r][c + 1] == grid[r + 1][c] == grid[r + 1][c + 1]:
                score += 3
    # Regel 4: Verhältnis schwarz/weiß
    dark = sum(sum(row) for row in grid)
    pct = (dark * 100) / (n * n)
    score += int(abs(pct - 50) // 5) * 10
    return score


def encode_qr(text: str) -> list[list[int]]:
    """Erzeugt die QR-Matrix (0 = weiß, 1 = dunkel) für ``text``."""
    payload = text.encode("utf-8")
    version = _choose_version(len(payload))
    codewords = _encode_codewords(payload, version)
    base, func = _build_base_matrix(version)
    _place_data(base, func, codewords)

    best_grid: list[list[int]] | None = None
    best_score = 10**9
    n = len(base)
    for mask in range(8):
        cand = [row[:] for row in base]
        for r in range(n):
            for c in range(n):
                if not func[r][c] and _mask_bit(mask, r, c):
                    cand[r][c] ^= 1
        _write_format(cand, mask)
        sc = _penalty(cand)
        if sc < best_score:
            best_score = sc
            best_grid = cand
    assert best_grid is not None
    return best_grid


def qr_svg(
    text: str,
    *,
    size: int = 96,
    quiet: int = 2,
    ink: str = "#111827",
    bg: str = "#ffffff",
    label: str = "",
) -> str:
    """Rendert einen echten, scanbaren QR-Code als kompaktes SVG (ein <path>)."""
    matrix = encode_qr(text)
    n = len(matrix)
    total = n + quiet * 2
    parts: list[str] = []
    for r, row in enumerate(matrix):
        c = 0
        while c < n:
            if row[c]:
                start = c
                while c < n and row[c]:
                    c += 1
                width = c - start
                parts.append(f"M{start + quiet},{r + quiet}h{width}v1h-{width}z")
            else:
                c += 1
    d = "".join(parts)
    aria = html.escape(label or f"QR-Code {text}", quote=True)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {total} {total}" shape-rendering="crispEdges" role="img" aria-label="{aria}">'
        f'<rect width="{total}" height="{total}" fill="{bg}"/>'
        f'<path d="{d}" fill="{ink}"/>'
        f"</svg>"
    )
