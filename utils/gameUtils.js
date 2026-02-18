module.exports = {
    getCanonicalSequence: (moveSequence, numCols) =>{
      let mirrored = moveSequence.split('').map(col => (numCols + 1) - parseInt(col)).join('');
      return moveSequence < mirrored ? moveSequence : mirrored;
   },
   checkWin : (board, row, col, player, numRows, numCols) =>{
      const directions = [
         [0,1], //H
         [1,0], //V
         [1,1], // Diag left up to right down
         [1,-1], // Diag left down to right up
      ];

      for(const [dr,dc] of directions){
         let count = 1;
         
         //pos count
         for (let i = 1; i < 4 ; i++){
            const r = row + dr * i;
            const c = col + dc * i;
            if(r >= 0 && r < numRows && c >= 0 && c < numCols && board[r][c] === player){
               count++;
            }else{
               break;
            }
         }

         //neg count
         for(let i = 1; i < 4 ; i++){
            const r = row - dr * i;
            const c = col - dc * i;
            if(r >= 0 && r < numRows && c >= 0 && c < numCols && board[r][c]=== player){
               count++;
            }else{
               break;
            }
         }
         if (count >=4) return true
      }
      return false;
   },
   analyzeGame: (moveSequence, startingPlayer, numRows, numCols) => {
      // 1. Create empty board
      const board = Array(numRows).fill(null).map(() => Array(numCols).fill(0));
      let currentPlayer = startingPlayer;
      // 2. Replay each move
      for (let i = 0; i < moveSequence.length; i++) {
         const col = parseInt(moveSequence[i]);
          

         // 3. Find landing row (bottom to top)
         for (let row = numRows - 1; row >= 0; row--) {
            if (board[row][col] === 0) {
               // 4. Place piece
               board[row][col] = currentPlayer;

               // 5. Check win
               if (module.exports.checkWin(board, row, col, currentPlayer, numRows, numCols)) {
                  return {
                     status: 'completed',
                     result: currentPlayer === 1 ? 'player1_wins' : 'player2_wins'
                  };
               }
               break;
            }
         }
         currentPlayer = currentPlayer === 1 ? 2 : 1;
      }

      // 6. Check if board is full (draw) or in progress
      const isFull = board[0].every(cell => cell !== 0);
      return {
         status: isFull ? 'completed' : 'in_progress',
         result: isFull ? 'draw' : null
      };
   },

   /**
    * Generate mirror signature (flip board horizontally)
    * For a 7-column board: column 0↔6, 1↔5, 2↔4, 3 stays
    * Mirror of "4523333": 4→3, 5→2, 2→5, 3→4
    */
   generateMirrorSignature: (signature, cols = 7) => {
      if (!signature) return null;
      return signature.split('').map(col => {
         const colNum = parseInt(col, 10);
         if (isNaN(colNum)) return col;
         return String(cols - 1 - colNum);
      }).join('');
   },

   /**
    * Check if two signatures are equivalent (identical or mirrors)
    */
   areSignaturesEquivalent: (sig1, sig2, cols = 7) => {
      if (!sig1 || !sig2) return false;
      if (sig1 === sig2) return true;
      
      const mirrorSig1 = module.exports.generateMirrorSignature(sig1, cols);
      return mirrorSig1 === sig2;
   },

   /**
    * Check if a game already exists in database (original or mirror signature)
    * Returns: { exists: boolean, existing: gameObject|null, type: 'original'|'mirror'|null, mirrorSignature: string|null }
    */
   checkGameExists: async (db, signature, cols = 7) => {
      if (!signature) {
         return { exists: false, existing: null, type: null, mirrorSignature: null };
      }

      // Check if original signature exists
      const original = await db('partie').where('signature', signature).first();
      if (original) {
         return { exists: true, existing: original, type: 'original', mirrorSignature: null };
      }

      // Generate and check if mirror signature exists
      const mirrorSig = module.exports.generateMirrorSignature(signature, cols);
      if (mirrorSig && mirrorSig !== signature) {
         const mirror = await db('partie').where('signature', mirrorSig).first();
         if (mirror) {
            return { exists: true, existing: mirror, type: 'mirror', mirrorSignature: mirrorSig };
         }
      }

      return { exists: false, existing: null, type: null, mirrorSignature: null };
   }
}