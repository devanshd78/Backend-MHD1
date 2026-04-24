const crypto = require("crypto");
const multer = require("multer");
const sharp = require("sharp");
const mongoose = require("mongoose");
const { google } = require("googleapis");
const OpenAI = require("openai");

const Task = require("../models/likeTask");
const LikeLink = require("../models/likeLink");
const User = require("../models/User");


const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const badRequest = (res, msg) => res.status(400).json({ error: msg });
const notFound = (res, msg) => res.status(404).json({ error: msg });

const AUTH_WINDOW_SECONDS = 120;
const AUTH_WINDOW_MS = AUTH_WINDOW_SECONDS * 1000;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

function getOAuthClient() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
}

function signState(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto
        .createHmac("sha256", process.env.GOOGLE_STATE_SECRET)
        .update(body)
        .digest("hex");
    return `${body}.${sig}`;
}

function readState(state) {
    if (!state || !state.includes(".")) throw new Error("Invalid state");
    const [body, sig] = state.split(".");
    const expected = crypto
        .createHmac("sha256", process.env.GOOGLE_STATE_SECRET)
        .update(body)
        .digest("hex");

    if (sig !== expected) throw new Error("State verification failed");

    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}

function isLikeLinkExpired(linkDoc) {
    const expireAt = new Date(linkDoc.createdAt);
    expireAt.setHours(expireAt.getHours() + Number(linkDoc.expireIn || 0));
    return new Date() > expireAt;
}

function serializeTask(taskDoc) {
    const now = Date.now();
    const completed = (taskDoc.emailSlots || []).filter((x) => x.verified);
    const active = (taskDoc.emailSlots || []).find(
        (x) => !x.verified && x.authExpiresAt && new Date(x.authExpiresAt).getTime() > now
    );

    return {
        taskId: taskDoc.taskId,
        userId: taskDoc.userId,
        likeLinkId: String(taskDoc.likeLinkId),
        amount: Number(taskDoc.amount || 0),
        status: taskDoc.status ?? null,
        completedCount: completed.length,
        completedEmails: completed.map((x) => x.email),
        activeEmail: active ? active.email : null,
        activeAuthExpiresAt: active ? active.authExpiresAt : null,
        authWindowSeconds: taskDoc.authWindowSeconds,
        locked: completed.length >= taskDoc.maxEmailsAllowed,
    };
}

function escapeHtml(str = "") {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function sendPopupError(res, message) {
    res.status(400).set("Content-Type", "text/html");
    res.send(`
    <!doctype html>
    <html>
      <body style="font-family: Arial, sans-serif; padding: 24px;">
        <h3>Authentication failed</h3>
        <p>${escapeHtml(message)}</p>
        <script>
          try {
            if (window.opener) {
              window.opener.postMessage(
                { type: "LIKE_TASK_AUTH_ERROR", message: ${JSON.stringify(message)} },
                "*"
              );
            }
          } catch (e) {}
        </script>
      </body>
    </html>
  `);
}

async function buildNormalizedImageHash(buffer) {
    const normalized = await sharp(buffer)
        .rotate()
        .resize(512, 512, {
            fit: "inside",
            withoutEnlargement: true,
        })
        .grayscale()
        .png()
        .toBuffer();

    return crypto.createHash("sha256").update(normalized).digest("hex");
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

async function cropRelative(buffer, box) {
    const meta = await sharp(buffer).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;

    const left = clamp(Math.round(width * box.left), 0, Math.max(width - 1, 0));
    const top = clamp(Math.round(height * box.top), 0, Math.max(height - 1, 0));
    const cropWidth = clamp(Math.round(width * box.width), 1, Math.max(width - left, 1));
    const cropHeight = clamp(Math.round(height * box.height), 1, Math.max(height - top, 1));

    return sharp(buffer)
        .extract({
            left,
            top,
            width: cropWidth,
            height: cropHeight,
        })
        .png()
        .toBuffer();
}

async function toGrayRaw(buffer) {
    return sharp(buffer)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
}

function meanRawRegion(raw, info, relBox) {
    const width = info.width;
    const height = info.height;
    const channels = info.channels;

    const left = clamp(Math.floor(width * relBox.left), 0, width - 1);
    const top = clamp(Math.floor(height * relBox.top), 0, height - 1);
    const right = clamp(Math.ceil(width * (relBox.left + relBox.width)), left + 1, width);
    const bottom = clamp(Math.ceil(height * (relBox.top + relBox.height)), top + 1, height);

    let sum = 0;
    let count = 0;

    for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
            const idx = (y * width + x) * channels;
            sum += raw[idx];
            count += 1;
        }
    }

    return count ? sum / count : 0;
}

