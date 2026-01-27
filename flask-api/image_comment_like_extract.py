import io
import os
import re
import subprocess
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List, Optional, Tuple, Set

import cv2
import numpy as np
import pytesseract
from pytesseract import TesseractNotFoundError
from flask import Flask, jsonify, request
from flask_cors import CORS
from PIL import Image
from werkzeug.exceptions import HTTPException, ClientDisconnected

# Optional (if installed). If not, we fallback to Otsu.
try:
    from skimage.filters import threshold_sauvola
    HAS_SAUVOLA = True
except Exception:
    HAS_SAUVOLA = False

# ───────────────────────── Config ─────────────────────────
PORT = int(os.getenv("PORT1", 6000))
DEBUG = bool(int(os.getenv("DEBUG", "0")))

OCR_TIMEOUT_FAST = int(os.getenv("OCR_TIMEOUT_FAST", "6"))
OCR_TIMEOUT_FALLBACK = int(os.getenv("OCR_TIMEOUT_FALLBACK", "9"))
OCR_THREADS = max(1, int(os.getenv("OCR_THREADS", "3")))

MAX_SIDE = max(600, int(os.getenv("MAX_SIDE", "1400")))
SKIP_OCR_WHEN_UNLIKED = bool(int(os.getenv("SKIP_OCR_WHEN_UNLIKED", "1")))

DEFAULT_MIN_COMMENTS = int(os.getenv("MIN_COMMENTS", "2"))  # 0..2
DEFAULT_MIN_REPLIES = int(os.getenv("MIN_REPLIES", "2"))    # 0..2
DEFAULT_REQUIRE_LIKE = bool(int(os.getenv("REQUIRE_LIKE", "0")))

TESSERACT_CMD = os.getenv("TESSERACT_CMD")
if TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD

# Verify Tesseract at startup
TESSERACT_OK = True
TESSERACT_ERR = None
try:
    _ = pytesseract.get_tesseract_version()
except Exception as e:
    TESSERACT_OK = False
    TESSERACT_ERR = str(e)

# ───────────────────────── Flask ─────────────────────────
app = Flask(__name__)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB

# ─────────────── Like-icon constants ───────────────
ICON_X1, ICON_X2 = 0.05, 0.12
ICON_Y1, ICON_Y2 = 0.47, 0.55

DARK_THRESHOLD = 80
LIKE_FILLED_MIN = 0.06
LIKE_OUTLINE_MAX = 0.015

CENTER_BOX_START = 0.30
CENTER_BOX_END = 0.70
CENTER_DARK_MIN = 0.12

# ─────────────── OCR / parsing constants ───────────────
HANDLE_RE_INLINE = re.compile(r"@([A-Za-z0-9_\-.]{2,})")

STOP_PHRASES = (
    "add a reply", "add reply", "add a comment", "add comment",
    "replies", "reply", "share", "download", "remix", "read more"
)

NOISE_CONTAINS = (
    "comments", "replies", "topics", "newest", "pinned", "subscribe", "official website"
)

SINGLE_LETTER_RE = re.compile(r"\b[A-Za-z]\b")
ISOLATED_NUM_RE = re.compile(r"\b\d+\b")

# ───────────────────────── Helpers ─────────────────────────
def clamp_0_2(v, default: int) -> int:
    try:
        n = int(v)
    except Exception:
        n = default
    return max(0, min(2, n))

def normalize_handle(h: Optional[str]) -> Optional[str]:
    if not h:
        return None
    s = h.strip()
    if not s:
        return None
    if not s.startswith("@"):
        s = "@" + s
    return s.lower()

def downscale(img: Image.Image) -> Image.Image:
    w, h = img.size
    m = max(w, h)
    if m <= MAX_SIDE:
        return img.convert("RGB")
    scale = MAX_SIDE / float(m)
    new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
    out = img.convert("RGB")
    out.thumbnail(new_size, Image.BICUBIC)
    return out

def pil2gray(img: Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2GRAY)

def crop_panel_for_text(img: Image.Image) -> Image.Image:
    """
    Faster OCR: crop away top UI + side padding.
    Tweak if your screenshots differ.
    """
    img = downscale(img)
    w, h = img.size
    x1 = int(w * 0.03)
    x2 = int(w * 0.97)
    y1 = int(h * 0.12)
    y2 = int(h * 0.96)
    return img.crop((x1, y1, x2, y2))

