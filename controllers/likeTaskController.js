const crypto = require("crypto");
const multer = require("multer");
const mongoose = require("mongoose");
const { google } = require("googleapis");

const Task = require("../models/likeTask");
const LikeLink = require("../models/likeLink");
const User = require("../models/User");

const asyncHandler = (fn) =>
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const badRequest = (res, msg) => res.status(400).json({ error: msg });
const notFound = (res, msg) => res.status(404).json({ error: msg });

const AUTH_WINDOW_SECONDS = 120;
const AUTH_WINDOW_MS = AUTH_WINDOW_SECONDS * 1000;

const YOUTUBE_RATING_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

const LIKE_DETECTED_MESSAGE = "Like detected";
const LIKE_NOT_DETECTED_MESSAGE = "Like not detected";
const DUPLICATE_EMAIL_MESSAGE = "Duplicate email detected";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
});

function getOAuthClient() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
}

function normalizeEmail(email = "") {
    return String(email || "").trim().toLowerCase();
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
    if (!state || !state.includes(".")) {
        throw new Error("Invalid state");
    }

    const [body, sig] = state.split(".");

    const expected = crypto
        .createHmac("sha256", process.env.GOOGLE_STATE_SECRET)
        .update(body)
        .digest("hex");

    if (sig !== expected) {
        throw new Error("State verification failed");
    }

    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}
function getMaxEmailsAllowedFromLikeLink(likeLink) {
    const target = Math.floor(Number(likeLink?.target || 0));
    return Number.isFinite(target) && target > 0 ? target : 1;
}
function isLikeLinkExpired(linkDoc) {
    const expireAt = new Date(linkDoc.createdAt);
    expireAt.setHours(expireAt.getHours() + Number(linkDoc.expireIn || 0));

    return new Date() > expireAt;
}

function getMaxEmailsAllowedFromLikeLink(likeLink) {
    const target = Math.floor(Number(likeLink?.target || 0));
    return Number.isFinite(target) && target > 0 ? target : 1;
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
            {
              type: "LIKE_TASK_AUTH_ERROR",
              message: ${JSON.stringify(message)}
            },
            "*"
          );
        }
      } catch (e) {}
    </script>
  </body>
