module.exports = {
   generateSituation : (signature) =>{
      const ROWS = 9;
      const COLS = 9;

      // empty board
      const board = Array.from({ length: ROWS }, () =>
         Array(COLS).fill(0)
      );

      const situations = [];

      let currentPlayer = "R"; // or "Y"

      for (let moveIndex = 0; moveIndex < signature.length; moveIndex++) {
         const col = parseInt(signature[moveIndex]) - 1;

         // find lowest empty row
         for (let row = ROWS - 1; row >= 0; row--) {
            if (!board[row][col]) {
               board[row][col] = currentPlayer;
               break;
            }
         }

         // clone board snapshot
         const snapshot = board.map(r => [...r]);

         situations.push({
            numero_coup: moveIndex + 1,
            plateau: JSON.stringify(snapshot),
            joueur: currentPlayer
         });

         // switch player
         currentPlayer = currentPlayer === "R" ? "Y" : "R";
      }

      return situations;
   }
}

