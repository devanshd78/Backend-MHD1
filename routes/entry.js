// routes/entryRoutes.js
const express = require('express');
const router = express.Router();

const multer = require('multer');
const upload = multer();

const entry = require('../controllers/entryController');

router.use(express.json({ limit: '1mb' }));
router.use(express.urlencoded({ extended: true }));

router.post('/employee', upload.single('qr'), entry.createEmployeeEntry);

router.post('/user', entry.createUserEntry);

// Listing / updates / status / fetch
router.post('/getlist', entry.listEntries);
router.post('/updateEntry', entry.updateEntry);
router.post('/updateStatus', entry.setEntryStatus);
router.get('/getEntry/:entryId', entry.getEntryById);
router.post('/listByLink', entry.listEntriesByLink);

module.exports = router;
