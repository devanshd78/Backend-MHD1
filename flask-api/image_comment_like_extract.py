import io
import os
import re
import subprocess
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
import pytesseract
from pytesseract import TesseractNotFoundError
from flask import Flask, jsonify, request
from flask_cors import CORS
from PIL import Image
from skimage.filters import threshold_sauvola
from werkzeug.exceptions import HTTPException

# ───────────────────────── Config ─────────────────────────
PORT = int(os.getenv("PORT1", 6000))
DEBUG = bool(int(os.getenv("DEBUG", "0")))
OCR_TIMEOUT = int(os.getenv("OCR_TIMEOUT", "12"))
OCR_THREADS = max(1, int(os.getenv("OCR_THREADS", "3")))
MAX_SIDE = max(600, int(os.getenv("MAX_SIDE", "1400")))
SKIP_OCR_WHEN_UNLIKED = bool(int(os.getenv("SKIP_OCR_WHEN_UNLIKED", "1")))
TESSERACT_CMD = os.getenv("TESSERACT_CMD")

if TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD

# Verify Tesseract at startup (no silent failures)
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
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB total

# ─────────────── Like-icon constants (wide crop) ───────────────
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

def normalize_handle(h: Optional[str]) -> Optional[str]:
    if not h:
        return None
    h = h.strip()
    if not h.startswith("@"):
        h = "@" + h
    return h.lower()

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

def fast_binarize(gray: np.ndarray) -> np.ndarray:
    try:
        thr = threshold_sauvola(gray, window_size=25)
        bw = (gray > thr).astype(np.uint8) * 255
    except Exception:
        _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return bw

def preprocess_for_ocr(img: Image.Image) -> np.ndarray:
    img = downscale(img)
    gray = pil2gray(img)

    # upscale for tiny UI text
    gray = cv2.resize(gray, None, fx=1.6, fy=1.6, interpolation=cv2.INTER_CUBIC)

    # contrast boost
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    bw = fast_binarize(gray)

    # invert for dark theme UIs (very important)
    if gray.mean() < 127:
        bw = 255 - bw

    bw = cv2.medianBlur(bw, 3)
    return bw

def ocr_lines_best(img: Image.Image, timeout_sec: int = OCR_TIMEOUT) -> List[str]:
    configs = [
        "--oem 3 --psm 6 -c preserve_interword_spaces=1",
        "--oem 3 --psm 11 -c preserve_interword_spaces=1",
        "--oem 3 --psm 4 -c preserve_interword_spaces=1",
    ]
    best: List[str] = []
    for cfg in configs:
        try:
            bw = preprocess_for_ocr(img)
            txt = pytesseract.image_to_string(bw, lang="eng", config=cfg, timeout=timeout_sec)
        except (RuntimeError, pytesseract.TesseractError, subprocess.TimeoutExpired, TesseractNotFoundError):
            txt = ""
        lines = [ln.strip() for ln in (txt or "").splitlines() if ln.strip()]
        if len(lines) > len(best):
            best = lines
        if len(best) >= 10:
            break
    return best

def clean_text(text: str) -> str:
    text = ISOLATED_NUM_RE.sub("", text)
    text = SINGLE_LETTER_RE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text

def refine_text(text: str) -> str:
    # remove junk punctuation, keep words/spaces
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

def is_noise_line(line: str) -> bool:
    low = line.lower()
    if any(k in low for k in NOISE_CONTAINS):
        return True
    if "pinned by" in low:
        return True
    return False

def looks_like_author_line(line: str) -> bool:
    """
    Real author lines in YouTube comments/replies almost always include 'ago'.
    This also avoids false matches like '@mhd_tech... Read more' or 'Pinned by @...'
    """
    low = line.lower()
    if "pinned by" in low:
        return False
    return "ago" in low  # strict & reliable for this UI

def extract_blocks(lines: List[str]) -> List[Tuple[str, str]]:
    """
    Extract ALL (handle -> text) blocks from a panel.
    Each time we see an author handle line (contains 'ago'), we collect following text lines
    until next author handle line or noise/stop.
    """
    blocks: List[Tuple[str, str]] = []
    i = 0
    n = len(lines)

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