def fast_binarize(gray: np.ndarray) -> np.ndarray:
    if HAS_SAUVOLA:
        try:
            thr = threshold_sauvola(gray, window_size=25)
            bw = (gray > thr).astype(np.uint8) * 255
            return bw
        except Exception:
            pass
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return bw

def preprocess_for_ocr(img: Image.Image) -> np.ndarray:
    # crop + downscale first (speed)
    img = crop_panel_for_text(img)

    gray = pil2gray(img)

    # upscale for tiny UI text
    gray = cv2.resize(gray, None, fx=1.6, fy=1.6, interpolation=cv2.INTER_CUBIC)

    # contrast boost
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    bw = fast_binarize(gray)

    # invert for dark theme
    if gray.mean() < 127:
        bw = 255 - bw

    bw = cv2.medianBlur(bw, 3)
    return bw

def ocr_lines_best(img: Image.Image, timeout_fast: int, timeout_fallback: int) -> List[str]:
    """
    Best-case + fast:
    - preprocess ONCE
    - try PSMs over same binarized image
    - fallback only if needed
    """
    bw = preprocess_for_ocr(img)

    def run_psm(psm: int, timeout_sec: int) -> List[str]:
        cfg = f"--oem 3 --psm {psm} -c preserve_interword_spaces=1"
        try:
            txt = pytesseract.image_to_string(bw, lang="eng", config=cfg, timeout=timeout_sec)
        except (RuntimeError, pytesseract.TesseractError, subprocess.TimeoutExpired, TesseractNotFoundError):
            txt = ""
        return [ln.strip() for ln in (txt or "").splitlines() if ln.strip()]

    # fast pass
    best = run_psm(6, timeout_fast)
    if len(best) >= 10:
        return best

    alt = run_psm(11, timeout_fast)
    if len(alt) > len(best):
        best = alt
    if len(best) >= 10:
        return best

    # fallback (only if still weak)
    alt2 = run_psm(4, timeout_fallback)
    if len(alt2) > len(best):
        best = alt2

    return best

def clean_text(text: str) -> str:
    text = ISOLATED_NUM_RE.sub("", text)
    text = SINGLE_LETTER_RE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text

def refine_text(text: str) -> str:
    text = re.sub(r"^[^\w']+|[^\w']+$", "", text)
    lower = text.lower()
    cut = len(text)
    for p in STOP_PHRASES:
        idx = lower.find(p)
        if 0 <= idx < cut:
            cut = idx
    text = text[:cut]
    text = re.sub(r"[^\w'\s]", "", text)
    toks = text.split()
    while toks and len(toks[-1]) <= 2:
        toks.pop()
    return " ".join(toks)

def dedupe_and_trim(arr: List[str], min_len: int = 3) -> List[str]:
    seen, out = set(), []
    for s in arr or []:
        t = (s or "").strip()
        if len(t) >= min_len and t not in seen:
            seen.add(t)
            out.append(t)
    return out

# ─────────────── Like Detection ───────────────
def detect_like(img: Image.Image) -> bool:
    img = downscale(img)
    w, h = img.size

    x1, x2 = int(w * ICON_X1), int(w * ICON_X2)
    y1, y2 = int(h * ICON_Y1), int(h * ICON_Y2)
    x2 = max(x2, x1 + 1)
    y2 = max(y2, y1 + 1)

    crop = img.crop((x1, y1, x2, y2))
    gray = pil2gray(crop)

    whole_dark = float((gray < DARK_THRESHOLD).sum()) / float(gray.size)
    if whole_dark >= LIKE_FILLED_MIN:
        return True
    if whole_dark <= LIKE_OUTLINE_MAX:
        return False

    width, height = (x2 - x1), (y2 - y1)
    cx1 = x1 + int(width * CENTER_BOX_START)
    cx2 = x1 + int(width * CENTER_BOX_END)
    cy1 = y1 + int(height * CENTER_BOX_START)
    cy2 = y1 + int(height * CENTER_BOX_END)

    center = img.crop((cx1, cy1, cx2, cy2))
    cgray = pil2gray(center)
    center_dark = float((cgray < DARK_THRESHOLD).sum()) / float(cgray.size)
    return center_dark >= CENTER_DARK_MIN

# ─────────────── Parsing ───────────────
def is_noise_line(line: str) -> bool:
    low = line.lower()
    if any(k in low for k in NOISE_CONTAINS):
        return True
    if "pinned by" in low:
        return True
    return False

