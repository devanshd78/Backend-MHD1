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
from werkzeug.exceptions import HTTPException

# ═══════════════════════════════════════════════════════════════════════════
#                                  CONFIG
# ═══════════════════════════════════════════════════════════════════════════
PORT = int(os.getenv("PORT", 6000))
DEBUG = bool(int(os.getenv("DEBUG", "0")))
MAX_SIDE = int(os.getenv("MAX_SIDE", "2000"))
OCR_TIMEOUT = int(os.getenv("OCR_TIMEOUT", "15"))

TESSERACT_CMD = os.getenv("TESSERACT_CMD")
if TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD

# Verify Tesseract
TESSERACT_OK = True
TESSERACT_ERR = None
try:
    _ = pytesseract.get_tesseract_version()
except Exception as e:
    TESSERACT_OK = False
    TESSERACT_ERR = str(e)

# ═══════════════════════════════════════════════════════════════════════════
#                                  FLASK APP
# ═══════════════════════════════════════════════════════════════════════════
app = Flask(__name__)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB

# ═══════════════════════════════════════════════════════════════════════════
#                            DETECTION CONSTANTS
# ═══════════════════════════════════════════════════════════════════════════
# Like button region (left side of screen, middle height)
LIKE_X1, LIKE_X2 = 0.02, 0.15
LIKE_Y1, LIKE_Y2 = 0.40, 0.60
DARK_THRESHOLD = 100
LIKE_FILLED_THRESHOLD = 0.10  # 10% dark pixels means liked

# Username pattern
USERNAME_RE = re.compile(r"@([A-Za-z0-9_.-]{3,})")

# Noise phrases to ignore
NOISE = {
    "translate", "hindi", "add a reply", "add reply", "add comment", "reply added",
    "comments", "replies", "newest", "timed", "top", "pinned", "subscribe",
    "remember to keep comments respectful", "youtube community guidelines",
    "learn more", "share", "download", "remix", "39 replies", "read more"
}

# Time indicators (for detecting author lines)
TIME_WORDS = {"ago", "edited", "sec", "min", "hour", "day", "week", "month", "year", "mo", "yr"}

# ═══════════════════════════════════════════════════════════════════════════
#                              HELPER FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

def normalize_username(username: Optional[str]) -> Optional[str]:
    """Normalize username to @lowercase format"""
    if not username:
        return None
    username = username.strip().lower()
    if not username.startswith("@"):
        username = "@" + username
    # Clean up any trailing garbage
    username = re.sub(r"[^@a-z0-9_.-].*$", "", username)
    return username if len(username) > 3 else None


def downscale_image(img: Image.Image) -> Image.Image:
    """Downscale image if needed"""
    w, h = img.size
    if max(w, h) <= MAX_SIDE:
        return img.convert("RGB")
    
    scale = MAX_SIDE / float(max(w, h))
    new_w = max(1, int(w * scale))
    new_h = max(1, int(h * scale))
    resized = img.convert("RGB")
    resized.thumbnail((new_w, new_h), Image.BICUBIC)
    return resized


def preprocess_for_ocr(img: Image.Image, crop_y1: float = 0.20, crop_y2: float = 0.96) -> np.ndarray:
    """
    Preprocess image for OCR with optimal settings for YouTube dark/light modes
    """
    # Downscale and crop to relevant region
    img = downscale_image(img)
    w, h = img.size
    y1 = int(h * crop_y1)
    y2 = int(h * crop_y2)
    x1 = int(w * 0.01)
    x2 = int(w * 0.99)
    
    cropped = img.crop((x1, y1, x2, y2))
    
    # Convert to grayscale
    gray = cv2.cvtColor(np.array(cropped), cv2.COLOR_RGB2GRAY)
    
    # Upscale for better OCR (3x gives best results for YouTube UI)
    gray = cv2.resize(gray, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)
    
    # Detect dark mode (mean brightness < 100 = dark mode)
    mean_brightness = np.mean(gray)
    
    if mean_brightness < 100:
        # Dark mode: invert so text is dark on light background
        gray = cv2.bitwise_not(gray)
    
    # Apply CLAHE for better contrast
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    
    # Light denoising
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    
    return gray