function isPortraitMeta(meta) {
    const w = Number(meta?.width || 0);
    const h = Number(meta?.height || 0);
    return w > 0 && h > 0 && h / w >= 1.45;
}

async function buildPhoneLikeIconCandidates(buffer) {
    // Tuned for the mobile screenshots you uploaded.
    // These crop the actual thumbs-up icon area directly.
    return Promise.all([
        cropRelative(buffer, { left: 0.381, top: 0.387, width: 0.110, height: 0.051 }),
        cropRelative(buffer, { left: 0.386, top: 0.389, width: 0.102, height: 0.047 }),
        cropRelative(buffer, { left: 0.389, top: 0.391, width: 0.098, height: 0.045 }),
        cropRelative(buffer, { left: 0.377, top: 0.384, width: 0.114, height: 0.053 }),
        cropRelative(buffer, { left: 0.395, top: 0.392, width: 0.094, height: 0.043 }),
    ]);
}

async function buildDesktopLikeChipCandidates(buffer) {
    // Preserves your desktop / wider screenshot flow.
    return Promise.all([
        cropRelative(buffer, { left: 0.02, top: 0.68, width: 0.28, height: 0.09 }),
        cropRelative(buffer, { left: 0.02, top: 0.70, width: 0.26, height: 0.085 }),
        cropRelative(buffer, { left: 0.02, top: 0.72, width: 0.24, height: 0.08 }),
        cropRelative(buffer, { left: 0.02, top: 0.725, width: 0.22, height: 0.08 }),
        cropRelative(buffer, { left: 0.40, top: 0.38, width: 0.24, height: 0.10 }),
    ]);
}

async function buildLikeChipCandidates(buffer) {
    const meta = await sharp(buffer).metadata();
    return isPortraitMeta(meta)
        ? buildPhoneLikeIconCandidates(buffer)
        : buildDesktopLikeChipCandidates(buffer);
}

function getCornerBackgroundMean(gray) {
    const corners = [
        ...gray.slice(0, 8).flatMap((row) => row.slice(0, 8)),
        ...gray.slice(0, 8).flatMap((row) => row.slice(-8)),
        ...gray.slice(-8).flatMap((row) => row.slice(0, 8)),
        ...gray.slice(-8).flatMap((row) => row.slice(-8)),
    ];
    return corners.reduce((a, b) => a + b, 0) / Math.max(corners.length, 1);
}

async function scorePhoneLikeIcon(chipBuffer) {
    // Normalize icon crop to fixed size for stable scoring.
    const { data, info } = await sharp(chipBuffer)
        .resize(64, 64, { fit: "fill" })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;
    const channels = info.channels;

    const gray = [];
    for (let y = 0; y < height; y++) {
        const row = [];
        for (let x = 0; x < width; x++) {
            row.push(data[(y * width + x) * channels]);
        }
        gray.push(row);
    }

    const bg = getCornerBackgroundMean(gray);
    const threshold = 24;

    let totalFg = 0;
    let palmFg = 0;
    let tipFg = 0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const isFg = Math.abs(gray[y][x] - bg) > threshold ? 1 : 0;
            totalFg += isFg;

            // Palm region
            if (x >= 22 && x < 46 && y >= 20 && y < 44) {
                palmFg += isFg;
            }

            // Tip / upper thumb region
            if (x >= 30 && x < 52 && y >= 10 && y < 24) {
                tipFg += isFg;
            }
        }
    }

    const score = totalFg + palmFg * 1.3 + tipFg * 0.4;

    if (score >= 570 && totalFg >= 330 && palmFg >= 180) {
        return {
            state: "liked",
            liked: true,
            confidence: Math.min(0.99, 0.84 + Math.min((score - 570) / 220, 0.10)),
            reason: "Filled thumbs-up icon detected",
            debug: { bg, totalFg, palmFg, tipFg, score },
        };
    }

    if (score <= 545 && totalFg <= 315 && palmFg <= 172) {
        return {
            state: "not_liked",
            liked: false,
            confidence: Math.min(0.99, 0.84 + Math.min((545 - score) / 180, 0.10)),
            reason: "Outlined thumbs-up icon detected",
            debug: { bg, totalFg, palmFg, tipFg, score },
        };
    }

    return {
        state: "unclear",
        liked: false,
        confidence: 0.35,
        reason: "Thumb icon state is inconclusive",
        debug: { bg, totalFg, palmFg, tipFg, score },
    };
}

