import os
import re
import io
import time
import uuid
from typing import Dict, Any, List, Optional

from flask import Flask, request, jsonify
from PIL import Image, ImageEnhance
import pytesseract
from difflib import SequenceMatcher

# -----------------------------
# Config
# -----------------------------
MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", str(10 * 1024 * 1024)))
MAX_REQUEST_BYTES = int(os.getenv("MAX_REQUEST_BYTES", str(60 * 1024 * 1024)))
OCR_LANG = os.getenv("OCR_LANG", "eng")
TESSERACT_CONFIG = os.getenv("TESSERACT_CONFIG", "--oem 1 --psm 6")

SIMILARITY_SAME = float(os.getenv("SIMILARITY_SAME", "0.90"))
SIMILARITY_CROSS = float(os.getenv("SIMILARITY_CROSS", "0.88"))

ANALYZER_VERSION = "1.2.0"
ALL_ROLES = ["like", "comment1", "comment2", "reply1", "reply2"]

# Handles: @name or name-like
AT_HANDLE_RE = re.compile(r"@[\w\.\-]{2,}", re.IGNORECASE)

# Time markers
AGO_RE = re.compile(r"\bago\b", re.IGNORECASE)
TIME_RE = re.compile(r"\b(\d+)\s*(sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\b",
                     re.IGNORECASE)

STOP_TOKENS = [
    "add a comment", "add a reply", "write a comment", "write a reply",
    "view replies", "hide replies", "see more", "show more",
    "reply", "replies", "topics", "newest", "see translation", "translate to"
]

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_BYTES

# -----------------------------
# Helpers
# -----------------------------
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

