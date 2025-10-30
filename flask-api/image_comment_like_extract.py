"""
Flask micro-service (YouTube Shorts screenshot analyser)

Env knobs (optional):
- PORT1=6000
- DEBUG=0|1
- OCR_TIMEOUT=10           # seconds per Tesseract call
- OCR_THREADS=3            # concurrent OCR workers
- MAX_SIDE=1100            # downscale longest side before OCR
- SKIP_OCR_WHEN_UNLIKED=1  # if like not filled, skip OCR panels
- TESSERACT_CMD=/usr/bin/tesseract  # custom tesseract path

Returns JSON:
{
  "liked": true | false,                 # never null
  "user_id": "@handle" | null,           # handle present in both layers (normalized lowercase)
  "comment": ["…", "…"] | null,          # *clean* top-level comments by that handle (deduped)
  "replies": ["…", "…"] | null,          # *clean* replies by same handle (deduped)
  "verified": true | false,              # true if liked and ≥2 DISTINCT comments & ≥2 DISTINCT replies
  "message": "..."                        # optional hint when not verified
}
"""

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
from flask import Flask, jsonify, request
from flask_cors import CORS
from PIL import Image
from skimage.filters import threshold_sauvola
from werkzeug.exceptions import HTTPException

# ───────────────────────── Config ─────────────────────────
PORT = int(os.getenv("PORT1", 6000))
DEBUG = bool(int(os.getenv("DEBUG", "0")))
OCR_TIMEOUT = int(os.getenv("OCR_TIMEOUT", "10"))
OCR_THREADS = max(1, int(os.getenv("OCR_THREADS", "3")))
MAX_SIDE = max(400, int(os.getenv("MAX_SIDE", "1100")))
SKIP_OCR_WHEN_UNLIKED = bool(int(os.getenv("SKIP_OCR_WHEN_UNLIKED", "1")))
TESSERACT_CMD = os.getenv("TESSERACT_CMD")
if TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD

# ───────────────────────── Flask ─────────────────────────
app = Flask(__name__)
CORS(app)  # allow cross-origin requests
# Prevent giant uploads (each screenshot is small; 10 MB is ample)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024  # 10 MB

# ─────────────── Like-icon constants (use WIDE crop) ───────────────
ICON_X1, ICON_X2 = 0.05, 0.12
ICON_Y1, ICON_Y2 = 0.47, 0.55

# Darkness logic
DARK_THRESHOLD    = 80
LIKE_FILLED_MIN   = 0.06   # whole-crop dark ratio → definitely liked (more conservative)
LIKE_OUTLINE_MAX  = 0.015  # whole-crop dark ratio → definitely unliked

# Center test
CENTER_BOX_START  = 0.30
CENTER_BOX_END    = 0.70
CENTER_DARK_MIN   = 0.12

# ─────────────── Comment / reply constants ───────────────
HANDLE_RE_INLINE = re.compile(r"@([A-Za-z0-9_\-.]{2,})")
UNICODE_JUNK     = "•·●○▶►«»▪–—|>_"
STOP_PHRASES     = (
    'adda reply', 'add a reply', 'add reply', 'add a comment', 'adda comment',
    'add comment', 'add a reply…', 'replies', 'reply', 'share', 'download', 'remix'
)
SINGLE_LETTER_RE = re.compile(r"\b[A-Za-z]\b")
ISOLATED_NUM_RE  = re.compile(r"\b\d+\b")

# ─────────────────────── Helpers ───────────────────────
def normalize_handle(h: Optional[str]) -> Optional[str]:
    if not h:
        return None
    h = h.strip()
    if not h.startswith('@'):
        h = '@' + h
    return h.lower()

def pil2gray(img: Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2GRAY)

def fast_binarize(gray: np.ndarray) -> np.ndarray:
    # Sauvola adapts better to mobile UI backgrounds than Otsu; fallback to Otsu if needed
    try:
        thr = threshold_sauvola(gray, window_size=25)
        bw = (gray > thr).astype(np.uint8) * 255
    except Exception:
        _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return bw

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

def ocr_lines(img: Image.Image, timeout_sec: int = OCR_TIMEOUT) -> List[str]:
    """
    OCR a panel safely. Any error or timeout → empty list (non-fatal).
    """
    try:
        gray = pil2gray(downscale(img))
        bw = fast_binarize(gray)
        txt = pytesseract.image_to_string(
            bw, lang='eng', config='--oem 3 --psm 6', timeout=timeout_sec
        )
        return [ln.strip() for ln in txt.splitlines() if ln.strip()]
    except (RuntimeError, pytesseract.TesseractError, subprocess.TimeoutExpired):
        return []
    except Exception:
        # absolutely never let OCR kill the request
        return []

def clean_token(tok: str) -> str:
    return tok.strip(UNICODE_JUNK + " \t\n.:,;()[]{}")

def clean_text(text: str) -> str:
    text = ISOLATED_NUM_RE.sub('', text)
    text = SINGLE_LETTER_RE.sub('', text)
    return re.sub(r"\s+", ' ', text).strip()

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
        t = s.strip()
        if len(t) >= min_len and t not in seen:
            seen.add(t)
            out.append(t)
    return out

def join_handle(line_idx: int, lines: List[str]) -> Tuple[Optional[str], int]:
    line = lines[line_idx]
    m = HANDLE_RE_INLINE.search(line)
    if m:
        return f"@{clean_token(m.group(1))}", line_idx
    if line.strip() == '@':
        i = line_idx + 1
        while i < len(lines) and not lines[i].strip():
            i += 1
        if i < len(lines):
            nxt = clean_token(lines[i].split()[0])
            if nxt:
                return f"@{nxt}", i
    return None, line_idx

