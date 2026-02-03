import os, re, io, time, uuid, threading
from typing import Dict, Any, List, Optional

from flask import Flask, request, jsonify
from PIL import Image, ImageEnhance
import pytesseract
from difflib import SequenceMatcher

# -----------------------------
# Config
# -----------------------------
ANALYZER_VERSION = "2.2.0"

MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", str(10 * 1024 * 1024)))
MAX_REQUEST_BYTES = int(os.getenv("MAX_REQUEST_BYTES", str(60 * 1024 * 1024)))

OCR_LANG = os.getenv("OCR_LANG", "eng")

# FAST defaults for UI screenshots
TESSERACT_FAST = os.getenv("TESSERACT_FAST", "--oem 1 --psm 11")
TESSERACT_HEADER = os.getenv("TESSERACT_HEADER", "--oem 1 --psm 7")

OCR_TIMEOUT_SEC = int(os.getenv("OCR_TIMEOUT_SEC", "8"))

# Similarity thresholds
SIMILARITY_SAME = float(os.getenv("SIMILARITY_SAME", "0.90"))
SIMILARITY_CROSS = float(os.getenv("SIMILARITY_CROSS", "0.88"))

# Concurrency cap: prevents queue → Node timeout
MAX_CONCURRENT_OCR = int(os.getenv("MAX_CONCURRENT_OCR", "3"))
BUSY_ACQUIRE_TIMEOUT_SEC = float(os.getenv("BUSY_ACQUIRE_TIMEOUT_SEC", "0.8"))
OCR_SEM = threading.BoundedSemaphore(MAX_CONCURRENT_OCR)

ALL_ROLES = ["like", "comment1", "comment2", "reply1", "reply2"]

AT_HANDLE_RE = re.compile(r"@[\w\.\-]{2,}", re.IGNORECASE)
AGO_RE = re.compile(r"\bago\b", re.IGNORECASE)
TIME_RE = re.compile(
    r"\b(\d+)\s*(sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\b",
    re.IGNORECASE
)

STOP_TOKENS = [
    "add a comment", "add a reply", "write a comment", "write a reply",
    "view replies", "hide replies", "see more", "show more",
    "reply", "replies", "topics", "newest", "see translation", "translate to"
]

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_BYTES


# -----------------------------
# Text utils
# -----------------------------
def normalize_text(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"[^\w\s@]", "", s)
    return s.strip()

def sim(a: str, b: str) -> float:
    a_n = normalize_text(a)
    b_n = normalize_text(b)
    if not a_n or not b_n:
        return 0.0
    return SequenceMatcher(None, a_n, b_n).ratio()

def clean_snippet(s: str, max_len: int = 180) -> str:
    s = (s or "").strip()
    s = s.replace("“", "").replace("”", "").replace("’", "'").replace("`", "'")
    s = re.sub(r"\s+", " ", s).strip()

    low = s.lower()
    for tok in STOP_TOKENS:
        idx = low.find(tok)
        if idx != -1:
            s = s[:idx].strip()
            low = s.lower()

    # trim junk counters/icons at end
    s = re.sub(r"[©®™]+", "", s).strip()
    if len(s) > max_len:
        s = s[:max_len].rstrip()
    return s

def is_ui_line(line: str) -> bool:
    l = (line or "").strip().lower()
    if not l:
        return True
    for tok in STOP_TOKENS:
        if tok in l:
            return True
    if re.fullmatch(r"[\d\W_]+", l):
        return True
    return False

def clamp_int(v, default, lo=0, hi=10):
    try:
        n = int(v)
        return max(lo, min(hi, n))
    except Exception:
        return default

def to_bool(v, default=False) -> bool:
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "y", "on"):
        return True
    if s in ("0", "false", "no", "n", "off"):
        return False
    return default


# -----------------------------
# OCR (FAST)
# -----------------------------
def preprocess(img: Image.Image, max_w: int) -> Image.Image:
    if img.mode != "RGB":
        img = img.convert("RGB")

    w, h = img.size
    if w > max_w:
        img = img.resize((max_w, int(h * (max_w / w))), Image.LANCZOS)

    gray = img.convert("L")
    gray = ImageEnhance.Contrast(gray).enhance(1.6)
    gray = ImageEnhance.Sharpness(gray).enhance(1.15)
    return gray

def ocr(img: Image.Image, cfg: str) -> str:
    try:
        return pytesseract.image_to_string(
            img, lang=OCR_LANG, config=cfg, timeout=OCR_TIMEOUT_SEC
        ) or ""
    except Exception:
        return ""

