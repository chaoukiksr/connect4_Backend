'use strict';

const mlService = require('../services/mlService');

/**
 * GET /api/ml/status
 * Returns whether the ONNX model is loaded and ready.
 */
function getStatus(req, res) {
  res.json({
    modelLoaded: mlService.isModelLoaded(),
    status: mlService.isModelLoaded() ? 'ready' : 'no_model',
  });
}

/**
 * POST /api/ml/move
 * Get the ML AI's best move for a board position.
 *
 * Body   : { board: number[][], currentPlayer: 1|2, simulations?: number }
 * Returns: { bestCol, policy, value, visitCounts }
 */
async function getMLMove(req, res) {
  const { board, currentPlayer, simulations } = req.body;

  if (!board || !currentPlayer) {
    return res.status(400).json({ error: 'board and currentPlayer are required' });
  }

  if (!mlService.isModelLoaded()) {
    return res.status(503).json({
      error: 'ML model not loaded',
      hint: 'Train and export an ONNX model: python ml/alphazero.py --iterations 30',
    });
  }

  const numSims = Math.min(Math.max(parseInt(simulations) || 400, 50), 1600);

  const result = await mlService.getBestMove(board, currentPlayer, numSims);
  res.json(result);
}

/**
 * POST /api/ml/analyse
 * Analyse a board position — returns per-column MCTS visit counts and NN policy.
 *
 * Body   : { board: number[][], currentPlayer: 1|2, simulations?: number }
 * Returns: { bestCol, actionProbs, nnPolicy, value, visitCounts }
 */
async function analysePosition(req, res) {
  const { board, currentPlayer, simulations } = req.body;

  if (!board || !currentPlayer) {
    return res.status(400).json({ error: 'board and currentPlayer are required' });
  }

  if (!mlService.isModelLoaded()) {
    return res.status(503).json({ error: 'ML model not loaded' });
  }

  const numSims = Math.min(Math.max(parseInt(simulations) || 200, 50), 800);
  const result = await mlService.analyzePosition(board, currentPlayer, numSims);
  res.json(result);
}

module.exports = { getStatus, getMLMove, analysePosition };
