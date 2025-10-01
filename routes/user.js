const express = require('express');
const router = express.Router();
const { 
    register,
    login,
    getAllUsers,
    getUserById,
    getUsersByEmployeeId,
    listLinksForUser,
    updateUser,
    listActiveEmailTasks
} = require('../controllers/userController');

// Register endpoint
router.post('/register', register);

// Login endpoint
router.post('/login', login);
router.get('/get', getAllUsers);
router.get('/getbyuserId/:userId', getUserById);
router.get('/getbyemployeeid/:employeeId', getUsersByEmployeeId);
router.post('/link', listLinksForUser);
router.post('/update', updateUser);
router.post('/emailtasks', listActiveEmailTasks);

module.exports = router;
