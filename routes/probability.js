const express = require('express');
const router = express.Router();
const { getProbability } = require('../controllers/probabilityController');

// POST /api/probability
// Body: { board: number[][], currentPlayer: 1|2, depth?: number }
// Returns: { red: 0-100, yellow: 0-100, score: number, bestCol: number, colScores: number[] }
router.post('/', getProbability);

module.exports = router;