def normalize_text(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"[^\w\s@]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

def sim(a: str, b: str) -> float:
    a_n = normalize_text(a)
    b_n = normalize_text(b)
    if not a_n or not b_n:
        return 0.0
    return SequenceMatcher(None, a_n, b_n).ratio()

def preprocess(img: Image.Image) -> Image.Image:
    if img.mode != "RGB":
        img = img.convert("RGB")

    w, h = img.size
    max_w = 1400
    if w > max_w:
        new_h = int(h * (max_w / w))
        img = img.resize((max_w, new_h), Image.LANCZOS)

    gray = img.convert("L")
    gray = ImageEnhance.Contrast(gray).enhance(1.8)
    gray = ImageEnhance.Sharpness(gray).enhance(1.4)
    return gray

def ocr_image(img: Image.Image, config: Optional[str] = None) -> str:
    img = preprocess(img)
    cfg = config or TESSERACT_CONFIG
    return pytesseract.image_to_string(img, lang=OCR_LANG, config=cfg) or ""

def clean_snippet(s: str, max_len: int = 180) -> str:
    s = (s or "").strip()
    s = s.replace("“", "").replace("”", "").replace("’", "'").replace("`", "'")
    s = re.sub(r"\s+", " ", s).strip()

    # cut on known UI tokens
    low = s.lower()
    for tok in STOP_TOKENS:
        idx = low.find(tok)
        if idx != -1:
            s = s[:idx].strip()
            low = s.lower()

    # remove leading junk
    s = re.sub(r"^[\|\)\]\}\>]+", "", s).strip()

    # remove trailing icons/counters often OCR’d
    s = re.sub(r"(\s+\d{1,4}){1,4}\s*([&❤👍💬]|$).*?$", "", s).strip()

    # remove trademark-ish symbols
    s = re.sub(r"[©®™]+", "", s).strip()

    if len(s) > max_len:
        s = s[:max_len].rstrip()

    return s

def is_ui_line(line: str) -> bool:
    l = (line or "").strip().lower()
    if not l:
        return True
    # common UI / chrome
    for tok in STOP_TOKENS:
        if tok in l:
            return True
    # pure counters/icons
    if re.fullmatch(r"[\d\W_]+", l):
        return True
    return False

def normalize_handle(h: str) -> str:
    h = (h or "").strip()
    if not h:
        return ""
    if h.startswith("@"):
        return h
    return "@" + h

def extract_handle_from_line(line: str) -> Optional[str]:
    """
    Handle line patterns seen in YouTube screenshots:
      @handle + 2 min ago
      @handle 2 min ago
      handle • 2 min ago   (no @)
    """
    if not line:
        return None

    m = AT_HANDLE_RE.search(line)
    if m:
        return normalize_handle(m.group(0))

    # no @, but looks like a username + time + 'ago'
    if AGO_RE.search(line) and TIME_RE.search(line):
        first = re.split(r"\s+", line.strip())[0]
        if re.match(r"^[A-Za-z][\w\.\-]{2,}$", first):
            return normalize_handle(first)

    return None

def extract_blocks_by_handle(full_text: str) -> Dict[str, List[str]]:
    """
    Line-based extraction:
    - Detect a "handle line" (username + time ago)
    - Capture following lines as message until next handle line or UI line.
    - Also supports same-line message after ":" (if present).
    Returns: {handle_lower: [msg1, msg2, ...]}
    """
    lines = [ln.strip() for ln in (full_text or "").splitlines() if ln.strip()]
    out: Dict[str, List[str]] = {}

    current_handle: Optional[str] = None
    buf: List[str] = []

    def flush():
        nonlocal current_handle, buf
        if current_handle and buf:
            msg = clean_snippet(" ".join(buf))
            if msg:
                out.setdefault(current_handle.lower(), []).append(msg)
        buf = []

    for ln in lines:
        h = extract_handle_from_line(ln)
        if h:
            flush()
            current_handle = h
            # same line message support: take text after ":" if present
            if ":" in ln:
                parts = ln.split(":", 1)
                tail = parts[1].strip()
                if tail and not is_ui_line(tail):
                    buf.append(tail)
            else:
                # sometimes message starts after "ago" on same line (rare)
                idx = ln.lower().rfind("ago")
                if idx != -1:
                    tail = ln[idx + 3 :].strip()
                    if tail and len(tail) > 3 and not is_ui_line(tail):
                        buf.append(tail)
            continue

        if current_handle:
            if is_ui_line(ln):
                # end block
                flush()
                current_handle = None
                continue
            buf.append(ln)

    flush()
    return out

def pick_majority_handle(handles_by_role: Dict[str, List[str]], required_roles: List[str]) -> str:
    counts: Dict[str, int] = {}
    occ: Dict[str, int] = {}
    original: Dict[str, str] = {}

    roles_to_use = [r for r in required_roles if r != "like"]
    for role in roles_to_use:
        hs = handles_by_role.get(role) or []
        seen = set()
        for h in hs:
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

def uniqueness_check(texts: List[str], threshold: float) -> bool:
    for i in range(len(texts)):
        for j in range(i + 1, len(texts)):
            if sim(texts[i], texts[j]) >= threshold:
                return False
    return True

def cross_check(comments: List[str], replies: List[str], threshold: float) -> bool:
    for c in comments:
        for r in replies:
            if sim(c, r) >= threshold:
                return False
    return True

def detect_liked(ocr_text: str) -> Optional[bool]:
    t = normalize_text(ocr_text)
    if "liked" in t:
        return True
    if "like" in t:
        return False
    return None

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

    min_comments = clamp_int(request.args.get("min_comments"), 2, lo=0, hi=10)
    min_replies = clamp_int(request.args.get("min_replies"), 2, lo=0, hi=10)
    require_like = to_bool(request.args.get("require_like"), False)
    debug = to_bool(request.args.get("debug"), False)

    required_roles: List[str] = []
    if require_like:
        required_roles.append("like")
    if min_comments >= 1:
        required_roles.append("comment1")
    if min_comments >= 2:
        required_roles.append("comment2")
    if min_replies >= 1:
        required_roles.append("reply1")
    if min_replies >= 2:
        required_roles.append("reply2")

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
        f = files.get(role)
        raw = f.read()
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

        w, h = img.size
        top_crop = img.crop((0, 0, w, int(h * 0.35)))

        full_text = ocr_image(img)
        top_text = ocr_image(top_crop)

        # main extraction from full_text (line-based)
        segments = extract_blocks_by_handle(full_text)

        # fallback: if no segments, OCR lower part (common for replies)
        if not segments and role in ("reply1", "reply2"):
            lower = img.crop((0, int(h * 0.25), w, h))
            lower_text = ocr_image(lower)
            segments = extract_blocks_by_handle(lower_text)
        else:
            lower_text = ""

        # handles present = keys from segments + any @handles seen anywhere
        handles = set()
        handles.update([normalize_handle(k) for k in segments.keys()])
        for m in AT_HANDLE_RE.findall(full_text + " " + top_text):
            handles.add(normalize_handle(m))

        liked = None
        if role == "like":
            liked = detect_liked(full_text)

        parsed[role] = {
            "role": role,
            "handles": sorted(handles),
            "segments": segments,  # keys are lower already in extract_blocks_by_handle
            "liked": liked,
            "ocr_full": full_text,
            "ocr_top": top_text,
            "ocr_lower": lower_text
        }

    # Like logic
    like_provided = "like" in parsed
    liked_state = None
    if like_provided:
        liked_state = parsed["like"].get("liked")
        if liked_state is None:
            if require_like:
                reasons.append("LIKE_UNCLEAR")
            else:
                warnings.append("LIKE_UNCLEAR")

    # handle selection
    handles_by_role: Dict[str, List[str]] = {}
    for r in ["comment1", "comment2", "reply1", "reply2"]:
        if r in parsed:
            handles_by_role[r] = parsed[r].get("handles") or []

    main_handle = pick_majority_handle(handles_by_role, required_roles)
    if not main_handle:
        reasons.append("USERNAME_NOT_FOUND")

    def get_msgs(role: str) -> List[str]:
        segs = parsed.get(role, {}).get("segments") or {}
        return segs.get(main_handle.lower(), [])

    # Username visibility check (smarter)
    # Only fail if required role has neither handle detected nor messages extracted.
    if main_handle:
        for rr in [r for r in required_roles if r != "like"]:
            role_handles = [h.lower() for h in (parsed.get(rr, {}).get("handles") or [])]
            role_msgs = get_msgs(rr)
            if (main_handle.lower() not in role_handles) and (not role_msgs):
                reasons.append("USERNAME_NOT_VISIBLE")
                break

    # Extract texts
    comments: List[str] = []
    replies: List[str] = []

    for r in ["comment1", "comment2"]:
        if r in parsed and main_handle:
            msgs = get_msgs(r)
            if msgs:
                comments.append(msgs[0])  # comment is usually first block

    for r in ["reply1", "reply2"]:
        if r in parsed and main_handle:
            msgs = get_msgs(r)
            if msgs:
                replies.append(msgs[-1])  # reply is usually last block

    # Count checks
    if len(comments) < min_comments:
        reasons.append("INSUFFICIENT_COMMENTS")
    if len(replies) < min_replies:
        reasons.append("INSUFFICIENT_REPLIES")

    # Uniqueness
    if len(comments) >= 2 and not uniqueness_check(comments, SIMILARITY_SAME):
        reasons.append("COMMENTS_TOO_SIMILAR")
    if len(replies) >= 2 and not uniqueness_check(replies, SIMILARITY_SAME):
        reasons.append("REPLIES_TOO_SIMILAR")

    # Cross-check
    if comments and replies and not cross_check(comments, replies, SIMILARITY_CROSS):
        reasons.append("COMMENT_EQUALS_REPLY")

    # Like enforce
    if require_like:
        if not like_provided:
            reasons.append("LIKE_REQUIRED_BUT_NOT_PROVIDED")
        elif liked_state is not True:
            if liked_state is False:
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
        "liked_state": ("yes" if liked_state is True else "no" if liked_state is False else "unknown" if like_provided else "not_provided"),

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
            "segments_for_main": {
                role: (parsed.get(role, {}).get("segments") or {}).get((main_handle or "").lower(), [])
                for role in present_roles
            },
            "handles_detected": {
                role: parsed.get(role, {}).get("handles", [])
                for role in present_roles
            }
        }

    return jsonify(resp), (200 if verified else 422)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "6000")), debug=False)
