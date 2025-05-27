// routes/admin.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/adminController.js');

/* ------------------------------------------------------------------ */
/*  Public route                                                      */
/* ------------------------------------------------------------------ */
router.post('/login', ctrl.login);

/* ------------------------------------------------------------------ */
/*  Employees routes                                                  */
/* ------------------------------------------------------------------ */
// Get all employees
router.get('/employees', ctrl.getEmployees);
// Get all entries for a specific employee
router.post('/employees/entries', ctrl.getEmployeeEntries);
// Get distinct links for an employee (paginated)
router.post('/employees/links', ctrl.getLinksByEmployee);
// Get entries for employee + link (paginated)
router.post('/employees/links/entries', ctrl.getEntriesByEmployeeAndLink);

/* ------------------------------------------------------------------ */
/*  Links routes                                                      */
/* ------------------------------------------------------------------ */
// List all links / Create a new link
router.route('/links')
  .get(ctrl.listLinks)
  .post(ctrl.createLink);
// Delete a link
router.post('/links/delete', ctrl.deleteLink);
// Get all entries for a link (admin view)
router.post('/links/entries', ctrl.getEntries);
// Get link summary (per-employee totals)
router.post('/links/summary', ctrl.getLinkSummary);

/* ------------------------------------------------------------------ */
/*  Balance management routes                                         */
/* ------------------------------------------------------------------ */
// Add balance to an employee
router.post('/employees/add-balance', ctrl.addEmployeeBalance);
// Update employee balance
router.post('/employees/update-balance', ctrl.updateEmployeeBalance);
// Get balance history for an employee
router.post('/employees/balance-history', ctrl.getBalanceHistory);
// Bulk add balance
router.post('/employees/bulk-add', ctrl.bulkAddEmployeeBalance);
// Bulk update balance
router.post('/employees/bulk-update', ctrl.bulkUpdateEmployeeBalance);

module.exports = router;
