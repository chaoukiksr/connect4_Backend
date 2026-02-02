const express = require('express');
const router = express.Router();

// GET /api/games - Get all games
router.get('/', async (req, res) => {
   try {
      // For now, return empty array (we'll add database later)
      res.json({ message: 'Games route working!', games: [] });
   } catch (error) {
      res.status(500).json({ error: error.message });
   }
});

router.post('/api/games', (req,res)=>{
   const body = req.body
})

module.exports = router;
