// routes/employee.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/employeeController');

// registration & login
router.post('/register', ctrl.register);
router.post('/login', ctrl.login);

router.get('/links', ctrl.listLinks);
router.get('/links/:linkId', ctrl.getLink);
router.post('/links/:linkId/entries', ctrl.submitEntry);
router.post('/links/entries', ctrl.getEntriesByLink)

module.exports = router;