def extract_text_lines(img: Image.Image) -> List[str]:
    """Extract text lines from image using OCR"""
    processed = preprocess_for_ocr(img)
    
    # Use PSM 6 (uniform block of text) - best for comments/replies
    config = "--oem 3 --psm 6 -c preserve_interword_spaces=1"
    
    try:
        text = pytesseract.image_to_string(
            processed,
            lang="eng",
            config=config,
            timeout=OCR_TIMEOUT
        )
    except Exception as e:
        app.logger.error(f"OCR failed: {e}")
        return []
    
    # Split into lines and clean
    lines = []
    for line in text.splitlines():
        line = line.strip()
        if line and len(line) > 1:
            lines.append(line)
    
    return lines


def is_noise_line(text: str) -> bool:
    """Check if line is UI noise"""
    text_lower = text.lower()
    return any(phrase in text_lower for phrase in NOISE)


def has_time_indicator(text: str) -> bool:
    """Check if line contains time indicator (author line)"""
    text_lower = text.lower()
    # Check for time words
    if any(word in text_lower for word in TIME_WORDS):
        return True
    # Check for patterns like "2 mo ago", "1 day ago", "0 sec ago"
    if re.search(r"\d+\s*(sec|min|hour|day|week|mo|month|yr|year)", text_lower):
        return True
    return False


def extract_username(text: str) -> Optional[str]:
    """Extract username from text line"""
    # Try pattern with @
    match = USERNAME_RE.search(text)
    if match:
        return normalize_username("@" + match.group(1))
    
    # Try to find username-like token at start of line
    tokens = text.split()
    if tokens:
        first_token = tokens[0].strip()
        # Check if it looks like a username
        if re.match(r"^@?[A-Za-z][A-Za-z0-9_.-]{2,}$", first_token):
            # Make sure it's not a time word
            if first_token.lower() not in TIME_WORDS:
                return normalize_username(first_token)
    
    return None


def clean_text(text: str) -> str:
    """Clean comment/reply text - remove ALL OCR artifacts"""
    # Remove leading/trailing special characters
    text = re.sub(r"^[~\-•\*\|\[\](){}<>]+\s*", "", text)
    text = re.sub(r"\s*[~\-•\*\|\[\](){}<>]+$", "", text)
    
    # Remove emoji-like artifacts and symbols (but keep spaces to avoid joining words)
    text = re.sub(r"[&@#%$!©®™°]+", " ", text)
    
    # Remove "Reply...", "Comment...", "(0)", etc at the end
    text = re.sub(r"\s*(Reply|Comment|Translate|PP|GP|iy|dy|ds|ie|Sl)\.{0,3}\s*\(?\d*\)?$", "", text, flags=re.IGNORECASE)
    
    # Remove patterns like "i)" "7" at the end
    text = re.sub(r"\s+[a-z]\)\s*\d*\s*$", "", text, flags=re.IGNORECASE)
    
    # Remove standalone punctuation
    text = re.sub(r"\s+[:;,.\-]+\s+", " ", text)
    
    # Normalize whitespace
    text = re.sub(r"\s+", " ", text).strip()
    
    return text


def parse_comments_replies(lines: List[str]) -> List[Tuple[str, str]]:
    """
    Parse OCR lines to extract (username, text) pairs
    
    Expected format:
    @username • X time ago
    Comment or reply text here
    (may span multiple lines)
    """
    results = []
    i = 0
    
    while i < len(lines):
        line = lines[i]
        
        # Skip noise
        if is_noise_line(line):
            i += 1
            continue
        
        # Look for author line (has username and time)
        if has_time_indicator(line):
            username = extract_username(line)
            
            if username:
                # Collect following lines as comment/reply text
                i += 1
                text_lines = []
                
                while i < len(lines):
                    next_line = lines[i]
                    
                    # Stop at next author line
                    if is_noise_line(next_line):
                        break
                    if has_time_indicator(next_line):
                        # Check if it has a username (new author line)
                        if extract_username(next_line):
                            break
                    
                    text_lines.append(next_line)
                    i += 1
                
                # Join and clean the text
                comment_text = " ".join(text_lines)
                comment_text = clean_text(comment_text)
                
                # Only add if we have actual text
                if comment_text and len(comment_text) >= 3:
                    results.append((username, comment_text))
                
                continue
        
        i += 1
    
    return results