def looks_like_author_line(line: str) -> bool:
    low = line.lower()
    if "pinned by" in low:
        return False
    return "ago" in low

def extract_blocks(lines: List[str]) -> List[Tuple[str, str]]:
    """
    Extract ALL (handle -> text) blocks from a panel.
    Also attempts to grab any text trailing on the same author line after ':'.
    """
    blocks: List[Tuple[str, str]] = []
    i, n = 0, len(lines)

    while i < n:
        line = lines[i].strip()
        if not line or is_noise_line(line):
            i += 1
            continue

        m = HANDLE_RE_INLINE.search(line)
        if m and looks_like_author_line(line):
            handle = normalize_handle(m.group(1))
            i += 1
            buf: List[str] = []

            # sometimes OCR puts comment after ":" on the same author line
            if ":" in line:
                tail = line.split(":", 1)[1].strip()
                if tail and not is_noise_line(tail) and not HANDLE_RE_INLINE.search(tail):
                    buf.append(tail)

            while i < n:
                ln = lines[i].strip()
                if not ln:
                    i += 1
                    continue
                if is_noise_line(ln):
                    break

                m2 = HANDLE_RE_INLINE.search(ln)
                if m2 and looks_like_author_line(ln):
                    break

                low = ln.lower()
                if any(p in low for p in STOP_PHRASES):
                    break

                buf.append(ln)
                i += 1

            raw = clean_text(" ".join(buf))
            if raw:
                blocks.append((handle, raw))
            continue

        i += 1

    return blocks

# ─────────────── Handle aliasing (fix OCR misreads) ───────────────
def levenshtein_bounded(a: str, b: str, max_dist: int) -> int:
    """
    Levenshtein with early-exit; returns > max_dist if exceeded.
    """
    if a == b:
        return 0
    if abs(len(a) - len(b)) > max_dist:
        return max_dist + 1

    # ensure b is shorter in DP width sometimes (optional)
    n, m = len(a), len(b)
    prev = list(range(m + 1))
    for i in range(1, n + 1):
        cur = [i] + [0] * m
        row_min = cur[0]
        ca = a[i - 1]
        for j in range(1, m + 1):
            cb = b[j - 1]
            cost = 0 if ca == cb else 1
            cur[j] = min(
                prev[j] + 1,      # delete
                cur[j - 1] + 1,   # insert
                prev[j - 1] + cost
            )
            row_min = min(row_min, cur[j])
        if row_min > max_dist:
            return max_dist + 1
        prev = cur
    return prev[m]

def handle_key(h: str) -> str:
    return (h or "").strip().lower().lstrip("@")

def is_similar_handle(h1: str, h2: str) -> bool:
    """
    Designed for your exact issue:
    gmilindchand vs gmiindchand vs gmibndchand etc.
    Tight enough to avoid random merges.
    """
    a = handle_key(h1)
    b = handle_key(h2)
    if not a or not b:
        return False
    if a == b:
        return True
    if len(a) < 6 or len(b) < 6:
        return False
    if a[:3] != b[:3]:
        return False
    if abs(len(a) - len(b)) > 2:
        return False

    dist = levenshtein_bounded(a, b, 2)
    if dist > 2:
        return False

    sim = 1.0 - (dist / float(max(len(a), len(b))))
    return sim >= 0.80

def build_alias_map(handles: Set[str], freq: Dict[str, int]) -> Tuple[Dict[str, str], List[Dict]]:
    """
    Cluster similar handles -> pick canonical (highest frequency).
    Returns alias_to_canonical and clusters for debug.
    """
    clusters: List[List[str]] = []

    for h in sorted(handles):
        placed = False
        for c in clusters:
            # compare with cluster representative
            if is_similar_handle(h, c[0]):
                c.append(h)
                placed = True
                break
        if not placed:
            clusters.append([h])

    alias_to_canon: Dict[str, str] = {}
    debug_clusters = []

    for members in clusters:
        # choose canonical = most frequent, then longer, then lex
        members_sorted = sorted(
            members,
            key=lambda x: (freq.get(x, 0), len(handle_key(x)), x),
            reverse=True
        )
        canon = members_sorted[0]
        for m in members:
            alias_to_canon[m] = canon
        debug_clusters.append({
            "canonical": canon,
            "members": members_sorted
        })

    return alias_to_canon, debug_clusters

