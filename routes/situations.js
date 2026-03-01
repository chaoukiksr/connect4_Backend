const express = require('express');
const situationController = require('../controllers/situationController');
const auth = require('../middlewares/auth.middleware');
const isAdmin = require('../middlewares/isAdmin.middleware');
const router = express.Router();

// Admin-only: Get all situations for a given game (id_partie)
router.get('/games/:id/situations', auth, isAdmin, situationController.getByGame);

module.exports = router;
