const express = require('express');
const userController = require('../controllers/userController');
const router = express.Router();

router.post('/registre', userController.registre);
router.post('/login', userController.login);
module.exports = router;