def merge_map(mp: Dict[str, List[str]], alias_to_canon: Dict[str, str]) -> Dict[str, List[str]]:
    out = defaultdict(list)
    for h, texts in (mp or {}).items():
        canon = alias_to_canon.get(h, h)
        out[canon].extend(texts or [])
    return out

def pick_best_user(comment_map: Dict[str, List[str]], reply_map: Dict[str, List[str]], min_comments: int, min_replies: int) -> Optional[str]:
    ch = set(comment_map.keys())
    rh = set(reply_map.keys())

    if min_comments > 0 and min_replies > 0:
        candidates = ch & rh
    elif min_comments > 0:
        candidates = ch
    elif min_replies > 0:
        candidates = rh
    else:
        return None

    if not candidates:
        return None

    scored = []
    for h in candidates:
        c = len(comment_map.get(h, []))
        r = len(reply_map.get(h, []))
        meets = int(c >= min_comments and r >= min_replies)
        scored.append((meets, c + r, c, r, h))
    scored.sort(reverse=True)
    return scored[0][-1]

@app.route("/", methods=["GET"])
def health():
    return jsonify({
        "ok": True,
        "tesseract_ok": TESSERACT_OK,
        "defaults": {
            "min_comments": DEFAULT_MIN_COMMENTS,
            "min_replies": DEFAULT_MIN_REPLIES,
            "require_like": DEFAULT_REQUIRE_LIKE
        }
    }), 200

