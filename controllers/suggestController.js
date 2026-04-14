
/**
 * suggestController.js
 * Stateless Connect-4 AI engine — fully rewritten for maximum strength.
 *
 * POST /api/suggest-move  { board: number[][], depth?: number, aiPlayer?: number }
 * Returns { bestCol: number, scores: (number|null)[], bestScore: number }
 *
 * Improvements over previous version:
 *  1. TT key = board state only (no depth/isMax) — entries are depth-gated,
 *     so a result computed at depth 6 is reused at any depth ≤ 6.
 *  2. TT stores {score, depth, flag, bestMove} with F_EXACT/F_LOWER/F_UPPER.
 *  3. Killer move heuristic — β-cutoff column stored per depth, tried first.
 *  4. TT-guided move ordering — best move from TT tried first at each node.
 *  5. Stronger heuristic — blocking weight (-90) > attack (+50),
 *     column positional weights [3,4,5,7,5,4,3].
 *  6. 1-ply pre-checks at root — immediate win / forced block in O(7).
 *  7. Iterative deepening with ~5s budget (server has more CPU headroom).
 */

'use strict';

const WIN       = 10_000_000;
const WIN_CLAMP = WIN / 2;

// TT flags
const F_EXACT = 0;
const F_LOWER = 1;
const F_UPPER = 2;

// Column positional weights — standard 7-column board
const COL_WEIGHTS_7 = [3, 4, 5, 7, 5, 4, 3];

// ── Board helpers ─────────────────────────────────────────────────────────────

function getRows(board) { return board.length; }
function getCols(board) { return board[0].length; }

/** Drop piece in-place, return landing row or -1 if full. */
function dropPiece(board, col, player, rows) {
  for (let r = rows - 1; r >= 0; r--) {
    if (board[r][col] === 0) { board[r][col] = player; return r; }
  }
  return -1;
}

/** Undo a drop. */
function undoPiece(board, row, col) { board[row][col] = 0; }

function canPlay(board, col) { return board[0][col] === 0; }

function isFull(board) { return board[0].every(c => c !== 0); }

// ── Win detection (incremental) ───────────────────────────────────────────────

/**
 * Check whether the piece just placed at (row, col) completed 4-in-a-row.
 * Examines at most 12 cells — O(1) per call.
 */
function checkWin(board, row, col, player, rows, cols) {
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let n = 1;
    for (let s = 1; s < 4; s++) {
      const r = row + dr*s, c = col + dc*s;
      if (r < 0 || r >= rows || c < 0 || c >= cols || board[r][c] !== player) break;
      n++;
    }
    for (let s = 1; s < 4; s++) {
      const r = row - dr*s, c = col - dc*s;
      if (r < 0 || r >= rows || c < 0 || c >= cols || board[r][c] !== player) break;
      n++;
    }
    if (n >= 4) return true;
  }
  return false;
}

// ── Move ordering ─────────────────────────────────────────────────────────────

/**
 * Returns playable columns ordered by priority:
 *   1. TT best move (highest priority)
 *   2. Killer move (caused β-cutoff at this depth)
 *   3. Center-distance (ascending = center first)
 */
function getOrderedMoves(board, cols, ttBestMove, killer) {
  const center = Math.floor(cols / 2);
  const moves = [];
  for (let c = 0; c < cols; c++) {
    if (canPlay(board, c)) moves.push(c);
  }
  moves.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));

  if (killer !== null && killer !== undefined) {
    const ki = moves.indexOf(killer);
    if (ki > 0) { moves.splice(ki, 1); moves.unshift(killer); }
  }
  if (ttBestMove !== null && ttBestMove !== undefined) {
    const ti = moves.indexOf(ttBestMove);
    if (ti > 0) { moves.splice(ti, 1); moves.unshift(ttBestMove); }
  }
  return moves;
}

// ── Heuristic evaluation ──────────────────────────────────────────────────────

/**
 * Score one 4-cell window inline — zero temporary allocations.
 * Positive = good for aiPlayer (MAX), negative = good for opponent (MIN).
 * Blocking penalty (-90) is stronger than attack bonus (+50).
 */
function scoreWindow(a, b, c, d, maxP, minP) {
  let pc = 0, oc = 0, ec = 0;
  if (a === maxP) pc++; else if (a === minP) oc++; else ec++;
  if (b === maxP) pc++; else if (b === minP) oc++; else ec++;
  if (c === maxP) pc++; else if (c === minP) oc++; else ec++;
  if (d === maxP) pc++; else if (d === minP) oc++; else ec++;

  if (pc > 0 && oc > 0) return 0;   // blocked window — no value to either player

  if (pc === 4) return  2000;
  if (pc === 3 && ec === 1) return    50;
  if (pc === 2 && ec === 2) return    10;
  if (oc === 4) return -2000;
  if (oc === 3 && ec === 1) return   -90;
  if (oc === 2 && ec === 2) return   -15;

  return 0;
}

