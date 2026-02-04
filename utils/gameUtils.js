module.exports = {
    getCanonicalSequence: (moveSequence, numCols) =>{
      let mirrored = moveSequence.split('').map(col => (numCols - 1) - parseInt(col)).join('');
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
   }
}