// routes/emailRoutes.js
'use strict';

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { extractEmailsAndHandlesBatch ,getAllEmailContacts,getContactsByUser,getUserSummariesByEmployee} = require('../controllers/emailController');

const router = express.Router();

// In-memory uploads for speed (no disk I/O)
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024, 10); // 10MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!file) return cb(null, true);
    if (/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) return cb(null, true);
    return cb(new Error('Unsupported file type. Please upload PNG, JPG/JPEG, or WEBP.'));
  }
});

// Accept ANY file field names, then we’ll pick up to 5 images.
const acceptAnyUpload = upload.any();
function capToFive(req, _res, next) {
  if (Array.isArray(req.files) && req.files.length > 5) {
    req.files = req.files.slice(0, 5);
  }
  next();
}

router.post('/user/extract', acceptAnyUpload, capToFive, extractEmailsAndHandlesBatch);

router.post('/getbyuserId', getContactsByUser);
router.post('/getByemployeeId', getUserSummariesByEmployee);

router.post('/collabglam/all', getAllEmailContacts);


// Optional: health
router.get('/health', (_req, res) => res.json({ status: 'ok' }));

module.exports = router;