def ocr_role(img: Image.Image, role: str) -> Dict[str, Any]:
    """
    Biggest speed win:
    - OCR only a ROI (content area), NOT entire screenshot.
    - Do header OCR ONLY if handle is missing.
    """
    w, h = img.size

    # ROI choices (tuned for YouTube comments UI)
    if role in ("comment1", "comment2", "reply1", "reply2"):
        # ignore top navbar + bottom buttons area
        roi = img.crop((0, int(h * 0.16), w, int(h * 0.92)))
        roi = preprocess(roi, max_w=1000)
        text = ocr(roi, TESSERACT_FAST)

        # fallback header OCR ONLY if no handle found
        if not AT_HANDLE_RE.search(text or ""):
            header = img.crop((0, 0, w, int(h * 0.28)))
            header = preprocess(header, max_w=900)
            htext = ocr(header, TESSERACT_HEADER)
        else:
            htext = ""

        return {"text": (htext + "\n" + text).strip(), "roi_used": True}

    # like image: small middle/bottom area is enough usually
    roi = img.crop((0, int(h * 0.45), w, int(h * 0.98)))
    roi = preprocess(roi, max_w=900)
    text = ocr(roi, TESSERACT_FAST)
    return {"text": text.strip(), "roi_used": True}


# -----------------------------
# Handle + message extraction
# -----------------------------
def normalize_handle(h: str) -> str:
    h = (h or "").strip()
    if not h:
        return ""
    return h if h.startswith("@") else "@" + h

def extract_handle_from_line(line: str) -> Optional[str]:
    line = line or ""
    m = AT_HANDLE_RE.search(line)
    if m:
        return normalize_handle(m.group(0))

    # fallback: "name 2 min ago" (no @)
    if AGO_RE.search(line) and TIME_RE.search(line):
        first = re.split(r"\s+", line.strip())[0]
        if re.match(r"^[A-Za-z][\w\.\-]{2,}$", first):
            return normalize_handle(first)

    return None

def extract_blocks_by_handle(full_text: str) -> Dict[str, List[str]]:
    """
    Works even when replies don't have ":".
    Detect handle line -> capture subsequent lines as message until next handle/UI.
    """
    lines = [ln.strip() for ln in (full_text or "").splitlines() if ln.strip()]
    out: Dict[str, List[str]] = {}

    current: Optional[str] = None
    buf: List[str] = []

    def flush():
        nonlocal current, buf
        if current and buf:
            msg = clean_snippet(" ".join(buf))
            if msg:
                out.setdefault(current.lower(), []).append(msg)
        buf = []

    for ln in lines:
        h = extract_handle_from_line(ln)
        if h:
            flush()
            current = h
            # same-line message (if OCR captured)
            if ":" in ln:
                tail = ln.split(":", 1)[1].strip()
                if tail and not is_ui_line(tail):
                    buf.append(tail)
            continue

        if current:
            if is_ui_line(ln):
                flush()
                current = None
                continue
            buf.append(ln)

    flush()
    return out

def detect_liked(text: str) -> Optional[bool]:
    t = normalize_text(text)
    if "liked" in t:
        return True
    if "like" in t:
        return False
    return None

def pick_majority_handle(handles_by_role: Dict[str, List[str]], required_roles: List[str]) -> str:
    counts, occ, original = {}, {}, {}
    roles = [r for r in required_roles if r != "like"]
    for role in roles:
        seen = set()
        for h in (handles_by_role.get(role) or []):
            key = h.lower()
            original.setdefault(key, h)
            occ[key] = occ.get(key, 0) + 1
            if key not in seen:
                counts[key] = counts.get(key, 0) + 1
                seen.add(key)
    if not counts:
        return ""
    best = sorted(counts.keys(), key=lambda k: (counts[k], occ.get(k, 0)), reverse=True)[0]
    return original[best]

def uniqueness_ok(texts: List[str], thr: float) -> bool:
    for i in range(len(texts)):
        for j in range(i + 1, len(texts)):
            if sim(texts[i], texts[j]) >= thr:
                return False
    return True

def cross_ok(comments: List[str], replies: List[str], thr: float) -> bool:
    for c in comments:
        for r in replies:
            if sim(c, r) >= thr:
                return False
    return True


# -----------------------------
# Routes
# -----------------------------
@app.get("/health")
def health():
    return jsonify({"ok": True, "version": ANALYZER_VERSION})

