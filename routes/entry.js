// routes/entryRoutes.js
const router = require('express').Router();
const multer = require('multer');
const upload = multer(); // in-memory buffers

const entry = require('../controllers/entryController');

// Employee (type 0) — optional QR image upload as 'qr'
router.post('/employee', upload.single('qr'), entry.createEmployeeEntry);

// User (type 1) — exactly 5 screenshots with these field names
router.post(
  '/user',
  upload.fields([
    { name: 'like', maxCount: 1 },
    { name: 'comment1', maxCount: 1 },
    { name: 'comment2', maxCount: 1 },
    { name: 'reply1',  maxCount: 1 },
    { name: 'reply2',  maxCount: 1 },
  ]),
  entry.createUserEntry
);

// Listing / updates / status / fetch
router.post('/getlist', entry.listEntries);
router.post('/updateEntry', entry.updateEntry);
router.post('/updateStatus', entry.setEntryStatus);
router.get('/getEntry/:entryId', entry.getEntryById);
router.post('/listByLink', entry.listEntriesByLink);

module.exports = router;