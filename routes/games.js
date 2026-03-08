const express = require('express');
const gameController = require('../controllers/gameController');
const auth = require('../middlewares/auth.middleware');
const isAdmin = require('../middlewares/isAdmin.middleware');
const router = express.Router();

// Admin-only: get all games (with optional ?page=&limit= query params)
router.get('/', auth, isAdmin, gameController.getAll);
// Server-side aggregated stats (admin)
router.get('/stats', auth, isAdmin, gameController.getStats);
// Get a single game by id (admin)
router.get('/:id', auth, isAdmin, gameController.getById);
// Public: create a game (no auth required)
router.post('/', gameController.create);
// Admin-only: delete a game
router.delete('/:id', auth, isAdmin, gameController.deleteGame);

module.exports = router;
