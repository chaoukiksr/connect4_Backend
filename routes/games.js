const express = require('express');
const gameController = require('../controllers/gameController');
const auth = require('../middlewares/auth.middleware');
const isAdmin = require('../middlewares/isAdmin.middleware');
const router = express.Router();

// Get all games (with optional ?page=&limit= query params)
router.get('/', gameController.getAll);
// Server-side aggregated stats
router.get('/stats', gameController.getStats);
// Get a single game by id
router.get('/:id', gameController.getById);
// Public: create a game (no auth required)
router.post('/', gameController.create);
// Delete a game
router.delete('/:id', gameController.deleteGame);

module.exports = router;
