const express = require('express');
const userController = require('../controllers/userController');
const auth = require('../middlewares/auth.middleware');
const userModel = require('../models/userModel');
const router = express.Router();

router.post('/registre', userController.registre);
router.post('/login', userController.login);
router.get('/myspace',auth,userController.getPersonalSpace )
module.exports = router;