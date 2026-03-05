/**
 * suggestController.js
 * Stateless Connect-4 AI engine (minimax + alpha-beta + transposition table).
 * POST /api/suggest-move  { board: number[][], depth: number }
 * Returns { bestCol: number, scores: number[] }
 */

const WIN_SCORE = 9000;
const ROWS = 6;  // default; overridden by actual board dimensions
const COLS = 7;

// ── helpers ──────────────────────────────────────────────────────────────────

function getRows(board) { return board.length; }
function getCols(board) { return board[0].length; }

function canPlay(board, col) {
  return board[0][col] === 0;
}

function dropPiece(board, col, player) {
  const rows = getRows(board);
  for (let r = rows - 1; r >= 0; r--) {
    if (board[r][col] === 0) {
      board[r][col] = player;
      return r;
    }
  }
  return -1;
}

function checkWin(board, row, col, player) {
  const rows = getRows(board);
  const cols = getCols(board);
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let s = 1; s < 4; s++) {
      const r = row + dr*s, c = col + dc*s;
      if (r < 0 || r >= rows || c < 0 || c >= cols || board[r][c] !== player) break;
      count++;
    }
    for (let s = 1; s < 4; s++) {
      const r = row - dr*s, c = col - dc*s;
      if (r < 0 || r >= rows || c < 0 || c >= cols || board[r][c] !== player) break;
      count++;
    }
    if (count >= 4) return true;
  }
  return false;
}

function isFull(board) {
  return board[0].every(c => c !== 0);
}

// ── scoring heuristic ─────────────────────────────────────────────────────────

function scoreWindow(window, player) {
  const opp = player === 1 ? 2 : 1;
  const pc = window.filter(c => c === player).length;
  const oc = window.filter(c => c === opp).length;
  const ec = window.filter(c => c === 0).length;
  if (pc === 4) return 100;
  if (pc === 3 && ec === 1) return 5;
  if (pc === 2 && ec === 2) return 2;
  if (oc === 3 && ec === 1) return -4;
  return 0;
}

function evaluateBoard(board, player) {
  const rows = getRows(board);
  const cols = getCols(board);
  let score = 0;
  const centerCol = Math.floor(cols / 2);
  const centerArr = board.map(r => r[centerCol]);
  score += centerArr.filter(c => c === player).length * 3;

  // Horizontal
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c <= cols - 4; c++) {
      score += scoreWindow(board[r].slice(c, c+4), player);
    }
  }
  // Vertical
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r <= rows - 4; r++) {
      score += scoreWindow([board[r][c],board[r+1][c],board[r+2][c],board[r+3][c]], player);
    }
  }
  // Diagonals
  for (let r = 0; r <= rows - 4; r++) {
    for (let c = 0; c <= cols - 4; c++) {
      score += scoreWindow([board[r][c],board[r+1][c+1],board[r+2][c+2],board[r+3][c+3]], player);
      score += scoreWindow([board[r+3][c],board[r+2][c+1],board[r+1][c+2],board[r][c+3]], player);
    }
  }
  return score;
}

// ── minimax ───────────────────────────────────────────────────────────────────

function boardKey(board) {
  return board.map(r => r.join('')).join('|');
}

function minimax(board, depth, isMax, alpha, beta, aiPlayer, tt) {
  const key = `${boardKey(board)}_${depth}_${isMax ? 1 : 0}`;
  if (tt.has(key)) return tt.get(key);

  const cols = getCols(board);
  if (depth === 0 || isFull(board)) {
    const s = evaluateBoard(board, aiPlayer);
    tt.set(key, s);
    return s;
  }

  let best = isMax ? -Infinity : Infinity;
  const order = Array.from({length: cols}, (_, i) => i)
    .sort((a, b) => Math.abs(a - Math.floor(cols/2)) - Math.abs(b - Math.floor(cols/2)));

  for (const col of order) {
    if (!canPlay(board, col)) continue;
    const player = isMax ? aiPlayer : (aiPlayer === 1 ? 2 : 1);
    const row = dropPiece(board, col, player);
    if (row === -1) continue;

    let score;
    if (checkWin(board, row, col, player)) {
      score = isMax ? WIN_SCORE + depth : -(WIN_SCORE + depth);
    } else {
      score = minimax(board, depth - 1, !isMax, alpha, beta, aiPlayer, tt);
    }
    board[row][col] = 0;

    if (isMax) {
      best = Math.max(best, score);
      alpha = Math.max(alpha, score);
      if (score >= WIN_SCORE) break;
    } else {
      best = Math.min(best, score);
      beta = Math.min(beta, score);
      if (score <= -WIN_SCORE) break;
    }
    if (beta <= alpha) break;
  }

  tt.set(key, best);
  return best;
}

// ── public function ───────────────────────────────────────────────────────────

function getBestMove(board, depth, aiPlayer = 2) {
  const cols = getCols(board);
  const tt = new Map();
  let bestCol = null;
  let bestScore = -Infinity;
  const scores = Array(cols).fill(null);

  const order = Array.from({length: cols}, (_, i) => i)
    .sort((a, b) => Math.abs(a - Math.floor(cols/2)) - Math.abs(b - Math.floor(cols/2)));

  for (const col of order) {
    if (!canPlay(board, col)) continue;
    const row = dropPiece(board, col, aiPlayer);
    if (row === -1) continue;

    let score;
    if (checkWin(board, row, col, aiPlayer)) {
      score = WIN_SCORE + depth;
    } else {
      score = minimax(board, depth - 1, false, -Infinity, Infinity, aiPlayer, tt);
    }
    board[row][col] = 0;
    scores[col] = score;

    if (score > bestScore) {
      bestScore = score;
      bestCol = col;
    }
    if (bestScore >= WIN_SCORE) break;
  }

  return { bestCol, scores, bestScore };
}

// ── controller ────────────────────────────────────────────────────────────────

exports.suggestMove = (req, res) => {
  try {
    const { board, depth = 5, aiPlayer = 2 } = req.body;

    if (!Array.isArray(board) || board.length === 0) {
      return res.status(400).json({ error: 'board is required and must be a 2D array' });
    }

    const d = Math.max(1, Math.min(Number(depth), 10));
    const p = [1, 2].includes(Number(aiPlayer)) ? Number(aiPlayer) : 2;

    // Deep-clone board to avoid mutation side-effects
    const cloned = board.map(r => [...r]);

    const { bestCol, scores, bestScore } = getBestMove(cloned, d, p);

    return res.json({ bestCol, scores, bestScore });
  } catch (err) {
    console.error('[suggestMove]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
