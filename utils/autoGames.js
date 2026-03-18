/**
 * autoGames.js
 * Simulates AI vs AI Connect 4 games and inserts them into the database.
 *
 * Usage:
 *   node utils/autoGames.js
 *
 * Edit CONFIG below to control output volume, board size, AI strength, and variety.
 */

const { insertPartie, insertSituations } = require('../models/gameModel.js');
const { generateSituation } = require('./trainingUtils.js');
const { checkGameExists } = require('./gameUtils.js');
const db = require('../db/knex.js');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'autoGames.log');
function logToFile(line) {
   fs.appendFileSync(LOG_FILE, line + '\n', 'utf-8');
}

// ─────────────────────────────────────────────────────────────
// CONFIG — edit these values before running
// ─────────────────────────────────────────────────────────────
const CONFIG = {
   NUM_GAMES:    100000,   // total games to generate
   ROWS:         9,     // board rows  (standard = 6)
   COLS:         9,     // board cols  (standard = 7)
   DEPTH_P1:     8,     // minimax depth for Red   (player 1)
   DEPTH_P2:     6,     // minimax depth for Yellow (player 2)
   RANDOM_MOVES: 6,     // first N moves are random → creates game variety
                        // (without this, same-depth AIs always play identically)
   VERBOSE:      true,  // print board + move log after every piece drop
};
// ─────────────────────────────────────────────────────────────

const WIN_SCORE = 9000;

// ── board helpers ─────────────────────────────────────────────

function makeBoard(rows, cols) {
   return Array.from({ length: rows }, () => Array(cols).fill(0));
}

function canPlay(board, col) {
   return board[0][col] === 0;
}

function dropPiece(board, col, player) {
   for (let r = board.length - 1; r >= 0; r--) {
      if (board[r][col] === 0) { board[r][col] = player; return r; }
   }
   return -1;
}

function undoPiece(board, row, col) {
   board[row][col] = 0;
}