@app.post("/analyze")
def analyze():
    start = time.time()
    req_id = str(uuid.uuid4())

    # prevent queue → return 429 quickly (Node should retry)
    acquired = OCR_SEM.acquire(timeout=BUSY_ACQUIRE_TIMEOUT_SEC)
    if not acquired:
        return jsonify({
            "request_id": req_id,
            "verified": False,
            "message": "Analyzer busy, retry",
            "reasons": ["ANALYZER_BUSY"],
            "analyzer_version": ANALYZER_VERSION
        }), 429

    try:
        min_comments = clamp_int(request.args.get("min_comments"), 2, lo=0, hi=10)
        min_replies = clamp_int(request.args.get("min_replies"), 2, lo=0, hi=10)
        require_like = to_bool(request.args.get("require_like"), False)
        debug = to_bool(request.args.get("debug"), False)

        required_roles: List[str] = []
        if require_like: required_roles.append("like")
        if min_comments >= 1: required_roles.append("comment1")
        if min_comments >= 2: required_roles.append("comment2")
        if min_replies >= 1: required_roles.append("reply1")
        if min_replies >= 2: required_roles.append("reply2")

        files = request.files or {}
        missing = [r for r in required_roles if r not in files]
        if missing:
            return jsonify({
                "request_id": req_id,
                "verified": False,
                "message": "Missing required images",
                "reasons": ["MISSING_IMAGES"],
                "missing": missing,
                "rules": {"min_comments": min_comments, "min_replies": min_replies, "require_like": require_like},
                "analyzer_version": ANALYZER_VERSION
            }), 400

        present_roles = [r for r in ALL_ROLES if r in files]
        parsed: Dict[str, Dict[str, Any]] = {}
        reasons: List[str] = []
        warnings: List[str] = []

        for role in present_roles:
            raw = files[role].read()
            if len(raw) > MAX_IMAGE_BYTES:
                return jsonify({
                    "request_id": req_id,
                    "verified": False,
                    "message": f"Image too large: {role}",
                    "reasons": ["IMAGE_TOO_LARGE"],
                    "role": role,
                    "analyzer_version": ANALYZER_VERSION
                }), 400

            try:
                img = Image.open(io.BytesIO(raw))
                img.load()
            except Exception:
                return jsonify({
                    "request_id": req_id,
                    "verified": False,
                    "message": f"Invalid image: {role}",
                    "reasons": ["INVALID_IMAGE"],
                    "role": role,
                    "analyzer_version": ANALYZER_VERSION
                }), 400

            res = ocr_role(img, role)
            text = res["text"] or ""
            if not text:
                warnings.append("OCR_EMPTY_OR_TIMEOUT")

            segments = extract_blocks_by_handle(text) if text else {}
            handles = set([normalize_handle(h) for h in segments.keys()])
            for m in AT_HANDLE_RE.findall(text):
                handles.add(normalize_handle(m))

            liked = detect_liked(text) if role == "like" else None

            parsed[role] = {
                "text": text,
                "segments": segments,
                "handles": sorted(handles),
                "liked": liked,
            }

        # Like
        like_provided = "like" in parsed
        liked_state = None
        if like_provided:
            liked_state = parsed["like"].get("liked")
            if liked_state is None:
                (reasons if require_like else warnings).append("LIKE_UNCLEAR")

        # Handle selection
        handles_by_role = {}
        for r in ["comment1", "comment2", "reply1", "reply2"]:
            if r in parsed:
                handles_by_role[r] = parsed[r]["handles"]

        main_handle = pick_majority_handle(handles_by_role, required_roles)
        if not main_handle:
            reasons.append("USERNAME_NOT_FOUND")

        def msgs(role: str) -> List[str]:
            seg = parsed.get(role, {}).get("segments") or {}
            return seg.get((main_handle or "").lower(), [])

        # Visibility check: required role must have handle OR extracted msgs
        if main_handle:
            for rr in [r for r in required_roles if r != "like"]:
                role_handles = [h.lower() for h in parsed.get(rr, {}).get("handles", [])]
                role_msgs = msgs(rr)
                if (main_handle.lower() not in role_handles) and (not role_msgs):
                    reasons.append("USERNAME_NOT_VISIBLE")
                    break

        # Extract comments/replies
        comments: List[str] = []
        replies: List[str] = []

        for r in ["comment1", "comment2"]:
            ms = msgs(r) if main_handle else []
            if ms: comments.append(ms[0])

        for r in ["reply1", "reply2"]:
            ms = msgs(r) if main_handle else []
            if ms: replies.append(ms[-1])

        if len(comments) < min_comments:
            reasons.append("INSUFFICIENT_COMMENTS")
        if len(replies) < min_replies:
            reasons.append("INSUFFICIENT_REPLIES")

        if len(comments) >= 2 and not uniqueness_ok(comments, SIMILARITY_SAME):
            reasons.append("COMMENTS_TOO_SIMILAR")
        if len(replies) >= 2 and not uniqueness_ok(replies, SIMILARITY_SAME):
            reasons.append("REPLIES_TOO_SIMILAR")

        if comments and replies and not cross_ok(comments, replies, SIMILARITY_CROSS):
            reasons.append("COMMENT_EQUALS_REPLY")

        if require_like:
            if not like_provided:
                reasons.append("LIKE_REQUIRED_BUT_NOT_PROVIDED")
            elif liked_state is not True and liked_state is False:
                reasons.append("LIKE_REQUIRED_BUT_NOT_LIKED")

        verified = (len(reasons) == 0)

        resp: Dict[str, Any] = {
            "request_id": req_id,
            "verified": verified,
            "user_id": main_handle or None,
            "comment": comments,
            "replies": replies,

            "like_provided": bool(like_provided),
            "liked": bool(liked_state) if like_provided and liked_state is not None else False,

            "rules": {
                "min_comments": min_comments,
                "min_replies": min_replies,
                "require_like": bool(require_like),
            },
            "reasons": reasons,
            "warnings": warnings,
            "message": "Verified" if verified else "Verification failed",
            "processing_ms": int((time.time() - start) * 1000),
            "analyzer_version": ANALYZER_VERSION,
        }

        if debug:
            resp["debug"] = {
                "present_roles": present_roles,
                "handles_by_role": handles_by_role,
                "segments_for_main": {r: msgs(r) for r in present_roles if r != "like"}
            }

        return jsonify(resp), (200 if verified else 422)

    finally:
        OCR_SEM.release()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "6000")), debug=False)
