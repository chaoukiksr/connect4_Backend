const express = require('express');
const router = express.Router();
const { suggestMove } = require('../controllers/suggestController');

// POST /api/suggest-move
// Body: { board: number[][], depth?: number, aiPlayer?: number }
// No auth required (stateless computation)
router.post('/', suggestMove);

module.exports = router;
