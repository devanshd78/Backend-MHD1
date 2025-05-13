// routes/employee.js
const express = require('express');
const multer = require('multer')
const router = express.Router();
const ctrl = require('../controllers/employeeController');

const upload = multer({ storage: multer.memoryStorage() })

// registration & login
router.post('/register', ctrl.register);
router.post('/login', ctrl.login);

router.get('/links', ctrl.listLinks);
router.get('/links/:linkId', ctrl.getLink);
router.post(
  '/links/:linkId/entries',
  upload.single('qrImage'),
  ctrl.submitEntry
)
router.post('/links/entries', ctrl.getEntriesByLink)
router.get('/entries/:linkId/:employeeId', ctrl.getEntryByEmployee);
router.post(
  '/entries/:linkId/:employeeId/:entryId',
  ctrl.updateEntryByEmployee
);
router.get('/balance', ctrl.getBalance);

module.exports = router;
