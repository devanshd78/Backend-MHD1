// routes/employee.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/employeeController');

// registration & login
router.post('/register', ctrl.register);
router.post('/login',    ctrl.login);

// link browsing (no entries here)
router.get('/links',      ctrl.listLinks);
router.get('/links/:linkId', ctrl.getLink);

// balance check
router.get('/balance',    ctrl.getBalance);

module.exports = router;
