const express = require('express');
const userController = require('../controllers/userController');
const router = express.Router();

router.post('/registre', userController.registre)

module.exports = router;