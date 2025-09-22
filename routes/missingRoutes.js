// routes/missingRoutes.js
const express = require('express');
const router = express.Router();
const { createMissing, listMissing } = require('../controllers/missingController');

// POST: create a missing entry
router.post('/create', createMissing);

// POST: list missing entries with pagination + search
router.post('/list', listMissing);

module.exports = router;