async function scoreDesktopLikeChip(chipBuffer) {
    // Keeps your original desktop-style logic.
    const iconBuffer = await sharp(chipBuffer)
        .extract({
            left: 0,
            top: 0,
            width: Math.max(1, Math.round((await sharp(chipBuffer).metadata()).width * 0.28)),
            height: Math.max(1, Math.round((await sharp(chipBuffer).metadata()).height)),
        })
        .png()
        .toBuffer();

    const { data, info } = await toGrayRaw(iconBuffer);

    const bg = meanRawRegion(data, info, {
        left: 0.02,
        top: 0.58,
        width: 0.16,
        height: 0.22,
    });

    const stroke = meanRawRegion(data, info, {
        left: 0.58,
        top: 0.58,
        width: 0.17,
        height: 0.20,
    });

    const palm = meanRawRegion(data, info, {
        left: 0.28,
        top: 0.45,
        width: 0.24,
        height: 0.23,
    });

    const strokeDelta = stroke - bg;
    const palmDelta = palm - bg;
    const strokeContrast = Math.abs(strokeDelta);
    const sameDirection =
        Math.sign(strokeDelta || 0) === Math.sign(palmDelta || 0) &&
        Math.sign(strokeDelta || 0) !== 0;

    if (strokeContrast < 20) {
        return {
            state: "unclear",
            liked: false,
            confidence: 0,
            reason: "Like icon contrast too low in this crop",
            debug: { bg, stroke, palm, strokeDelta, palmDelta, strokeContrast },
        };
    }

    const fillRatio = Math.abs(palmDelta) / Math.max(strokeContrast, 1);

    if (sameDirection && fillRatio >= 0.42) {
        return {
            state: "liked",
            liked: true,
            confidence: Math.min(0.99, 0.7 + (fillRatio - 0.42) * 0.9),
            reason: "Thumb inner palm area is filled like the icon stroke",
            debug: { bg, stroke, palm, strokeDelta, palmDelta, strokeContrast, fillRatio },
        };
    }

    if (!sameDirection || fillRatio <= 0.32) {
        return {
            state: "not_liked",
            liked: false,
            confidence: Math.min(0.99, 0.72 + (0.32 - Math.min(fillRatio, 0.32)) * 1.2),
            reason: "Thumb inner palm area matches the chip background instead of the icon stroke",
            debug: { bg, stroke, palm, strokeDelta, palmDelta, strokeContrast, fillRatio },
        };
    }

    return {
        state: "unclear",
        liked: false,
        confidence: 0.4,
        reason: "Fill level is between liked and not-liked thresholds",
        debug: { bg, stroke, palm, strokeDelta, palmDelta, strokeContrast, fillRatio },
    };
}

