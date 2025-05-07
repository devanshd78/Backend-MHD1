// routes/admin.js
const express = require('express');
const router  = express.Router();

const ctrl = require('../controllers/adminController.js');

/* ------------------------------------------------------------------ */
/*  Public route                                                      */
/* ------------------------------------------------------------------ */
router.post('/login', ctrl.login);

/* -----  Employees ------------------------------------------------- */
router.get('/employees',               ctrl.getEmployees);
router.post('/employees/entries',      ctrl.getEmployeeEntries);
router.post('/employees/links',        ctrl.getLinksByEmployee);
router.post('/employees/links/entries',ctrl.getEntriesByEmployeeAndLink);

/* -----  Links ----------------------------------------------------- */
router
  .route('/links')
  .get(ctrl.listLinks)     // GET /admin/links
  .post(ctrl.createLink);  // POST /admin/links

router.post('/links/entries',  ctrl.getEntries);
router.post('/links/summary',  ctrl.getLinkSummary);

module.exports = router;