</html>
`);
}

function extractYouTubeVideoId(videoUrl = "") {
    try {
        const url = new URL(String(videoUrl));
        const hostname = url.hostname.replace(/^www\./, "").toLowerCase();

        if (hostname === "youtu.be") {
            return url.pathname.split("/").filter(Boolean)[0] || "";
        }

        if (
            hostname === "youtube.com" ||
            hostname === "m.youtube.com" ||
            hostname === "music.youtube.com"
        ) {
            if (url.pathname === "/watch") {
                return url.searchParams.get("v") || "";
            }

            const parts = url.pathname.split("/").filter(Boolean);

            if (["shorts", "embed", "live"].includes(parts[0]) && parts[1]) {
                return parts[1];
            }
        }

        return "";
    } catch (_) {
        return "";
    }
}

async function findVerifiedEmailUsage(likeLinkId, email, excludeTaskMongoId = null) {
    const query = {
        likeLinkId,
        emailSlots: {
            $elemMatch: {
                email: normalizeEmail(email),
                verified: true,
            },
        },
    };

    if (excludeTaskMongoId) {
        query._id = { $ne: excludeTaskMongoId };
    }

    return Task.findOne(query)
        .select("_id taskId userId likeLinkId")
        .lean();
}

function buildOAuthClientFromSlot(slot = {}) {
    const oauth2Client = getOAuthClient();

    const credentials = {};

    if (slot.accessToken) {
        credentials.access_token = slot.accessToken;
    }

    if (slot.refreshToken) {
        credentials.refresh_token = slot.refreshToken;
    }

    if (slot.tokenExpiryDate) {
        credentials.expiry_date = new Date(slot.tokenExpiryDate).getTime();
    }

    if (!credentials.access_token && !credentials.refresh_token) {
        throw new Error("YouTube OAuth token missing for this email");
    }

    oauth2Client.setCredentials(credentials);

    return oauth2Client;
}

async function verifyYoutubeLikeByApi(slot, videoUrl) {
    const videoId = extractYouTubeVideoId(videoUrl);

    if (!videoId) {
        return {
            state: "not_liked",
            liked: false,
            confidence: 0,
            message: LIKE_NOT_DETECTED_MESSAGE,
            reason: "Invalid YouTube video URL",
            videoId: "",
            rating: "none",
            youtubeApiResponse: null,
        };
    }

    const oauth2Client = buildOAuthClientFromSlot(slot);

    const youtube = google.youtube({
        version: "v3",
        auth: oauth2Client,
    });

    let response;

    try {
        response = await youtube.videos.getRating({
            id: videoId,
        });
    } catch (err) {
        console.error("YouTube getRating error:", {
            message: err?.message,
            status: err?.response?.status,
            data: err?.response?.data,
        });

        throw err;
    }

    const rating = String(response.data?.items?.[0]?.rating || "none").toLowerCase();

    const liked = rating === "like";

    return {
        state: liked ? "liked" : "not_liked",
        liked,
        confidence: 1,
        message: liked ? LIKE_DETECTED_MESSAGE : LIKE_NOT_DETECTED_MESSAGE,
        reason: liked
            ? "YouTube API returned rating=like for the authenticated email"
            : `YouTube API returned rating=${rating || "none"} for the authenticated email`,
        videoId,
        rating,
        youtubeApiResponse: response.data || null,
    };
}

async function findOrCreateTask(userId, likeLinkId, maxEmailsAllowed) {
    let task = await Task.findOne({ userId, likeLinkId });

    if (!task) {
        task = await Task.create({
            userId,
            likeLinkId,
            maxEmailsAllowed,
            authWindowSeconds: AUTH_WINDOW_SECONDS,
            emailSlots: [],
        });

        return task;
    }

    if (Number(task.maxEmailsAllowed) !== Number(maxEmailsAllowed)) {
        task.maxEmailsAllowed = maxEmailsAllowed;
        await task.save();
    }

    return task;
}

function buildYoutubeOpenUrl(videoUrl, email) {
    try {
        let targetUrl = new URL(videoUrl);

        if (targetUrl.hostname === "youtu.be") {
            const videoId = targetUrl.pathname.slice(1);
            targetUrl = new URL(`https://www.youtube.com/watch?v=${videoId}`);
        }

        if (targetUrl.hostname === "youtube.com") {
            targetUrl.hostname = "www.youtube.com";
        }

        const chooserUrl = new URL("https://accounts.google.com/AccountChooser");

        chooserUrl.searchParams.set("continue", targetUrl.toString());
        chooserUrl.searchParams.set("Email", normalizeEmail(email));

        return chooserUrl.toString();
    } catch (e) {
        return String(videoUrl || "");
    }
}

exports.uploadScreenshot = upload.single("screenshot");

exports.getTaskStatuses = asyncHandler(async (req, res) => {
    const { userId } = req.query;

    if (!userId) {
        return badRequest(res, "userId required");
    }

    const tasks = await Task.find({ userId }).lean();

    const likeLinkIds = [
        ...new Set(tasks.map((task) => String(task.likeLinkId)).filter(Boolean)),
    ];

    const likeLinks = await LikeLink.find({ _id: { $in: likeLinkIds } })
        .select("_id target")
        .lean();

    const likeLinkMap = likeLinks.reduce((acc, link) => {
        acc[String(link._id)] = link;
        return acc;
    }, {});

    res.json({
        tasks: tasks.map((task) =>
            serializeTask(task, likeLinkMap[String(task.likeLinkId)] || null)
        ),
    });
});