def pick_best_user(comment_map: Dict[str, List[str]], reply_map: Dict[str, List[str]]) -> Optional[str]:
    common = set(comment_map.keys()) & set(reply_map.keys())
    if not common:
        return None

    # prefer user that satisfies >=2 comments and >=2 replies, else highest totals
    scored = []
    for h in common:
        c = len(comment_map.get(h, []))
        r = len(reply_map.get(h, []))
        meets = int(c >= 2 and r >= 2)
        scored.append((meets, c + r, c, r, h))
    scored.sort(reverse=True)
    return scored[0][-1]

@app.route("/", methods=["GET"])
def health():
    return jsonify({"ok": True, "tesseract_ok": TESSERACT_OK}), 200

@app.route("/analyze", methods=["POST"])
def analyze():
    debug = bool(int(request.args.get("debug", "0"))) or DEBUG

    if not TESSERACT_OK:
        return jsonify({
            "error": "tesseract_missing",
            "message": "Tesseract OCR is not installed or not reachable. Install it or set TESSERACT_CMD.",
            "details": TESSERACT_ERR
        }), 503

    expected = ["like", "comment1", "comment2", "reply1", "reply2"]
    missing = [k for k in expected if k not in request.files]
    if missing or len(request.files) != 5:
        return jsonify({
            "error": "bad_request",
            "message": "Upload exactly 5 images with keys: like, comment1, comment2, reply1, reply2",
            "missing": missing
        }), 400

    imgs: Dict[str, Image.Image] = {}
    for key in expected:
        storage = request.files[key]
        storage.stream.seek(0)
        imgs[key] = Image.open(io.BytesIO(storage.read())).convert("RGB")

    liked = detect_like(imgs["like"])

    if not liked and SKIP_OCR_WHEN_UNLIKED:
        payload = {
            "liked": False,
            "user_id": None,
            "comment": None,
            "replies": None,
            "verified": False,
            "message": "Post not liked; skipping OCR."
        }
        return jsonify(payload), 200

    panel_keys = ["comment1", "comment2", "reply1", "reply2"]
    ocr_lines_map: Dict[str, List[str]] = {k: [] for k in panel_keys}

    with ThreadPoolExecutor(max_workers=OCR_THREADS) as ex:
        futs = {ex.submit(ocr_lines_best, imgs[k], OCR_TIMEOUT): k for k in panel_keys}
        for fut in as_completed(futs):
            k = futs[fut]
            try:
                ocr_lines_map[k] = fut.result() or []
            except Exception:
                ocr_lines_map[k] = []

    # Build handle -> texts maps (multi-block)
    comment_map: Dict[str, List[str]] = defaultdict(list)
    reply_map: Dict[str, List[str]] = defaultdict(list)

    for k in ["comment1", "comment2"]:
        blocks = extract_blocks(ocr_lines_map.get(k, []))
        for h, t in blocks:
            comment_map[h].append(t)

    for k in ["reply1", "reply2"]:
        blocks = extract_blocks(ocr_lines_map.get(k, []))
        for h, t in blocks:
            reply_map[h].append(t)

    # clean/refine/dedupe per user
    for h in list(comment_map.keys()):
        refined = [refine_text(clean_text(x)) for x in comment_map[h]]
        comment_map[h] = dedupe_and_trim(refined)

    for h in list(reply_map.keys()):
        refined = [refine_text(clean_text(x)) for x in reply_map[h]]
        reply_map[h] = dedupe_and_trim(refined)

    uid_pick = pick_best_user(comment_map, reply_map)
    user_id = normalize_handle(uid_pick)

    comments = (comment_map.get(uid_pick) or [])[:2]
    replies = (reply_map.get(uid_pick) or [])[:2]

    verified = bool(liked and user_id and len(comments) >= 2 and len(replies) >= 2)

    payload = {
        "liked": liked,
        "user_id": user_id,
        "comment": comments if comments else None,
        "replies": replies if replies else None,
        "verified": verified
    }

    if not verified:
        payload["message"] = "Verification failed. Upload clearer screenshots where @handle + texts are visible."

    if debug:
        payload["debug"] = {
            "comment_handles": list(comment_map.keys()),
            "reply_handles": list(reply_map.keys()),
            "chosen_handle": uid_pick,
            "counts": {
                "comments": {h: len(comment_map[h]) for h in comment_map},
                "replies": {h: len(reply_map[h]) for h in reply_map}
            },
            "ocr_lines": {k: (ocr_lines_map.get(k, [])[:160]) for k in panel_keys}
        }

    return jsonify(payload), 200

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
