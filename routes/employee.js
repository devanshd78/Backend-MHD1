// routes/employee.js
const express = require('express');
const router  = express.Router();
const employeeController    = require('../controllers/employeeController');

// registration & login
router.post('/register', employeeController.register);
router.post('/login',    employeeController.login);

// link browsing (no entries here)
router.get('/links',      employeeController.listLinks);
router.get('/links/:linkId', employeeController.getLink);

// balance check
router.get('/balance',    employeeController.getBalance);
router.get('/emailtasks', employeeController.listEmailTasks);

module.exports = router;