/**
 * Full heuristic board evaluation (from aiPlayer/MAX perspective).
 */
function evaluateBoard(board, aiPlayer, rows, cols) {
  const opp = aiPlayer === 1 ? 2 : 1;
  let score = 0;

  // Positional column bonus
  const cw = cols === 7
    ? COL_WEIGHTS_7
    : Array.from({ length: cols }, (_, i) => Math.max(7 - Math.abs(i - Math.floor(cols / 2)) * 2, 1));

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = board[r][c];
      if      (v === aiPlayer) score += cw[c];
      else if (v === opp)      score -= cw[c];
    }
  }

  // Horizontal
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c <= cols - 4; c++) {
      score += scoreWindow(board[r][c], board[r][c+1], board[r][c+2], board[r][c+3], aiPlayer, opp);
    }
  }
  // Vertical
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r <= rows - 4; r++) {
      score += scoreWindow(board[r][c], board[r+1][c], board[r+2][c], board[r+3][c], aiPlayer, opp);
    }
  }
  // Diagonal ↘
  for (let r = 0; r <= rows - 4; r++) {
    for (let c = 0; c <= cols - 4; c++) {
      score += scoreWindow(board[r][c], board[r+1][c+1], board[r+2][c+2], board[r+3][c+3], aiPlayer, opp);
    }
  }
  // Diagonal ↗
  for (let r = 3; r < rows; r++) {
    for (let c = 0; c <= cols - 4; c++) {
      score += scoreWindow(board[r][c], board[r-1][c+1], board[r-2][c+2], board[r-3][c+3], aiPlayer, opp);
    }
  }

  return score;
}

// ── Transposition table key ───────────────────────────────────────────────────

/**
 * Board → compact string key.
 * Depth and player are NOT included — the same board at depth 3 can reuse
 * a cached result computed at depth 6 (after depth-gating check).
 */
function boardKey(board) {
  let k = '';
  for (let r = 0; r < board.length; r++) {
    const row = board[r];
    for (let c = 0; c < row.length; c++) k += row[c];
    k += '|';
  }
  return k;
}

// ── Core minimax ──────────────────────────────────────────────────────────────

/**
 * Recursive alpha-beta minimax with:
 *  - Transposition table (exact / lower / upper bounds, depth-gated reuse)
 *  - Killer move heuristic
 *  - TT-guided move ordering
 *  - Undo-move (no board copies)
 *  - Incremental win detection
 *  - Hard deadline guard
 */
function minimax(board, depth, isMax, alpha, beta, aiPlayer, oppPlayer, rows, cols, tt, killers, deadline) {
  if (Date.now() >= deadline) return 0;  // timed out — caller discards this depth

  // TT lookup
  const key = boardKey(board);
  const entry = tt.get(key);
  if (entry && entry.depth >= depth) {
    if (entry.flag === F_EXACT) return entry.score;
    if (entry.flag === F_LOWER) alpha = Math.max(alpha, entry.score);
    else if (entry.flag === F_UPPER) beta = Math.min(beta,  entry.score);
    if (alpha >= beta) return entry.score;
  }

  if (depth === 0 || isFull(board)) {
    const s = evaluateBoard(board, aiPlayer, rows, cols);
    if (!entry || entry.depth < depth) tt.set(key, { score: s, depth: 0, flag: F_EXACT, bestMove: null });
    return s;
  }

  const moves = getOrderedMoves(board, cols, entry?.bestMove ?? null, killers[depth] ?? null);
  if (moves.length === 0) {
    tt.set(key, { score: 0, depth, flag: F_EXACT, bestMove: null });
    return 0;
  }

  const origAlpha = alpha;
  let bestScore = isMax ? -(WIN + 1) : (WIN + 1);
  let bestMove  = moves[0];
  const player  = isMax ? aiPlayer : oppPlayer;

  for (const col of moves) {
    const row = dropPiece(board, col, player, rows);
    if (row === -1) continue;

    let score;
    if (checkWin(board, row, col, player, rows, cols)) {
      score = isMax ? WIN + depth : -(WIN + depth);
    } else {
      score = minimax(board, depth - 1, !isMax, alpha, beta, aiPlayer, oppPlayer, rows, cols, tt, killers, deadline);
    }
    undoPiece(board, row, col);

    if (isMax) {
      if (score > bestScore) { bestScore = score; bestMove = col; }
      if (bestScore > alpha) alpha = bestScore;
    } else {
      if (score < bestScore) { bestScore = score; bestMove = col; }
      if (bestScore < beta)  beta  = bestScore;
    }

    if (alpha >= beta) {
      killers[depth] = col;
      break;
    }
  }

  let flag;
  if      (bestScore <= origAlpha) flag = F_UPPER;
  else if (bestScore >= beta)      flag = F_LOWER;
  else                             flag = F_EXACT;

  const prev = tt.get(key);
  if (!prev || prev.depth <= depth) {
    tt.set(key, { score: bestScore, depth, flag, bestMove });
  }

  return bestScore;
}