function checkWin(board, row, col, player) {
   const rows = board.length, cols = board[0].length;
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

function getWinningCells(board, row, col, player) {
   const rows = board.length, cols = board[0].length;
   const dirs = [[0,1],[1,0],[1,1],[1,-1]];
   for (const [dr, dc] of dirs) {
      const cells = [{ row, col }];
      for (let s = 1; s < 4; s++) {
         const r = row + dr*s, c = col + dc*s;
         if (r < 0 || r >= rows || c < 0 || c >= cols || board[r][c] !== player) break;
         cells.push({ row: r, col: c });
      }
      for (let s = 1; s < 4; s++) {
         const r = row - dr*s, c = col - dc*s;
         if (r < 0 || r >= rows || c < 0 || c >= cols || board[r][c] !== player) break;
         cells.push({ row: r, col: c });
      }
      if (cells.length >= 4) return cells;
   }
   return null;
}

function isFull(board) {
   return board[0].every(c => c !== 0);
}

function getValidCols(board) {
   return board[0].map((_, i) => i).filter(c => canPlay(board, c));
}

function randomChoice(arr) {
   return arr[Math.floor(Math.random() * arr.length)];
}

// ── minimax (alpha-beta + transposition table) ─────────────────

function scoreWindow(win, player) {
   const opp = player === 1 ? 2 : 1;
   const pc = win.filter(c => c === player).length;
   const oc = win.filter(c => c === opp).length;
   const ec = win.filter(c => c === 0).length;
   if (pc === 4) return 100;
   if (pc === 3 && ec === 1) return 5;
   if (pc === 2 && ec === 2) return 2;
   if (oc === 3 && ec === 1) return -4;
   return 0;
}

function evaluateBoard(board, player) {
   const rows = board.length, cols = board[0].length;
   let score = 0;
   const mid = Math.floor(cols / 2);
   score += board.map(r => r[mid]).filter(c => c === player).length * 3;
   for (let r = 0; r < rows; r++)
      for (let c = 0; c <= cols - 4; c++)
         score += scoreWindow(board[r].slice(c, c + 4), player);
   for (let c = 0; c < cols; c++)
      for (let r = 0; r <= rows - 4; r++)
         score += scoreWindow([board[r][c], board[r+1][c], board[r+2][c], board[r+3][c]], player);
   for (let r = 0; r <= rows - 4; r++)
      for (let c = 0; c <= cols - 4; c++) {
         score += scoreWindow([board[r][c],board[r+1][c+1],board[r+2][c+2],board[r+3][c+3]], player);
         score += scoreWindow([board[r+3][c],board[r+2][c+1],board[r+1][c+2],board[r][c+3]], player);
      }
   return score;
}

function colOrder(cols) {
   return Array.from({ length: cols }, (_, i) => i)
      .sort((a, b) => Math.abs(a - Math.floor(cols / 2)) - Math.abs(b - Math.floor(cols / 2)));
}

function minimax(board, depth, isMax, alpha, beta, aiPlayer, tt) {
   const key = `${board.map(r => r.join('')).join('|')}_${depth}_${isMax ? 1 : 0}`;
   if (tt.has(key)) return tt.get(key);
   if (depth === 0 || isFull(board)) {
      const s = evaluateBoard(board, aiPlayer); tt.set(key, s); return s;
   }
   let best = isMax ? -Infinity : Infinity;
   for (const col of colOrder(board[0].length)) {
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
      undoPiece(board, row, col);
      if (isMax) {
         best = Math.max(best, score); alpha = Math.max(alpha, score);
         if (score >= WIN_SCORE) break;
      } else {
         best = Math.min(best, score); beta = Math.min(beta, score);
         if (score <= -WIN_SCORE) break;
      }
      if (beta <= alpha) break;
   }
   tt.set(key, best);
   return best;
}

function getBestMove(board, depth, aiPlayer) {
   const tt = new Map();
   let bestCol = null, bestScore = -Infinity;
   for (const col of colOrder(board[0].length)) {
      if (!canPlay(board, col)) continue;
      const row = dropPiece(board, col, aiPlayer);
      if (row === -1) continue;
      let score;
      if (checkWin(board, row, col, aiPlayer)) {
         score = WIN_SCORE + depth;
      } else {
         score = minimax(board, depth - 1, false, -Infinity, Infinity, aiPlayer, tt);
      }
      undoPiece(board, row, col);
      if (score > bestScore) { bestScore = score; bestCol = col; }
      if (bestScore >= WIN_SCORE) break;
   }
   return bestCol;
}

// ── board display ─────────────────────────────────────────────

function printBoard(board, winningCells = null) {
   const winSet = new Set((winningCells || []).map(c => `${c.row},${c.col}`));
   const cols = board[0].length;

   // column index header
   console.log('  ' + Array.from({ length: cols }, (_, i) => String(i + 1).padStart(2)).join(''));
   console.log('  ' + '───'.repeat(cols));

   for (let r = 0; r < board.length; r++) {
      const row = board[r].map((cell, c) => {
         const isWin = winSet.has(`${r},${c}`);
         if (cell === 1) return isWin ? '[R]' : ' R ';
         if (cell === 2) return isWin ? '[Y]' : ' Y ';
         return ' . ';
      }).join('');
      console.log(`${String(r + 1).padStart(2)}|${row}`);
   }
   console.log('  ' + '───'.repeat(cols));
}

// ── game simulation ───────────────────────────────────────────

function simulateGame({ ROWS, COLS, DEPTH_P1, DEPTH_P2, RANDOM_MOVES, VERBOSE }, gameIndex) {
   const board = makeBoard(ROWS, COLS);
   const signature = [];  // 1-indexed columns (matching trainingUtils format)
   let currentPlayer = 1;
   let winner = null;
   let winningCells = null;

   if (VERBOSE) {
      console.log(`\n${'─'.repeat(40)}`);
      console.log(`  GAME ${gameIndex}  |  ${ROWS}×${COLS}  |  P1=depth${DEPTH_P1}  P2=depth${DEPTH_P2}`);
      console.log(`${'─'.repeat(40)}`);
      printBoard(board);
   }

   for (let move = 0; move < ROWS * COLS; move++) {
      if (isFull(board)) break;

      const playerLabel = currentPlayer === 1 ? 'R' : 'Y';
      let col;
      let moveType;

      if (move < RANDOM_MOVES) {
         col = randomChoice(getValidCols(board));
         moveType = 'random';
      } else {
         const depth = currentPlayer === 1 ? DEPTH_P1 : DEPTH_P2;
         col = getBestMove(board, depth, currentPlayer);
         if (col === null) { col = randomChoice(getValidCols(board)); moveType = 'fallback'; }
         else moveType = `minimax d${depth}`;
      }

      const row = dropPiece(board, col, currentPlayer);
      signature.push(col + 1);  // convert 0-indexed → 1-indexed

      const won = checkWin(board, row, col, currentPlayer);

      if (VERBOSE) {
         const status = won ? '  ← WIN' : isFull(board) ? '  ← DRAW' : '';
         console.log(`  move ${String(move + 1).padStart(2)}  ${playerLabel}  col=${col + 1}  row=${row + 1}  [${moveType}]${status}`);
         printBoard(board, won ? getWinningCells(board, row, col, currentPlayer) : null);
      }

      if (won) {
         winner = currentPlayer;
         winningCells = getWinningCells(board, row, col, currentPlayer);
         if (VERBOSE) console.log(`  → ${playerLabel} wins after ${move + 1} moves`);
         break;
      }

      if (isFull(board)) {
         if (VERBOSE) console.log(`  → Draw — board full after ${move + 1} moves`);
         break;
      }

      currentPlayer = currentPlayer === 1 ? 2 : 1;

      if (VERBOSE) console.log(`  next: ${currentPlayer === 1 ? 'R' : 'Y'}`);
   }

   return {
      signature:      signature.join(''),
      joueur_depart:  'R',
      joueur_gagnant: winner === 1 ? 'R' : winner === 2 ? 'Y' : null,
      ligne_gagnante: winningCells ? JSON.stringify(winningCells) : null,
      status:         'finished',
      mode:           'standard',
      type_partie:    'auto',
      board_size:     `${ROWS}x${COLS}`,
   };
}

// ── main ──────────────────────────────────────────────────────

async function main() {
   const { NUM_GAMES, ROWS, COLS, DEPTH_P1, DEPTH_P2, RANDOM_MOVES } = CONFIG;

   console.log('=== Auto Game Generator ===');
   console.log(`Board: ${ROWS}×${COLS} | Games: ${NUM_GAMES} | Depth P1: ${DEPTH_P1}, P2: ${DEPTH_P2} | Random opening: ${RANDOM_MOVES} moves\n`);

   let inserted = 0, skipped = 0, errors = 0;
   const start = Date.now();

   const pad = String(NUM_GAMES).length;
   const tag = (i) => `[${String(i+1).padStart(pad)}/${NUM_GAMES}]`;
   const stats = () => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const pct = (((inserted + skipped + errors) / NUM_GAMES) * 100).toFixed(1);
      return `ins=${inserted} skip=${skipped} err=${errors} | ${pct}% | ${elapsed}s`;
   };

   for (let i = 0; i < NUM_GAMES; i++) {
      try {
         const gameData = simulateGame(CONFIG, i + 1);

         const dup = await checkGameExists(db, gameData.signature, COLS);
         if (dup.exists) {
            const dupInfo = dup.type === 'mirror'
               ? `mirror of ${dup.mirrorSignature?.slice(0, 12)}...`
               : `exact sig`;
            console.log(`${tag(i)} SKIP  ${dupInfo}  | ${stats()}`);
            skipped++;
            continue;
         }

         const partie = await insertPartie(gameData);

         let situationCount = 0;
         let situationWarn = '';
         try {
            const situations = generateSituation(gameData.signature);
            await insertSituations(partie.id_partie, situations);
            situationCount = situations.length;
         } catch (e) {
            situationWarn = `  ⚠ situations skipped: ${e.message}`;
         }

         inserted++;
         const result = gameData.joueur_gagnant ? `${gameData.joueur_gagnant} wins` : 'draw';
         console.log(`${tag(i)}   OK  id=${partie.id_partie}  ${result}  ${gameData.signature.length} moves  +${situationCount} sit  | ${stats()}`);
         logToFile(`inserted=${inserted}  id=${partie.id_partie}  signature=${gameData.signature}`);
         if (situationWarn) console.warn(situationWarn);

      } catch (err) {
         errors++;
         console.error(`${tag(i)}  ERR  ${err.message}  | ${stats()}`);
      }
   }

   const elapsed = ((Date.now() - start) / 1000).toFixed(1);
   console.log(`\n=== Summary (${elapsed}s) ===`);
   console.log(`Inserted : ${inserted}`);
   console.log(`Skipped  : ${skipped} (duplicates)`);
   console.log(`Errors   : ${errors}`);

   await db.destroy();
}

main();
