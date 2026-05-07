// const express = require("express");
// const router = express.Router();
// const likeTaskController = require("../controllers/likeTaskController");

// router.get("/my-status", likeTaskController.getTaskStatuses);
// router.post("/session", likeTaskController.getOrCreateTask);

// router.get("/google/start", likeTaskController.startGoogleAuth);
// router.get("/google/callback", likeTaskController.googleCallback);

// router.post(
//   "/submit",
//   likeTaskController.uploadScreenshot,
//   likeTaskController.submitScreenshotAndVerify
// );
// router.post("/view-entries", likeTaskController.getLikeLinkEntries);
// module.exports = router;



const express = require("express");
const router = express.Router();
const likeTaskController = require("../controllers/likeTaskController");

router.get("/my-status", likeTaskController.getTaskStatuses);
router.post("/session", likeTaskController.getOrCreateTask);

router.get("/google/start", likeTaskController.startGoogleAuth);

// Callback moved to /auth/google/callback in main server file
// router.get("/google/callback", likeTaskController.googleCallback);

router.post("/submit", likeTaskController.submitScreenshotAndVerify);

router.post("/view-entries", likeTaskController.getLikeLinkEntries);

router.post("/employee-view-entries", likeTaskController.getEmployeeLikeLinkEntries);

module.exports = router;