exports.getOrCreateTask = asyncHandler(async (req, res) => {
    const { userId, likeLinkId } = req.body;

    if (!userId || !likeLinkId) {
        return badRequest(res, "userId and likeLinkId are required");
    }

    if (!mongoose.Types.ObjectId.isValid(likeLinkId)) {
        return badRequest(res, "Invalid likeLinkId");
    }

    const likeLink = await LikeLink.findById(likeLinkId).lean();

    if (!likeLink) {
        return notFound(res, "Like link not found");
    }

    if (isLikeLinkExpired(likeLink)) {
        return badRequest(res, "Like task has expired");
    }

    const task = await findOrCreateTask(String(userId), likeLinkId, likeLink);

    res.json({
        task: serializeTask(task, likeLink),
    });
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

    if (!likeLink) {
        return sendPopupError(res, "Like link not found");
    }

    if (!likeLink.videoUrl) {
        return sendPopupError(res, "videoUrl is missing for this like task");
    }

    if (isLikeLinkExpired(likeLink)) {
        return sendPopupError(res, "Like task has expired");
    }

    const task = await findOrCreateTask(String(userId), likeLinkId);

    const activePending = (task.emailSlots || []).find(
        (x) =>
            !x.verified &&
            x.authExpiresAt &&
            new Date(x.authExpiresAt).getTime() > Date.now()
    );

    if (activePending) {
        return sendPopupError(
            res,
            `Complete the current authenticated email first: ${activePending.email}`
        );
    }

    const completedCount = (task.emailSlots || []).filter((x) => x.verified).length;

    if (completedCount >= maxEmailsAllowed) {
        return sendPopupError(
            res,
            `All ${maxEmailsAllowed} email slots are already completed`
        );
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
        prompt: "consent select_account",
        scope: ["openid", "email", "profile", YOUTUBE_RATING_SCOPE],
        state,
    });

    res.redirect(authUrl);
});