def detect_like(img: Image.Image) -> bool:
    """Detect if like button is active (filled)"""
    img = downscale_image(img)
    w, h = img.size
    
    # Crop like button region
    x1 = int(w * LIKE_X1)
    x2 = int(w * LIKE_X2)
    y1 = int(h * LIKE_Y1)
    y2 = int(h * LIKE_Y2)
    
    like_region = img.crop((x1, y1, x2, y2))
    gray = cv2.cvtColor(np.array(like_region), cv2.COLOR_RGB2GRAY)
    
    # Calculate dark pixel ratio
    dark_pixels = np.sum(gray < DARK_THRESHOLD)
    total_pixels = gray.size
    dark_ratio = dark_pixels / total_pixels
    
    # If enough dark pixels, like is filled
    # Convert to native Python bool for JSON serialization
    return bool(dark_ratio >= LIKE_FILLED_THRESHOLD)


def are_texts_distinct(text1: str, text2: str) -> bool:
    """Check if two texts are meaningfully different"""
    t1 = text1.lower().strip()
    t2 = text2.lower().strip()
    
    if t1 == t2:
        return False
    
    # Word-based similarity
    words1 = set(t1.split())
    words2 = set(t2.split())
    
    if not words1 or not words2:
        return False
    
    overlap = len(words1 & words2)
    total = len(words1 | words2)
    similarity = overlap / total if total > 0 else 0
    
    # Less than 70% similar = distinct
    return similarity < 0.70


# ═══════════════════════════════════════════════════════════════════════════
#                                  ROUTES
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/", methods=["GET"])
def health():
    """Health check endpoint"""
    return jsonify({
        "ok": True,
        "tesseract_ok": TESSERACT_OK,
        "service": "YouTube Engagement Verifier"
    }), 200


