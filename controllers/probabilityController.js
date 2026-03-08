/**
 * probabilityController.js
 * Stateless heuristic evaluation of an arbitrary Connect-4 board state.
 * POST /api/probability  { board: number[][], currentPlayer: number, depth?: number }
 * Returns { red: 0-100, yellow: 0-100, score: number, bestCol: number|null }
 */

const WIN_SCORE = 9000;

// ── board helpers ─────────────────────────────────────────────────────────────

function getRows(board) { return board.length; }
function getCols(board) { return board[0].length; }

function canPlay(board, col) { return board[0][col] === 0; }

function dropPiece(board, col, player) {
  for (let r = getRows(board) - 1; r >= 0; r--) {
    if (board[r][col] === 0) { board[r][col] = player; return r; }
  }
  return -1;
}

function checkWin(board, row, col, player) {
  const R = getRows(board), C = getCols(board);
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let n = 1;
    for (let s = 1; s < 4; s++) {
      const r = row+dr*s, c = col+dc*s;
      if (r<0||r>=R||c<0||c>=C||board[r][c]!==player) break; n++;
    }
    for (let s = 1; s < 4; s++) {
      const r = row-dr*s, c = col-dc*s;
      if (r<0||r>=R||c<0||c>=C||board[r][c]!==player) break; n++;
    }
    if (n >= 4) return true;
  }
  return false;
}

function isFull(board) { return board[0].every(c => c !== 0); }

function scoreWindow(w, p) {
  const o = p===1?2:1;
  const pc = w.filter(c=>c===p).length, oc = w.filter(c=>c===o).length, ec = w.filter(c=>c===0).length;
  if (pc===4) return 100;
  if (pc===3&&ec===1) return 5;
  if (pc===2&&ec===2) return 2;
  if (oc===3&&ec===1) return -4;
  return 0;
}

function evaluate(board, player) {
  const R = getRows(board), C = getCols(board);
  let s = 0;
  const mid = Math.floor(C/2);
  for (let r=0;r<R;r++) s += board[r][mid]===player ? 3 : 0;
  for (let r=0;r<R;r++) for (let c=0;c<=C-4;c++) s += scoreWindow(board[r].slice(c,c+4),player);
  for (let c=0;c<C;c++) for (let r=0;r<=R-4;r++) s += scoreWindow([board[r][c],board[r+1][c],board[r+2][c],board[r+3][c]],player);
  for (let r=0;r<=R-4;r++) for (let c=0;c<=C-4;c++) {
    s += scoreWindow([board[r][c],board[r+1][c+1],board[r+2][c+2],board[r+3][c+3]],player);
    s += scoreWindow([board[r+3][c],board[r+2][c+1],board[r+1][c+2],board[r][c+3]],player);
  }
  return s;
}

// ── minimax (alpha-beta + TT) ─────────────────────────────────────────────────

function boardKey(board) { return board.map(r=>r.join('')).join('|'); }

function minimax(board, depth, isMax, alpha, beta, aiPlayer, tt) {
  const key = `${boardKey(board)}_${depth}_${isMax?1:0}`;
  if (tt.has(key)) return tt.get(key);
  if (depth===0||isFull(board)) { const v=evaluate(board,aiPlayer); tt.set(key,v); return v; }
  const C = getCols(board);
  const order = Array.from({length:C},(_,i)=>i).sort((a,b)=>Math.abs(a-Math.floor(C/2))-Math.abs(b-Math.floor(C/2)));
  let best = isMax ? -Infinity : Infinity;
  for (const col of order) {
    if (!canPlay(board,col)) continue;
    const p = isMax ? aiPlayer : (aiPlayer===1?2:1);
    const row = dropPiece(board,col,p);
    if (row===-1) continue;
    let sc;
    if (checkWin(board,row,col,p)) { sc = isMax ? WIN_SCORE+depth : -(WIN_SCORE+depth); }
    else sc = minimax(board,depth-1,!isMax,alpha,beta,aiPlayer,tt);
    board[row][col]=0;
    if (isMax) { best=Math.max(best,sc); alpha=Math.max(alpha,sc); if(sc>=WIN_SCORE)break; }
    else       { best=Math.min(best,sc); beta=Math.min(beta,sc);   if(sc<=-WIN_SCORE)break; }
    if (beta<=alpha) break;
  }
  tt.set(key,best);
  return best;
}

// ── score → probability conversion ───────────────────────────────────────────

function scoreToProbability(score) {
  // Clamp to [-WIN_SCORE, WIN_SCORE] then sigmoid-like normalization
  const clamped = Math.max(-WIN_SCORE, Math.min(WIN_SCORE, score));
  // Normalize to [0,1] for "aiPlayer is winning"
  const t = (clamped + WIN_SCORE) / (2 * WIN_SCORE);
  return Math.round(t * 100);
}

// ── controller ────────────────────────────────────────────────────────────────

exports.getProbability = (req, res) => {
  try {
    const { board, currentPlayer = 1, depth: rawDepth = 4 } = req.body;
    if (!Array.isArray(board) || board.length === 0) {
      return res.status(400).json({ error: 'board must be a non-empty 2D array' });
    }
    const depth = Math.max(1, Math.min(Number(rawDepth), 6));
    const cp = [1,2].includes(Number(currentPlayer)) ? Number(currentPlayer) : 1;
    const opp = cp === 1 ? 2 : 1;

    const C = getCols(board);
    const tt = new Map();

    // Evaluate position for currentPlayer
    const cloned = board.map(r=>[...r]);
    let bestCol = null;
    let bestScore = -Infinity;
    const colScores = Array(C).fill(null);

    const order = Array.from({length:C},(_,i)=>i).sort((a,b)=>Math.abs(a-Math.floor(C/2))-Math.abs(b-Math.floor(C/2)));
    for (const col of order) {
      if (!canPlay(cloned, col)) continue;
      const row = dropPiece(cloned, col, cp);
      if (row === -1) continue;
      let sc;
      if (checkWin(cloned,row,col,cp)) { sc = WIN_SCORE + depth; }
      else sc = minimax(cloned, depth-1, false, -Infinity, Infinity, cp, tt);
      cloned[row][col] = 0;
      colScores[col] = sc;
      if (sc > bestScore) { bestScore = sc; bestCol = col; }
    }

    // For red(1) and yellow(2) perspectives
    const cpProb   = scoreToProbability(bestScore);         // currentPlayer win%
    const oppProb  = 100 - cpProb;

    const red    = cp === 1 ? cpProb  : oppProb;
    const yellow = cp === 2 ? cpProb  : oppProb;

    return res.json({ red, yellow, score: bestScore, bestCol, colScores });
  } catch (err) {
    console.error('[probability]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
