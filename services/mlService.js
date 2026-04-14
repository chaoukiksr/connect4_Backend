'use strict';

/**
 * ML inference service for Connect4.
 *
 * Loads an ONNX model exported by ml/alphazero.py and provides:
 *   - Neural network prediction  (policy logits + value)
 *   - MCTS search guided by the NN
 *   - getBestMove()  — main entry point for the AI controller
 *
 * Board encoding (must match alphazero.py):
 *   Float32 tensor (1, 3, 6, 7)
 *   channel 0 : current player's pieces
 *   channel 1 : opponent's pieces
 *   channel 2 : turn indicator (1.0 if player 1's turn, 0.0 if player 2's)
 *
 * MCTS value convention:
 *   node.valueSum stores values from the CURRENT PLAYER's perspective at that node.
 *   Backpropagation negates the value at each level (alternating players).
 *   UCB uses  -child.qValue + exploration  so the parent maximises its own reward.
 */

const path = require('path');

// ── ONNX runtime (optional dep — graceful fallback if not installed) ──────────
let ort = null;
try {
  ort = require('onnxruntime-node');
} catch {
  console.warn('[mlService] onnxruntime-node not installed — ML features disabled.');
  console.warn('            Run: npm install onnxruntime-node');
}

// ── Module state ──────────────────────────────────────────────────────────────
let _session = null;
const DEFAULT_MODEL_PATH = path.join(__dirname, '..', 'ml', 'models', 'best_alphazero.onnx');

const ROWS = 6;
const COLS = 7;

// ══════════════════════════════════════════════════════════════════════════════
// Model loading
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Load the ONNX model. Safe to call multiple times — only loads once.
 * @param {string} [modelPath] Override default path (ml/model.onnx)
 */
async function loadModel(modelPath = DEFAULT_MODEL_PATH) {
  if (!ort) throw new Error('onnxruntime-node is not installed');
  if (_session) return; // already loaded
  _session = await ort.InferenceSession.create(modelPath);
  console.log(`[mlService] Model loaded: ${modelPath}`);
}

/** @returns {boolean} */
function isModelLoaded() {
  return _session !== null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Board helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Encode board as Float32Array (3×6×7) for ONNX input.
 * @param {number[][]} board   6×7 grid (0=empty, 1=player1, 2=player2)
 * @param {number}     player  Current player (1 or 2)
 * @returns {Float32Array}
 */
function encodeBoard(board, player) {
  const data = new Float32Array(3 * ROWS * COLS);
  const opp = player === 1 ? 2 : 1;
  const turnVal = player === 1 ? 1.0 : 0.0;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      const cell = board[r][c];
      if (cell === player) data[idx] = 1.0;                  // ch0
      else if (cell === opp) data[ROWS * COLS + idx] = 1.0;  // ch1
      data[2 * ROWS * COLS + idx] = turnVal;                 // ch2
    }
  }
  return data;
}

/** Returns columns that are not full. */
function validMoves(board) {
  const moves = [];
  for (let c = 0; c < COLS; c++) {
    if (board[0][c] === 0) moves.push(c);
  }
  return moves;
}

/**
 * Drop piece into column. Returns { board, row } or null if full.
 * The returned board is a new deep copy.
 */
function dropPiece(board, col, player) {
  for (let r = ROWS - 1; r >= 0; r--) {
    if (board[r][col] === 0) {
      const nb = board.map(row => row.slice());
      nb[r][col] = player;
      return { board: nb, row: r };
    }
  }
  return null;
}

/**
 * Check winner after placing piece at (row, col).
 * @returns {number} 0 = no winner, 1 or 2 = winner
 */
function checkWinnerAt(board, row, col) {
  const player = board[row][col];
  if (!player) return 0;

  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let s = 1; s <= 3; s++) {
      const r = row + dr * s, c = col + dc * s;
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === player) count++;
      else break;
    }
    for (let s = 1; s <= 3; s++) {
      const r = row - dr * s, c = col - dc * s;
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === player) count++;
      else break;
    }
    if (count >= 4) return player;
  }
  return 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// Neural network inference
// ══════════════════════════════════════════════════════════════════════════════