async function verifyYoutubeLikeWithVisionFallback(fullBuffer, candidateChips, isPortrait) {
    const fullBase64 = fullBuffer.toString("base64");
    const chipPayload = (candidateChips || []).slice(0, 4).map((b) => ({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${b.toString("base64")}` },
    }));

    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
            {
                role: "system",
                content: `
You are verifying whether a YouTube Like button is selected.

Rules:
1. Focus ONLY on the thumbs-up button.
2. "liked" means the thumb icon is filled/solid.
3. "not_liked" means the thumb icon is outlined/hollow.
4. This must work for both dark mode and light mode.
5. For mobile screenshots, decide mainly from the cropped thumb images.
6. Ignore Subscribe, Comments count, Shorts cards, Share, More, overlays, ads, and video content.
7. If uncertain, return "unclear".

Return only JSON:
{
  "state": "liked" | "not_liked" | "unclear",
  "confidence": 0.0,
  "reason": "short reason"
}
                `.trim(),
            },
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: isPortrait
                            ? "These are phone screenshots. Decide whether the mobile YouTube Like button is selected."
                            : "These are desktop or wide screenshots. Decide whether the YouTube Like button is selected.",
                    },
                    {
                        type: "image_url",
                        image_url: {
                            url: `data:image/png;base64,${fullBase64}`,
                        },
                    },
                    ...chipPayload,
                ],
            },
        ],
    });

    let parsed = {
        state: "unclear",
        confidence: 0,
        reason: "Unable to verify",
    };

    try {
        parsed = JSON.parse(response.choices?.[0]?.message?.content || "{}");
    } catch (_) { }

    const state = ["liked", "not_liked", "unclear"].includes(parsed.state)
        ? parsed.state
        : "unclear";

    return {
        state,
        liked: state === "liked",
        confidence: Number(parsed.confidence || 0),
        reason: String(parsed.reason || "Unable to verify"),
    };
}

async function verifyYoutubeLikeFromScreenshot(buffer) {
    const meta = await sharp(buffer).metadata();
    const isPortrait = isPortraitMeta(meta);
    const candidates = await buildLikeChipCandidates(buffer);

    const scored = [];
    for (const chip of candidates) {
        const result = isPortrait
            ? await scorePhoneLikeIcon(chip)
            : await scoreDesktopLikeChip(chip);
        scored.push({ chip, result });
    }

    if (isPortrait) {
        scored.sort((a, b) => (b.result?.confidence || 0) - (a.result?.confidence || 0));
        const best = scored[0];

        // For phone screenshots trust local icon reading first.
        if (best && (best.result.state === "liked" || best.result.state === "not_liked") && best.result.confidence >= 0.82) {
            return best.result;
        }

        const fallback = await verifyYoutubeLikeWithVisionFallback(
            buffer,
            candidates.slice(0, 4),
            true
        );

        if (fallback.state !== "unclear" && fallback.confidence >= 0.92) {
            return fallback;
        }

        return {
            state: "unclear",
            liked: false,
            confidence: 0,
            reason: best?.result?.reason || fallback?.reason || "Like state could not be verified",
        };
    }

    // Desktop / wide screenshot logic
    scored.sort((a, b) => {
        const ac = a.result?.debug?.strokeContrast || 0;
        const bc = b.result?.debug?.strokeContrast || 0;
        return bc - ac;
    });

    const best = scored[0];

    if (best && best.result.state !== "unclear" && best.result.confidence >= 0.7) {
        return best.result;
    }

    const fallback = await verifyYoutubeLikeWithVisionFallback(
        buffer,
        candidates.slice(0, 4),
        false
    );

    if (fallback.state !== "unclear" && fallback.confidence >= 0.88) {
        return fallback;
    }

    return {
        state: "unclear",
        liked: false,
        confidence: 0,
        reason: best?.result?.reason || fallback?.reason || "Like state could not be verified",
    };
}

async function findOrCreateTask(userId, likeLinkId) {
    let task = await Task.findOne({ userId, likeLinkId });

    if (!task) {
        task = await Task.create({
            userId,
            likeLinkId,
            maxEmailsAllowed: 5,
            authWindowSeconds: AUTH_WINDOW_SECONDS,
            emailSlots: [],
        });
    }

    return task;
}

exports.uploadScreenshot = upload.single("screenshot");

exports.getTaskStatuses = asyncHandler(async (req, res) => {
    const { userId } = req.query;
    if (!userId) return badRequest(res, "userId required");

    const tasks = await Task.find({ userId }).lean();
    res.json({
        tasks: tasks.map(serializeTask),
    });
});

exports.getOrCreateTask = asyncHandler(async (req, res) => {
    const { userId, likeLinkId } = req.body;
    if (!userId || !likeLinkId) return badRequest(res, "userId and likeLinkId are required");

    if (!mongoose.Types.ObjectId.isValid(likeLinkId)) {
        return badRequest(res, "Invalid likeLinkId");
    }

    const likeLink = await LikeLink.findById(likeLinkId).lean();
    if (!likeLink) return notFound(res, "Like link not found");
    if (isLikeLinkExpired(likeLink)) return badRequest(res, "Like task has expired");

    const task = await findOrCreateTask(String(userId), likeLinkId);
    res.json({ task: serializeTask(task) });
});

exports.startGoogleAuth = asyncHandler(async (req, res) => {
    const { userId, likeLinkId } = req.query;

    if (!userId || !likeLinkId) {
        return sendPopupError(res, "userId and likeLinkId are required");
    }

    if (!mongoose.Types.ObjectId.isValid(likeLinkId)) {
        return sendPopupError(res, "Invalid likeLinkId");
    }

    const likeLink = await LikeLink.findById(likeLinkId).lean();
    if (!likeLink) return sendPopupError(res, "Like link not found");
    if (!likeLink.videoUrl) return sendPopupError(res, "videoUrl is missing for this like task");
    if (isLikeLinkExpired(likeLink)) return sendPopupError(res, "Like task has expired");

    const task = await findOrCreateTask(String(userId), likeLinkId);

    const activePending = (task.emailSlots || []).find(
        (x) => !x.verified && x.authExpiresAt && new Date(x.authExpiresAt).getTime() > Date.now()
    );

    if (activePending) {
        return sendPopupError(
            res,
            `Complete the current authenticated email first: ${activePending.email}`
        );
    }

    const completedCount = (task.emailSlots || []).filter((x) => x.verified).length;
    if (completedCount >= 5) {
        return sendPopupError(res, "All 5 email slots are already completed");
    }

    const state = signState({
        taskId: task.taskId,
        userId: String(userId),
        likeLinkId: String(likeLinkId),
        ts: Date.now(),
    });

    const oauth2Client = getOAuthClient();

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "select_account",
        scope: ["openid", "email", "profile"],
        state,
    });

    res.redirect(authUrl);
});

function buildYoutubeOpenUrl(videoUrl) {
    try {
        return new URL(videoUrl).toString();
    } catch (err) {
        return String(videoUrl || "");
    }
}

exports.googleCallback = asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) return sendPopupError(res, "Missing Google callback data");

    let parsedState;
    try {
        parsedState = readState(state);
    } catch (err) {
        return sendPopupError(res, err.message || "Invalid state");
    }

    const { taskId, userId, likeLinkId } = parsedState;

    const task = await Task.findOne({ taskId, userId, likeLinkId });
    if (!task) return sendPopupError(res, "Task not found");

    const likeLink = await LikeLink.findById(likeLinkId).lean();
    if (!likeLink) return sendPopupError(res, "Like link not found");
    if (!likeLink.videoUrl) return sendPopupError(res, "videoUrl missing");
    if (isLikeLinkExpired(likeLink)) return sendPopupError(res, "Like task expired");

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const ticket = await oauth2Client.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = String(payload.email || "").trim().toLowerCase();
    const googleSub = String(payload.sub || "").trim();

    if (!email || !googleSub) {
        return sendPopupError(res, "Unable to read authenticated Google account");
    }

    const existingVerified = task.emailSlots.find(
        (x) => x.email === email && x.verified === true
    );
    if (existingVerified) {
        return sendPopupError(res, "This email already completed this task");
    }

    const allUniqueEmails = new Set(task.emailSlots.map((x) => x.email));
    const emailAlreadyExists = allUniqueEmails.has(email);

    if (!emailAlreadyExists && task.emailSlots.length >= task.maxEmailsAllowed) {
        return sendPopupError(res, "Only 5 different emails are allowed for this task");
    }

    const now = new Date();
    const authExpiresAt = new Date(now.getTime() + AUTH_WINDOW_MS);

    const existingPendingIndex = task.emailSlots.findIndex(
        (x) => x.email === email && x.verified !== true
    );

    if (existingPendingIndex >= 0) {
        task.emailSlots[existingPendingIndex] = {
            ...task.emailSlots[existingPendingIndex],
            email,
            googleSub,
            authAt: now,
            authExpiresAt,
            screenshotHash: null,
            submittedAt: null,
            verificationReason: "",
            verified: false,
        };
    } else {
        task.emailSlots.push({
            email,
            googleSub,
            authAt: now,
            authExpiresAt,
            screenshotHash: null,
            submittedAt: null,
            verificationReason: "",
            verified: false,
        });
    }

    await task.save();

    const frontendOrigin = new URL(process.env.FRONTEND_URL).origin;
    const youtubeOpenUrl = buildYoutubeOpenUrl(likeLink.videoUrl);

    res.set("Content-Type", "text/html");
    res.send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Redirecting...</title>
  </head>
  <body style="font-family: Arial, sans-serif; padding: 24px;">
    <p>Authentication successful. Redirecting to YouTube with the selected Google account...</p>
    <script>
      (function () {
        var payload = {
          type: "LIKE_TASK_AUTH_SUCCESS",
          taskId: ${JSON.stringify(task.taskId)},
          likeLinkId: ${JSON.stringify(String(likeLink._id))},
          email: ${JSON.stringify(email)},
          authExpiresAt: ${JSON.stringify(authExpiresAt.toISOString())}
        };

        try {
          if (window.opener) {
            window.opener.postMessage(payload, ${JSON.stringify(frontendOrigin)});
          }
        } catch (e) {}

        window.location.replace(${JSON.stringify(youtubeOpenUrl)});
      })();
    </script>
  </body>
</html>
`);
});

exports.submitScreenshotAndVerify = asyncHandler(async (req, res) => {
    const { userId, likeLinkId, taskId } = req.body;
    const file = req.file;

    if (!userId || !likeLinkId || !taskId) {
        return badRequest(res, "userId, likeLinkId and taskId are required");
    }

    if (!file || !file.buffer) {
        return badRequest(res, "screenshot file is required");
    }

    const task = await Task.findOne({ taskId, userId, likeLinkId });
    if (!task) return notFound(res, "Task not found");

    const likeLink = await LikeLink.findById(likeLinkId).lean();
    if (!likeLink) return notFound(res, "Like link not found");
    if (isLikeLinkExpired(likeLink)) return badRequest(res, "Like task has expired");

    const now = Date.now();
    const activeSlotIndex = task.emailSlots.findIndex(
        (x) => !x.verified && x.authExpiresAt && new Date(x.authExpiresAt).getTime() > now
    );

    if (activeSlotIndex < 0) {
        return badRequest(res, "No active authenticated email found or timer expired");
    }

    const imageHash = await buildNormalizedImageHash(file.buffer);

    const duplicateHash = await Task.exists({
        "emailSlots.screenshotHash": imageHash,
    });

    if (duplicateHash) {
        return badRequest(res, "This screenshot has already been used");
    }

    const verification = await verifyYoutubeLikeFromScreenshot(file.buffer);

    if (verification.state === "not_liked") {
        return res.status(400).json({
            error: "Like button is not selected in the screenshot",
            verification,
        });
    }

    if (verification.state !== "liked") {
        return res.status(400).json({
            error: "Like button could not be verified from the screenshot",
            verification,
        });
    }

    task.emailSlots[activeSlotIndex].screenshotHash = imageHash;
    task.emailSlots[activeSlotIndex].submittedAt = new Date();
    task.emailSlots[activeSlotIndex].verified = true;
    task.emailSlots[activeSlotIndex].verificationReason = verification.reason;
    task.emailSlots[activeSlotIndex].authExpiresAt = new Date();

    await task.save();

    const serialized = serializeTask(task);

    res.json({
        message: "Screenshot verified successfully",
        email: task.emailSlots[activeSlotIndex].email,
        task: serialized,
        verification,
    });
});


exports.getLikeLinkEntries = asyncHandler(async (req, res) => {
    const { linkId } = req.body;

    if (!linkId) {
        return badRequest(res, "linkId is required");
    }

    if (!mongoose.Types.ObjectId.isValid(linkId)) {
        return badRequest(res, "Invalid linkId");
    }

    const likeLink = await LikeLink.findById(linkId).lean();
    if (!likeLink) return notFound(res, "Like link not found");

    const tasks = await Task.find({ likeLinkId: linkId })
        .sort({ createdAt: -1 })
        .lean();

    const userIds = [...new Set(tasks.map((t) => t.userId).filter(Boolean))];

    const users = await User.find({ userId: { $in: userIds } })
        .select("userId name email phone")
        .lean();

    const userMap = users.reduce((acc, user) => {
        acc[user.userId] = user;
        return acc;
    }, {});

    const entries = tasks.map((task) => {
        const emailSlots = Array.isArray(task.emailSlots) ? task.emailSlots : [];
        const verifiedSlots = emailSlots.filter((slot) => slot.verified);
        const pendingSlots = emailSlots.filter((slot) => !slot.verified);

        return {
            _id: task._id,
            taskId: task.taskId,
            userId: task.userId,
            user: userMap[task.userId] || null,
            likeLinkId: task.likeLinkId,
            amount: Number(task.amount || 0),
            status: task.status ?? null,
            maxEmailsAllowed: task.maxEmailsAllowed,
            authWindowSeconds: task.authWindowSeconds,
            completedCount: verifiedSlots.length,
            pendingCount: pendingSlots.length,
            emailSlots: emailSlots.map((slot) => ({
                email: slot.email,
                googleSub: slot.googleSub,
                authAt: slot.authAt,
                authExpiresAt: slot.authExpiresAt,
                submittedAt: slot.submittedAt,
                verified: slot.verified,
                verificationReason: slot.verificationReason,
            })),
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
        };
    });

    res.json({
        likeLink: {
            _id: likeLink._id,
            title: likeLink.title,
            videoUrl: likeLink.videoUrl,
            target: likeLink.target,
            amount: likeLink.amount,
            expireIn: likeLink.expireIn,
            requireLike: likeLink.requireLike,
            createdAt: likeLink.createdAt,
        },
        totalEntries: entries.length,
        entries,
    });
});