exports.googleCallback = asyncHandler(async (req, res) => {
    const { code, state } = req.query;

    if (!code || !state) {
        return sendPopupError(res, "Missing Google callback data");
    }

    let parsedState;

    try {
        parsedState = readState(state);
    } catch (err) {
        return sendPopupError(res, err.message || "Invalid state");
    }

    const { taskId, userId, likeLinkId } = parsedState;

    const task = await findOrCreateTask(String(userId), likeLinkId, likeLink);
    const maxEmailsAllowed = getMaxEmailsAllowedFromLikeLink(likeLink);

    if (!task) {
        return sendPopupError(res, "Task not found");
    }

    const likeLink = await LikeLink.findById(likeLinkId).lean();

    if (!likeLink) {
        return sendPopupError(res, "Like link not found");
    }

    task.maxEmailsAllowed = maxEmailsAllowed;

    if (!likeLink.videoUrl) {
        return sendPopupError(res, "videoUrl missing");
    }

    if (isLikeLinkExpired(likeLink)) {
        return sendPopupError(res, "Like task expired");
    }

    const oauth2Client = getOAuthClient();

    const { tokens } = await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);

    const ticket = await oauth2Client.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    const email = normalizeEmail(payload.email);
    const googleSub = String(payload.sub || "").trim();

    if (!email || !googleSub) {
        return sendPopupError(res, "Unable to read authenticated Google account");
    }

    const existingVerified = (task.emailSlots || []).find(
        (x) => normalizeEmail(x.email) === email && x.verified === true
    );

    if (existingVerified) {
        return sendPopupError(res, DUPLICATE_EMAIL_MESSAGE);
    }

    const duplicateVerifiedEmail = await findVerifiedEmailUsage(
        likeLinkId,
        email,
        task._id
    );

    if (duplicateVerifiedEmail) {
        return sendPopupError(res, DUPLICATE_EMAIL_MESSAGE);
    }

    const nowMs = Date.now();

    task.emailSlots = (task.emailSlots || []).filter((slot) => {
        const slotEmail = normalizeEmail(slot.email);
        const isVerified = slot.verified === true;

        const isActivePending =
            !isVerified &&
            slot.authExpiresAt &&
            new Date(slot.authExpiresAt).getTime() > nowMs;

        return isVerified || isActivePending || slotEmail === email;
    });

    const usedEmails = new Set(
        task.emailSlots.map((x) => normalizeEmail(x.email)).filter(Boolean)
    );

    const emailAlreadyExists = usedEmails.has(email);

    if (!emailAlreadyExists && usedEmails.size >= maxEmailsAllowed) {
        return sendPopupError(
            res,
            `Only ${maxEmailsAllowed} different emails are allowed for this task`
        );
    }

    const now = new Date();
    const authExpiresAt = new Date(now.getTime() + AUTH_WINDOW_MS);

    const existingPendingIndex = task.emailSlots.findIndex(
        (x) => normalizeEmail(x.email) === email && x.verified !== true
    );

    const slotData = {
        email,
        googleSub,
        authAt: now,
        authExpiresAt,
        screenshotHash: null,
        submittedAt: null,
        verified: false,
        verificationReason: "",
        verificationMessage: "",
        verifiedBy: "youtube_api",
        videoId: "",
        youtubeRating: "",
        youtubeApiResponse: null,
        accessToken: tokens.access_token || "",
        refreshToken: tokens.refresh_token || "",
        tokenExpiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    };

    if (existingPendingIndex >= 0) {
        task.emailSlots[existingPendingIndex] = {
            ...task.emailSlots[existingPendingIndex],
            ...slotData,
            refreshToken:
                tokens.refresh_token ||
                task.emailSlots[existingPendingIndex]?.refreshToken ||
                "",
        };
    } else {
        task.emailSlots.push(slotData);
    }

    task.markModified("emailSlots");

    await task.save();

    const frontendOrigin = new URL(process.env.FRONTEND_URL).origin;
    const youtubeOpenUrl = buildYoutubeOpenUrl(likeLink.videoUrl, email);

    res.set("Content-Type", "text/html");

    res.send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Redirecting...</title>
  </head>

  <body style="font-family: Arial, sans-serif; padding: 24px;">
    <p>Authentication successful. Please select your authenticated account to continue to YouTube...</p>

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

    if (!userId || !likeLinkId || !taskId) {
        return badRequest(res, "userId, likeLinkId and taskId are required");
    }

    const task = await Task.findOne({ taskId, userId, likeLinkId });

    if (!task) {
        return notFound(res, "Task not found");
    }

    const likeLink = await LikeLink.findById(likeLinkId).lean();

    if (!likeLink) {
        return notFound(res, "Like link not found");
    }

    if (!likeLink.videoUrl) {
        return badRequest(res, "videoUrl missing");
    }

    if (isLikeLinkExpired(likeLink)) {
        return badRequest(res, "Like task has expired");
    }

    const maxEmailsAllowed = getMaxEmailsAllowedFromLikeLink(likeLink);

    if (Number(task.maxEmailsAllowed) !== maxEmailsAllowed) {
        task.maxEmailsAllowed = maxEmailsAllowed;
    }

    const completedCount = (task.emailSlots || []).filter((slot) => slot.verified).length;

    if (completedCount >= maxEmailsAllowed) {
        return badRequest(
            res,
            `All ${maxEmailsAllowed} email slots are already completed`
        );
    }

    const now = Date.now();

    const activeSlotIndex = (task.emailSlots || []).findIndex(
        (x) =>
            !x.verified &&
            x.authExpiresAt &&
            new Date(x.authExpiresAt).getTime() > now
    );

    if (activeSlotIndex < 0) {
        return badRequest(res, "No active authenticated email found or timer expired");
    }

    const activeSlot = task.emailSlots[activeSlotIndex];
    const email = normalizeEmail(activeSlot.email);

    if (!email) {
        return badRequest(res, "Authenticated email missing");
    }

    const alreadyVerifiedInThisTask = (task.emailSlots || []).some(
        (slot, index) =>
            index !== activeSlotIndex &&
            normalizeEmail(slot.email) === email &&
            slot.verified === true
    );

    if (alreadyVerifiedInThisTask) {
        return res.status(400).json({
            error: DUPLICATE_EMAIL_MESSAGE,
            message: DUPLICATE_EMAIL_MESSAGE,
            email,
        });
    }

    const duplicateVerifiedEmail = await findVerifiedEmailUsage(
        likeLinkId,
        email,
        task._id
    );

    if (duplicateVerifiedEmail) {
        return res.status(400).json({
            error: DUPLICATE_EMAIL_MESSAGE,
            message: DUPLICATE_EMAIL_MESSAGE,
            email,
        });
    }

    let verification;

    try {
        verification = await verifyYoutubeLikeByApi(activeSlot, likeLink.videoUrl);
    } catch (err) {
        verification = {
            state: "not_liked",
            liked: false,
            confidence: 0,
            message: LIKE_NOT_DETECTED_MESSAGE,
            reason: err.message || "Unable to verify like with YouTube API",
            videoId: "",
            rating: "none",
            youtubeApiResponse: null,
        };
    }

    if (!verification.liked) {
        task.emailSlots.splice(activeSlotIndex, 1);
        task.markModified("emailSlots");

        await task.save();

        return res.status(400).json({
            error: LIKE_NOT_DETECTED_MESSAGE,
            message: LIKE_NOT_DETECTED_MESSAGE,
            email,
            verification: {
                state: verification.state,
                liked: verification.liked,
                confidence: verification.confidence,
                message: verification.message,
                reason: verification.reason,
                videoId: verification.videoId,
                rating: verification.rating,
            },
        });
    }

    task.emailSlots[activeSlotIndex].email = email;
    task.emailSlots[activeSlotIndex].submittedAt = new Date();
    task.emailSlots[activeSlotIndex].verified = true;
    task.emailSlots[activeSlotIndex].verificationReason = verification.reason;
    task.emailSlots[activeSlotIndex].verificationMessage = LIKE_DETECTED_MESSAGE;
    task.emailSlots[activeSlotIndex].verifiedBy = "youtube_api";
    task.emailSlots[activeSlotIndex].videoId = verification.videoId || "";
    task.emailSlots[activeSlotIndex].youtubeRating = verification.rating || "like";
    task.emailSlots[activeSlotIndex].youtubeApiResponse =
        verification.youtubeApiResponse || null;
    task.emailSlots[activeSlotIndex].authExpiresAt = new Date();

    task.emailSlots[activeSlotIndex].accessToken = "";
    task.emailSlots[activeSlotIndex].refreshToken = "";
    task.emailSlots[activeSlotIndex].tokenExpiryDate = null;

    task.markModified("emailSlots");

    await task.save();

    const serialized = serializeTask(task, likeLink);

    return res.json({
        message: LIKE_DETECTED_MESSAGE,
        email,
        task: serialized,
        verification: {
            state: verification.state,
            liked: verification.liked,
            confidence: verification.confidence,
            message: LIKE_DETECTED_MESSAGE,
            reason: verification.reason,
            videoId: verification.videoId,
            rating: verification.rating,
        },
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

    if (!likeLink) {
        return notFound(res, "Like link not found");
    }

    const tasks = await Task.find({ likeLinkId: linkId })
        .sort({ createdAt: -1 })
        .lean();

    const maxEmailsAllowed = getMaxEmailsAllowedFromLikeLink(likeLink);

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
            maxEmailsAllowed,
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
                verificationMessage: slot.verificationMessage,
                verifiedBy: slot.verifiedBy,
                videoId: slot.videoId,
                youtubeRating: slot.youtubeRating,
                youtubeApiResponse: slot.youtubeApiResponse,
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