// ── Root search ───────────────────────────────────────────────────────────────

/**
 * Iterative-deepening root search.
 * Returns { bestCol, scores, bestScore }.
 *
 * @param {number[][]} board      — will be deep-cloned internally
 * @param {number}     maxDepth   — search depth cap (time may stop earlier)
 * @param {number}     aiPlayer   — 1 or 2
 */
function getBestMove(board, maxDepth, aiPlayer) {
  const rows      = getRows(board);
  const cols      = getCols(board);
  const oppPlayer = aiPlayer === 1 ? 2 : 1;
  const TIME_MS   = 5000;     // server has more headroom than browser
  const deadline  = Date.now() + TIME_MS;
  const tt        = new Map();
  const killers   = new Array(maxDepth + 4).fill(null);

  const center = Math.floor(cols / 2);
  const allMoves = [];
  for (let c = 0; c < cols; c++) if (canPlay(board, c)) allMoves.push(c);
  allMoves.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));

  const colScores = Array(cols).fill(null);

  if (allMoves.length === 0) return { bestCol: null, scores: colScores, bestScore: 0 };

  // ── 1-ply: take immediate win ────────────────────────────────────────────
  for (const col of allMoves) {
    const row = dropPiece(board, col, aiPlayer, rows);
    if (row !== -1) {
      const win = checkWin(board, row, col, aiPlayer, rows, cols);
      undoPiece(board, row, col);
      if (win) {
        colScores[col] = WIN + maxDepth;
        return { bestCol: col, scores: colScores, bestScore: WIN + maxDepth };
      }
    }
  }

  // ── 1-ply: block opponent's immediate win ────────────────────────────────
  let mustBlock = null;
  for (const col of allMoves) {
    const row = dropPiece(board, col, oppPlayer, rows);
    if (row !== -1) {
      const win = checkWin(board, row, col, oppPlayer, rows, cols);
      undoPiece(board, row, col);
      if (win) { mustBlock = col; break; }
    }
  }

  // ── Iterative deepening ──────────────────────────────────────────────────
  let bestCol   = mustBlock ?? allMoves[0];
  let bestScore = -(WIN + 1);

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (Date.now() >= deadline) break;

    let iterBest = -(WIN + 1);
    let iterCol  = null;
    let alpha    = -(WIN + 1);
    const beta   = WIN + 1;
    let timedOut = false;

    const iterMoves = [...allMoves];
    if (mustBlock !== null) {
      const mi = iterMoves.indexOf(mustBlock);
      if (mi > 0) { iterMoves.splice(mi, 1); iterMoves.unshift(mustBlock); }
    }

    for (const col of iterMoves) {
      if (Date.now() >= deadline) { timedOut = true; break; }

      const row = dropPiece(board, col, aiPlayer, rows);
      if (row === -1) continue;

      let score;
      if (checkWin(board, row, col, aiPlayer, rows, cols)) {
        score = WIN + depth;
      } else {
        score = minimax(board, depth - 1, false, alpha, beta, aiPlayer, oppPlayer, rows, cols, tt, killers, deadline);
      }
      undoPiece(board, row, col);

      if (depth === maxDepth || (depth > 1 && !timedOut)) colScores[col] = score;

      if (score > iterBest) { iterBest = score; iterCol = col; }
      if (iterBest > alpha) alpha = iterBest;
      if (iterBest >= WIN_CLAMP) break;
    }

    if (!timedOut && iterCol !== null) {
      bestCol   = iterCol;
      bestScore = iterBest;
    }

    if (bestScore >= WIN_CLAMP) break;
  }

  // Fill in scores for any column not covered above
  for (const col of allMoves) {
    if (colScores[col] === null) colScores[col] = bestScore;
  }

  return { bestCol, scores: colScores, bestScore };
}

// ── Controller ────────────────────────────────────────────────────────────────

exports.suggestMove = (req, res) => {
  try {
    const { board, depth = 7, aiPlayer = 2 } = req.body;

    if (!Array.isArray(board) || board.length === 0) {
      return res.status(400).json({ error: 'board is required and must be a 2D array' });
    }

    const d = Math.max(1, Math.min(Number(depth), 12));
    const p = [1, 2].includes(Number(aiPlayer)) ? Number(aiPlayer) : 2;

    // Clone board so getBestMove can mutate freely (undo-move pattern)
    const cloned = board.map(r => [...r]);

    const { bestCol, scores, bestScore } = getBestMove(cloned, d, p);

    return res.json({ bestCol, scores, bestScore });
  } catch (err) {
    console.error('[suggestMove]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