@app.route("/analyze", methods=["POST"])
def analyze():
    """
    Verify YouTube engagement from screenshots
    
    Required files:
    - comment1: First comment screenshot
    - comment2: Second comment screenshot  
    - reply1: First reply screenshot
    - reply2: Second reply screenshot
    
    Optional files:
    - like: Like button screenshot
    
    Query params:
    - debug=1: Include debug information
    """
    
    debug = bool(int(request.args.get("debug", "0"))) or DEBUG
    
    # Check Tesseract
    if not TESSERACT_OK:
        return jsonify({
            "error": "tesseract_missing",
            "message": "Tesseract OCR is not installed or not reachable.",
            "details": TESSERACT_ERR
        }), 503
    
    # Check required files
    required = ["comment1", "comment2", "reply1", "reply2"]
    optional = ["like"]  # Like is optional
    missing = [k for k in required if k not in request.files]
    
    if missing:
        return jsonify({
            "verified": False,
            "error": "missing_screenshots",
            "message": f"Missing required screenshots: {', '.join(missing)}",
            "required": required,
            "optional": optional
        }), 400
    
    # Load images
    images = {}
    for key in required + ["like"]:
        if key in request.files:
            try:
                file_storage = request.files[key]
                file_storage.stream.seek(0)
                images[key] = Image.open(io.BytesIO(file_storage.read())).convert("RGB")
            except Exception as e:
                return jsonify({
                    "verified": False,
                    "error": "invalid_image",
                    "message": f"Failed to load image '{key}': {str(e)}"
                }), 400
    
    # Detect like button if provided
    liked = None
    if "like" in images:
        try:
            liked = detect_like(images["like"])
            # Ensure it's a native Python bool for JSON serialization
            if liked is not None:
                liked = bool(liked)
        except Exception as e:
            app.logger.error(f"Like detection failed: {e}")
            liked = None
    
    # Extract text from all screenshots
    extracted = {}
    debug_info = {}
    
    for key in required:
        try:
            lines = extract_text_lines(images[key])
            parsed = parse_comments_replies(lines)
            extracted[key] = parsed
            
            if debug:
                debug_info[key] = {
                    "lines": lines[:30],  # First 30 lines
                    "parsed_count": len(parsed),
                    "parsed": parsed
                }
        except Exception as e:
            app.logger.error(f"OCR failed for {key}: {e}")
            extracted[key] = []
            if debug:
                debug_info[key] = {"error": str(e)}
    
    # Group by username
    user_comments = defaultdict(list)
    user_replies = defaultdict(list)
    
    for username, text in extracted.get("comment1", []):
        user_comments[username].append(text)
    
    for username, text in extracted.get("comment2", []):
        user_comments[username].append(text)
    
    for username, text in extracted.get("reply1", []):
        user_replies[username].append(text)
    
    for username, text in extracted.get("reply2", []):
        user_replies[username].append(text)
    
    # Find all unique usernames
    all_users = set(user_comments.keys()) | set(user_replies.keys())
    
    if not all_users:
        return jsonify({
            "verified": False,
            "error": "no_username_found",
            "message": "Could not extract any username. Ensure screenshots clearly show @username and timestamp.",
            "user_id": None,
            "comments": [],
            "replies": [],
            "liked": liked,
            "debug": debug_info if debug else None
        }), 200
    
    # Score users by total items found
    user_scores = {}
    for user in all_users:
        score = len(user_comments.get(user, [])) + len(user_replies.get(user, []))
        user_scores[user] = score
    
    # Pick user with most items
    target_user = max(user_scores, key=user_scores.get)
    
    # Get comments and replies for target user
    comments = user_comments.get(target_user, [])
    replies = user_replies.get(target_user, [])
    
    # Remove duplicates while preserving order
    def dedupe(items):
        seen = set()
        result = []
        for item in items:
            if item not in seen:
                seen.add(item)
                result.append(item)
        return result
    
    comments = dedupe(comments)
    replies = dedupe(replies)
    
    # Verification checks
    reasons = []
    
    # Need at least 2 distinct comments
    if len(comments) < 2:
        reasons.append(f"Need 2 distinct comments from same user, found {len(comments)}")
    elif len(comments) >= 2:
        if not are_texts_distinct(comments[0], comments[1]):
            reasons.append("Comments are too similar, need distinct comments")
    
    # Need at least 2 distinct replies
    if len(replies) < 2:
        reasons.append(f"Need 2 distinct replies from same user, found {len(replies)}")
    elif len(replies) >= 2:
        if not are_texts_distinct(replies[0], replies[1]):
            reasons.append("Replies are too similar, need distinct replies")
    
    # Ensure comments differ from replies
    if len(comments) >= 2 and len(replies) >= 2:
        for c in comments[:2]:
            for r in replies[:2]:
                if not are_texts_distinct(c, r):
                    reasons.append("Comments and replies should be different from each other")
                    break
    
    verified = len(reasons) == 0
    
    # Build response matching the expected format
    response = {
        "verified": verified,
        "user_id": target_user,
        "comment": comments[:2] if len(comments) >= 2 else comments,  # Array of comments
        "replies": replies[:2] if len(replies) >= 2 else replies,      # Array of replies
        "liked": liked  # Will be None if not provided, True/False if checked
    }
    
    # Add debug info if requested
    if debug:
        response["debug"] = {
            "all_users": list(all_users),
            "user_scores": user_scores,
            "target_user": target_user,
            "comments_found": len(comments),
            "replies_found": len(replies),
            "all_comments": comments,
            "all_replies": replies,
            "extraction_details": debug_info
        }
    
    return jsonify(response), 200


@app.errorhandler(Exception)
def handle_exception(e):
    """Global exception handler"""
    code = e.code if isinstance(e, HTTPException) else 500
    app.logger.exception("Unhandled exception")
    return jsonify({
        "error": "internal_server_error" if code == 500 else "http_error",
        "status": code
    }), code


# ═══════════════════════════════════════════════════════════════════════════
#                                  MAIN
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("=" * 70)
    print("YouTube Engagement Verification API")
    print("=" * 70)
    print(f"Tesseract OK: {TESSERACT_OK}")
    if not TESSERACT_OK:
        print(f"Tesseract Error: {TESSERACT_ERR}")
    print(f"Port: {PORT}")
    print(f"Debug: {DEBUG}")
    print("=" * 70)
    
    app.run(host="0.0.0.0", port=PORT, debug=DEBUG)