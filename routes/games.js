const express = require('express');
const gameController = require('../controllers/gameController');
const auth = require('../middlewares/auth.middleware');
const isAdmin = require('../middlewares/isAdmin.middleware');
const router = express.Router();

// Admin-only: get all the games
router.get('/', auth, isAdmin, gameController.getAll);
// Admin-only: create a game
router.post('/', auth, isAdmin, gameController.create);
module.exports = router;