function _softmax(logits) {
  const max = Math.max(...logits);
  const exp = logits.map(x => Math.exp(x - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map(x => x / sum);
}

/**
 * Run the neural network on a board position.
 * @param {number[][]} board
 * @param {number}     player  1 or 2
 * @returns {Promise<{ policy: number[], value: number }>}
 *   policy: softmax probabilities for each of 7 columns
 *   value:  tanh score from current player's perspective (-1..1)
 */
async function predict(board, player) {
  if (!_session) throw new Error('ML model not loaded');
  const encoded = encodeBoard(board, player);
  const tensor = new ort.Tensor('float32', encoded, [1, 3, ROWS, COLS]);
  const results = await _session.run({ input: tensor });
  const policy = _softmax(Array.from(results['policy_logits'].data));
  const value = results['value'].data[0];
  return { policy, value };
}

// ══════════════════════════════════════════════════════════════════════════════
// MCTS
// ══════════════════════════════════════════════════════════════════════════════

class MCTSNode {
  constructor(prior, parent = null) {
    this.prior = prior;
    this.visitCount = 0;
    this.valueSum = 0;   // sum of values from THIS node's current player's perspective
    this.parent = parent;
    this.children = new Map(); // col -> MCTSNode
  }

  /** Mean value from this node's current player's perspective. */
  get qValue() {
    return this.visitCount === 0 ? 0 : this.valueSum / this.visitCount;
  }

  /**
   * UCB score as seen by the PARENT choosing this child.
   * Negate qValue because high value for child player = bad for parent.
   */
  ucbForParent(cPuct = 1.5) {
    const parentN = this.parent ? this.parent.visitCount : 1;
    const u = cPuct * this.prior * Math.sqrt(parentN) / (1 + this.visitCount);
    return -this.qValue + u;
  }

  isLeaf() { return this.children.size === 0; }

  /** Child with highest UCB from parent's perspective. */
  bestChildCol() {
    let best = -Infinity;
    let bestCol = -1;
    for (const [col, child] of this.children) {
      const s = child.ucbForParent(1.5);
      if (s > best) { best = s; bestCol = col; }
    }
    return bestCol;
  }

  /** Child with most visits (final move selection). */
  mostVisitedCol() {
    let best = -1;
    let bestV = -1;
    for (const [col, child] of this.children) {
      if (child.visitCount > bestV) { bestV = child.visitCount; best = col; }
    }
    return best;
  }
}

function _maskAndNormalize(policy, moves) {
  let sum = 0;
  for (const c of moves) sum += policy[c];
  const masked = new Array(COLS).fill(0);
  if (sum > 0) {
    for (const c of moves) masked[c] = policy[c] / sum;
  } else {
    for (const c of moves) masked[c] = 1 / moves.length;
  }
  return masked;
}

function _backpropagate(node, value) {
  let cur = node;
  let v = value;
  while (cur !== null) {
    cur.visitCount++;
    cur.valueSum += v;
    v = -v;          // alternate perspective going up the tree
    cur = cur.parent;
  }
}

/**
 * Run MCTS and return the best column.
 * @param {number[][]} board
 * @param {number}     currentPlayer  1 or 2
 * @param {number}     numSimulations
 * @returns {Promise<{ bestCol, visitCounts, actionProbs }>}
 */
async function mctsSearch(board, currentPlayer, numSimulations) {
  const root = new MCTSNode(1.0, null);

  // Expand root
  const { policy: rootPolicy } = await predict(board, currentPlayer);
  const rootMoves = validMoves(board);
  const rootMasked = _maskAndNormalize(rootPolicy, rootMoves);
  for (const col of rootMoves) {
    root.children.set(col, new MCTSNode(rootMasked[col], root));
  }

  for (let sim = 0; sim < numSimulations; sim++) {
    let node = root;
    let simBoard = board.map(r => r.slice());
    let simPlayer = currentPlayer;
    let done = false;
    let winner = 0;

    // ── Selection: traverse to leaf ─────────────────────────────────────────
    while (!node.isLeaf() && !done) {
      const col = node.bestChildCol();
      const res = dropPiece(simBoard, col, simPlayer);
      if (!res) { done = true; break; }
      simBoard = res.board;
      winner = checkWinnerAt(simBoard, res.row, col);
      const vm = validMoves(simBoard);
      done = winner !== 0 || vm.length === 0;
      node = node.children.get(col);
      simPlayer = simPlayer === 1 ? 2 : 1; // switch AFTER move and BEFORE entering child
    }

    // ── Evaluation / Expansion ──────────────────────────────────────────────
    let value;
    if (done) {
      // simPlayer is now the player who would move from this (terminal) node.
      // winner is the player who MADE the last move = 3-simPlayer (before the switch).
      // Wait: after the loop, simPlayer was switched AFTER the winning move.
      // So simPlayer = opponent of the player who just won.
      // From simPlayer's perspective: they lost → value = -1.
      value = winner === 0 ? 0.0 : -1.0;
    } else {
      // Leaf — evaluate with NN and expand
      const { policy, value: nnValue } = await predict(simBoard, simPlayer);
      value = nnValue; // from simPlayer's perspective
      const leafMoves = validMoves(simBoard);
      if (leafMoves.length > 0) {
        const masked = _maskAndNormalize(policy, leafMoves);
        for (const col of leafMoves) {
          node.children.set(col, new MCTSNode(masked[col], node));
        }
      }
    }

    // ── Backpropagation ─────────────────────────────────────────────────────
    // value is from simPlayer's perspective (the player to move at `node`).
    _backpropagate(node, value);
  }

  // ── Extract action probabilities from visit counts ────────────────────────
  const visitCounts = new Array(COLS).fill(0);
  for (const [col, child] of root.children) {
    visitCounts[col] = child.visitCount;
  }
  const total = visitCounts.reduce((a, b) => a + b, 0);
  const actionProbs = visitCounts.map(v => (total > 0 ? v / total : 0));
  const bestCol = root.mostVisitedCol();

  return { bestCol, visitCounts, actionProbs };
}

// ══════════════════════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Get the ML AI's best move for a given board position.
 *
 * Applies 1-ply win/block pre-checks before running MCTS, so the AI never
 * misses an immediate win or fails to block.
 *
 * @param {number[][]} board
 * @param {number}     currentPlayer   1 or 2
 * @param {number}     [numSimulations=400]
 * @returns {Promise<{ bestCol, policy, value, visitCounts }>}
 */
async function getBestMove(board, currentPlayer, numSimulations = 400) {
  if (!_session) throw new Error('ML model not loaded');

  const moves = validMoves(board);
  const opp = currentPlayer === 1 ? 2 : 1;

  // Immediate win check
  for (const col of moves) {
    const res = dropPiece(board, col, currentPlayer);
    if (res && checkWinnerAt(res.board, res.row, col) === currentPlayer) {
      return { bestCol: col, policy: null, value: 1, visitCounts: null };
    }
  }

  // Immediate block check
  for (const col of moves) {
    const res = dropPiece(board, col, opp);
    if (res && checkWinnerAt(res.board, res.row, col) === opp) {
      return { bestCol: col, policy: null, value: 0, visitCounts: null };
    }
  }

  // Full MCTS search
  const { bestCol, visitCounts, actionProbs } = await mctsSearch(
    board, currentPlayer, numSimulations
  );
  const { policy: nnPolicy, value } = await predict(board, currentPlayer);

  return { bestCol, policy: actionProbs, nnPolicy, value, visitCounts };
}

/**
 * Analyse a position: return per-column MCTS visit distribution + NN eval.
 * @param {number[][]} board
 * @param {number}     currentPlayer   1 or 2
 * @param {number}     [numSimulations=200]
 * @returns {Promise<{ bestCol, actionProbs, nnPolicy, value, visitCounts }>}
 */
async function analyzePosition(board, currentPlayer, numSimulations = 200) {
  if (!_session) throw new Error('ML model not loaded');
  const { bestCol, visitCounts, actionProbs } = await mctsSearch(
    board, currentPlayer, numSimulations
  );
  const { policy: nnPolicy, value } = await predict(board, currentPlayer);
  return { bestCol, actionProbs, nnPolicy, value, visitCounts };
}

module.exports = {
  loadModel,
  isModelLoaded,
  predict,
  getBestMove,
  analyzePosition,
};
