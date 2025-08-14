"""Flask micro-service (YouTube Shorts screenshot analyser)

Returns JSON:
{
  "liked": true | false,                 # never null
  "user_id": "@handle" | null,           # handle present in both layers
  "comment": ["…", "…"] | null,          # *clean* top-level comments by that handle
  "replies": ["…", "…"] | null,          # *clean* replies by same handle
  "verified": true | false                # true if liked and ≥2 comments & ≥2 replies
}
"""
import io
import os
import re
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
import pytesseract
from flask import Flask, jsonify, request
from flask_cors import CORS
from PIL import Image
from skimage.filters import threshold_sauvola

app = Flask(__name__)
CORS(app)   # allow cross-origin requests

# ─────────────── Like-icon constants (use WIDE crop) ───────────────
ICON_X1, ICON_X2 = 0.05, 0.12
ICON_Y1, ICON_Y2 = 0.47, 0.55

# Darkness logic
DARK_THRESHOLD    = 80
LIKE_FILLED_MIN   = 0.06   # whole-crop dark ratio → definitely liked (more conservative)
LIKE_OUTLINE_MAX  = 0.015  # whole-crop dark ratio → definitely unliked

# Center test (works well on your samples)
CENTER_BOX_START  = 0.30   # 30% in from each edge of the icon crop
CENTER_BOX_END    = 0.70   # 70% in from each edge
CENTER_DARK_MIN   = 0.12   # if center_dark >= this → liked

# ─────────────── Comment / reply constants ───────────────
HANDLE_RE_INLINE = re.compile(r"@([A-Za-z0-9_\-.]{2,})")
UNICODE_JUNK     = "•·●○▶►«»▪–—|>_"
STOP_PHRASES     = (
    'adda reply', 'add a reply', 'add reply', 'add a comment', 'adda comment',
    'add comment', 'add a reply…', 'replies', 'reply', 'share', 'download', 'remix'
)
SINGLE_LETTER_RE = re.compile(r"\b[A-Za-z]\b")
ISOLATED_NUM_RE  = re.compile(r"\b\d+\b")

# ─────────────── Helpers ───────────────
def pil2gray(img: Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2GRAY)

def sauvola(gray: np.ndarray) -> np.ndarray:
    thr = threshold_sauvola(gray, window_size=25)
    return ((gray > thr) * 255).astype(np.uint8)

def ocr_lines(img: Image.Image) -> List[str]:
    bw = sauvola(pil2gray(img))
    txt = pytesseract.image_to_string(bw, lang='eng', config='--oem 3 --psm 6')
    return [ln.strip() for ln in txt.splitlines() if ln.strip()]

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
                low = lines[i].lower()
                if HANDLE_RE_INLINE.search(lines[i]) or low.strip() == '@':
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
    h, w = img.height, img.width
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
    width, height = x2 - x1, y2 - y1
    cx1 = x1 + int(width  * CENTER_BOX_START)
    cx2 = x1 + int(width  * CENTER_BOX_END)
    cy1 = y1 + int(height * CENTER_BOX_START)
    cy2 = y1 + int(height * CENTER_BOX_END)

    center = img.crop((cx1, cy1, cx2, cy2))
    cgray = pil2gray(center)
    center_dark = float((cgray < DARK_THRESHOLD).sum()) / float(cgray.size)

    return center_dark >= CENTER_DARK_MIN

# ─────────────── API Endpoints ───────────────
@app.route('/', methods=['GET'])
def health():
    return 'ok', 200

@app.route('/analyze', methods=['POST'])
def analyze():
    if len(request.files) != 5:
        return jsonify({'error': 'Upload exactly 5 images: like, comment1, comment2, reply1, reply2'}), 400

    keys = ['like','comment1','comment2','reply1','reply2']
    imgs = {}
    # Maintain explicit order of provided files
    for key, storage in zip(keys, request.files.values()):
        storage.stream.seek(0)
        imgs[key] = Image.open(io.BytesIO(storage.read()))

    liked = detect_like(imgs['like'])

    comments_raw = ocr_lines(imgs['comment1']) + ocr_lines(imgs['comment2'])
    replies_raw  = ocr_lines(imgs['reply1'])   + ocr_lines(imgs['reply2'])

    comment_map  = extract_user_texts(comments_raw)
    reply_map    = extract_user_texts(replies_raw)
    uid          = pick_user(comment_map, reply_map)

    comments = [refine_text(t) for t in (comment_map.get(uid) or [])]
    replies  = [refine_text(t) for t in (reply_map.get(uid)   or [])]
    verified = bool(liked and len(comments) >= 2 and len(replies) >= 2)

    if not verified:
        return jsonify({
            'message': 'Verification Fails. Try to upload some other screenshot',
            'liked': liked,
            'user_id': uid,
            'comment': comments,
            'replies': replies,
            'verified': verified,
        }), 200

    return jsonify({
        'liked': liked,
        'user_id': uid,
        'comment': comments,
        'replies': replies,
        'verified': verified,
    }), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT1', 6000)), debug=True)
