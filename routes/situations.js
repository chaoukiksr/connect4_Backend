const express = require('express');
const situationController = require('../controllers/situationController');
const router = express.Router();

// Get all situations for a given game (id_partie)
router.get('/games/:id/situations', situationController.getByGame);

module.exports = router;