@app.route("/analyze", methods=["POST"])
def analyze():
    debug = bool(int(request.args.get("debug", "0"))) or DEBUG

    if not TESSERACT_OK:
        return jsonify({
            "error": "tesseract_missing",
            "message": "Tesseract OCR is not installed or not reachable. Install it or set TESSERACT_CMD.",
            "details": TESSERACT_ERR
        }), 503

    try:
        _ = request.files
    except ClientDisconnected:
        return jsonify({"error": "client_disconnected"}), 400

    # rules from query params
    min_comments = clamp_0_2(request.args.get("min_comments"), DEFAULT_MIN_COMMENTS)
    min_replies  = clamp_0_2(request.args.get("min_replies"), DEFAULT_MIN_REPLIES)
    require_like = bool(int(request.args.get("require_like", "1" if DEFAULT_REQUIRE_LIKE else "0")))

    rules = {
        "min_comments": min_comments,
        "min_replies": min_replies,
        "require_like": require_like
    }

    if min_comments == 0 and min_replies == 0:
        return jsonify({
            "error": "bad_request",
            "message": "Invalid rules: min_comments and min_replies cannot both be 0.",
            "rules": rules
        }), 400

    # required keys based on rules (like required only if require_like==1)
    required = []
    if require_like:
        required.append("like")
    if min_comments >= 1:
        required.append("comment1")
    if min_comments >= 2:
        required.append("comment2")
    if min_replies >= 1:
        required.append("reply1")
    if min_replies >= 2:
        required.append("reply2")

    missing = [k for k in required if k not in request.files]
    if missing:
        return jsonify({
            "error": "bad_request",
            "message": "Missing required images for given rules.",
            "required": required,
            "missing": missing,
            "rules": rules
        }), 400

    # Load images (also load optional "like" if present so you can still output liked)
    possible = ["like", "comment1", "comment2", "reply1", "reply2"]
    imgs: Dict[str, Image.Image] = {}
    for key in possible:
        if key in request.files:
            storage = request.files[key]
            storage.stream.seek(0)
            imgs[key] = Image.open(io.BytesIO(storage.read())).convert("RGB")

    # Like (if provided)
    liked_val: Optional[bool] = None
    if "like" in imgs:
        liked_val = detect_like(imgs["like"])

    # If like is required and failed, optionally skip OCR
    if require_like:
        liked = bool(liked_val)
        if not liked and SKIP_OCR_WHEN_UNLIKED:
            return jsonify({
                "liked": False,
                "user_id": None,
                "comment": None,
                "replies": None,
                "verified": False,
                "rules": rules,
                "message": "Like verification failed; skipping OCR."
            }), 200
    else:
        liked = bool(liked_val) if liked_val is not None else True  # for display only; verification ignores

    # OCR panels: only the ones required (fast)
    panel_keys = [k for k in required if k != "like"]
    ocr_lines_map: Dict[str, List[str]] = {k: [] for k in panel_keys}

    with ThreadPoolExecutor(max_workers=min(OCR_THREADS, max(1, len(panel_keys)))) as ex:
        futs = {
            ex.submit(ocr_lines_best, imgs[k], OCR_TIMEOUT_FAST, OCR_TIMEOUT_FALLBACK): k
            for k in panel_keys
        }
        for fut in as_completed(futs):
            k = futs[fut]
            try:
                ocr_lines_map[k] = fut.result() or []
            except Exception:
                ocr_lines_map[k] = []

    # Build handle->texts maps
    comment_map: Dict[str, List[str]] = defaultdict(list)
    reply_map: Dict[str, List[str]] = defaultdict(list)

    for k in ["comment1", "comment2"]:
        if k in ocr_lines_map:
            for h, t in extract_blocks(ocr_lines_map.get(k, [])):
                comment_map[h].append(t)

    for k in ["reply1", "reply2"]:
        if k in ocr_lines_map:
            for h, t in extract_blocks(ocr_lines_map.get(k, [])):
                reply_map[h].append(t)

    # clean/refine/dedupe per raw handle
    for h in list(comment_map.keys()):
        refined = [refine_text(clean_text(x)) for x in comment_map[h]]
        comment_map[h] = dedupe_and_trim(refined)

    for h in list(reply_map.keys()):
        refined = [refine_text(clean_text(x)) for x in reply_map[h]]
        reply_map[h] = dedupe_and_trim(refined)

    # ---- FIX: merge OCR-misread handles across panels ----
    freq = defaultdict(int)
    for h, v in comment_map.items():
        freq[h] += len(v)
    for h, v in reply_map.items():
        freq[h] += len(v)

    all_handles = set(comment_map.keys()) | set(reply_map.keys())
    alias_to_canon, handle_clusters = build_alias_map(all_handles, freq)

    comment_map = merge_map(comment_map, alias_to_canon)
    reply_map = merge_map(reply_map, alias_to_canon)

    # dedupe again after merge
    for h in list(comment_map.keys()):
        comment_map[h] = dedupe_and_trim(comment_map[h])
    for h in list(reply_map.keys()):
        reply_map[h] = dedupe_and_trim(reply_map[h])

    # pick best user after merge
    uid_pick = pick_best_user(comment_map, reply_map, min_comments, min_replies)
    user_id = normalize_handle(uid_pick)

    comments = (comment_map.get(uid_pick) or [])
    replies = (reply_map.get(uid_pick) or [])

    out_comments = comments[:min_comments] if min_comments > 0 else []
    out_replies  = replies[:min_replies] if min_replies > 0 else []

    has_handle = bool(user_id and user_id.strip())
    meets_counts = (len(out_comments) >= min_comments) and (len(out_replies) >= min_replies)
    meets_like = (bool(liked_val) if liked_val is not None else False) if require_like else True

    verified = bool(has_handle and meets_counts and meets_like)

    payload = {
        "liked": bool(liked_val) if liked_val is not None else liked,  # keep boolean for node side
        "user_id": user_id,
        "comment": out_comments if out_comments else None,
        "replies": out_replies if out_replies else None,
        "verified": verified,
        "rules": rules
    }

    if not verified:
        payload["message"] = "Verification failed. Upload clearer screenshots where @handle + 'ago' + texts are visible."

    if debug:
        payload["debug"] = {
            "required": required,
            "panel_keys": panel_keys,
            "chosen_handle": uid_pick,
            "comment_handles": list(comment_map.keys()),
            "reply_handles": list(reply_map.keys()),
            "handle_clusters": handle_clusters,
            "counts": {
                "comments": {h: len(comment_map[h]) for h in comment_map},
                "replies": {h: len(reply_map[h]) for h in reply_map}
            },
            "ocr_lines": {k: (ocr_lines_map.get(k, [])[:160]) for k in panel_keys}
        }

    return jsonify(payload), 200

@app.errorhandler(ClientDisconnected)
def handle_client_disconnected(_e):
    return jsonify({"error": "client_disconnected"}), 400

@app.errorhandler(Exception)
def handle_exception(e):
    code = e.code if isinstance(e, HTTPException) else 500
    app.logger.exception("Unhandled exception")
    return jsonify({
        "error": "internal_server_error" if code == 500 else "http_error",
        "status": code
    }), code

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=DEBUG)
