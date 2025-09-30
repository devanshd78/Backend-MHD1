// routes/emailRoutes.js
'use strict';

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');                 // ← added
const EmailTask = require('../models/EmailTask');     // ← added

const {
  extractEmailsAndHandlesBatch,
  getAllEmailContacts,
  getContactsByUser,
  getUserSummariesByEmployee,
  getEmployeeOverviewAdmin,
  checkStatus,
  getEmailContactsByTask
} = require('../controllers/emailController');

const router = express.Router();

// In-memory uploads for speed (no disk I/O)
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024, 10); // 10MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES }, // per-file cap
  fileFilter: (_req, file, cb) => {
    if (!file) return cb(null, true);
    if (/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) return cb(null, true);
    return cb(new Error('Unsupported file type. Please upload PNG, JPG/JPEG, or WEBP.'));
  }
});

const acceptAnyUpload = upload.any();

async function capToTaskMaxEmails(req, _res, next) {
  try {
    const rawId = (req.body?._id || req.body?.emailTaskId || req.body?.taskId || '').trim();
    if (!rawId || !mongoose.Types.ObjectId.isValid(rawId)) return next();

    const task = await EmailTask.findById(rawId).select('maxEmails').lean();
    if (!task) return next();

    const maxImages = Number(task.maxEmails);
    if (!Number.isFinite(maxImages) || maxImages < 1) return next();

    if (Array.isArray(req.files) && req.files.length > maxImages) {
      const provided = req.files.length;
      req.files = req.files.slice(0, maxImages); // keep first N, drop the rest
      // optional: attach meta for logs/observability
      req.cappedByTask = { taskId: String(task._id), maxImages, provided, kept: req.files.length };
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

router.post('/user/extract', acceptAnyUpload, capToTaskMaxEmails, extractEmailsAndHandlesBatch);

router.post('/by-user', getContactsByUser);
router.post('/getByemployeeId', getUserSummariesByEmployee);

router.post('/collabglam/all', getAllEmailContacts);

router.post('/admin/all', getEmployeeOverviewAdmin);
router.post('/status', checkStatus);

// Entries (all contacts) by taskId
router.post('/entries', getEmailContactsByTask);

module.exports = router;