def extract_user_texts(lines: List[str]) -> Dict[str, List[str]]:
    by_user: Dict[str, List[str]] = defaultdict(list)
    i, n = 0, len(lines)
    while i < n:
        handle, new_idx = join_handle(i, lines)
        if handle:
            buf = []
            i = new_idx + 1
            while i < n:
                low = lines[i].lower().strip()
                if HANDLE_RE_INLINE.search(lines[i]) or low == '@':
                    break
                if any(low.startswith(p) for p in STOP_PHRASES):
                    break
                buf.append(lines[i])
                i += 1
            raw = ' '.join(buf).strip()
            cleaned = clean_text(raw)
            if cleaned:
                by_user[handle].append(cleaned)
        else:
            i += 1
    return by_user

def pick_user(comments: Dict[str, List[str]], replies: Dict[str, List[str]]) -> Optional[str]:
    for uid in comments:
        if uid in replies:
            return uid
    return None

# ─────────────── Like Detection (robust: no OCR fallback) ───────────────
def detect_like(img: Image.Image) -> bool:
    img = downscale(img)
    w, h = img.size

    # 1) wide crop around like icon
    x1, x2 = int(w * ICON_X1), int(w * ICON_X2)
    y1, y2 = int(h * ICON_Y1), int(h * ICON_Y2)
    x2 = max(x2, x1 + 1); y2 = max(y2, y1 + 1)

    crop = img.crop((x1, y1, x2, y2))
    gray = pil2gray(crop)

    # whole-crop quick check
    whole_dark = float((gray < DARK_THRESHOLD).sum()) / float(gray.size)
    if whole_dark >= LIKE_FILLED_MIN:
        return True
    if whole_dark <= LIKE_OUTLINE_MAX:
        return False

    # 2) center-darkness (robust liked vs outline)
    width, height = (x2 - x1), (y2 - y1)
    cx1 = x1 + int(width  * CENTER_BOX_START)
    cx2 = x1 + int(width  * CENTER_BOX_END)
    cy1 = y1 + int(height * CENTER_BOX_START)
    cy2 = y1 + int(height * CENTER_BOX_END)

    center = img.crop((cx1, cy1, cx2, cy2))
    cgray = pil2gray(center)
    center_dark = float((cgray < DARK_THRESHOLD).sum()) / float(cgray.size)

    return center_dark >= CENTER_DARK_MIN

# ─────────────────────── Routes ───────────────────────
@app.route("/", methods=["GET"])
def health():
    return jsonify({"ok": True}), 200

@app.route("/analyze", methods=["POST"])
def analyze():
    # Expect exactly 5 files named like, comment1, comment2, reply1, reply2
    expected = ["like", "comment1", "comment2", "reply1", "reply2"]
    missing = [k for k in expected if k not in request.files]
    if missing or len(request.files) != 5:
        return jsonify({
            "error": "bad_request",
            "message": "Upload exactly 5 images with keys: like, comment1, comment2, reply1, reply2"
        }), 400

    # Open images safely in provided key order
    imgs: Dict[str, Image.Image] = {}
    for key in expected:
        storage = request.files[key]
        storage.stream.seek(0)
        imgs[key] = Image.open(io.BytesIO(storage.read())).convert("RGB")

    # 1) Like detection (fast path)
    liked = detect_like(imgs["like"])

    # Early exit path: if unliked and configured to skip OCR
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

    # 2) OCR in parallel for comments/replies
    panels = [
        ("comment", imgs["comment1"]),
        ("comment", imgs["comment2"]),
        ("reply",   imgs["reply1"]),
        ("reply",   imgs["reply2"]),
    ]
    comments_raw: List[str] = []
    replies_raw:  List[str] = []

    # Threaded OCR, never raising to Flask
    with ThreadPoolExecutor(max_workers=OCR_THREADS) as ex:
        futs = {ex.submit(ocr_lines, img, OCR_TIMEOUT): kind for (kind, img) in panels}
        for fut in as_completed(futs):
            kind = futs[fut]
            try:
                lines = fut.result()
            except Exception:
                lines = []
            if kind == "comment":
                comments_raw.extend(lines)
            else:
                replies_raw.extend(lines)

    # 3) Structure by user handle
    comment_map  = extract_user_texts(comments_raw)
    reply_map    = extract_user_texts(replies_raw)
    uid_pick     = pick_user(comment_map, reply_map)
    uid_norm     = normalize_handle(uid_pick)

    comments = [refine_text(t) for t in (comment_map.get(uid_pick) or [])]
    replies  = [refine_text(t) for t in (reply_map.get(uid_pick)   or [])]

    # De-duplicate (duplicates do NOT count toward verification)
    comments = dedupe_and_trim(comments)
    replies  = dedupe_and_trim(replies)

    verified = bool(liked and len(comments) >= 2 and len(replies) >= 2)

    payload = {
        "liked": liked,
        "user_id": uid_norm,
        "comment": comments if comments else None,
        "replies": replies if replies else None,
        "verified": verified,
    }

    if not verified:
        payload["message"] = "Verification Fails. Try to upload some other screenshot"

    return jsonify(payload), 200

# ─────────────── Ensure JSON on any unhandled error ───────────────
@app.errorhandler(Exception)
def handle_exception(e):
    code = e.code if isinstance(e, HTTPException) else 500
    app.logger.exception("Unhandled exception")
    return jsonify({
        "error": "internal_server_error" if code == 500 else "http_error",
        "status": code
    }), code

# ─────────────────────── Main ───────────────────────
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=DEBUG)
