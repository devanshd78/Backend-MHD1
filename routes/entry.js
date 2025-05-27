// routes/entryRoutes.js (new file)
const router = require('express').Router();
const entry = require('../controllers/entryController');

router.post('/employee', entry.createEmployeeEntry);      // type 0
router.post('/user', entry.createUserEntry);          // type 1
router.post('/getlist', entry.listEntries);              // type filter
router.post('/updateEntry', entry.updateEntry);
router.post('/updateStatus', entry.setEntryStatus);
router.get('/getEntry/:entryId', entry.getEntryById);
router.post('/listByLink', entry.listEntriesByLink);

module.exports = router;
