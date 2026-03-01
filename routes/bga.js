const express = require('express');
const bgaController = require('../controllers/bgaController');
const router = express.Router();

// GET /api/bga/:tableId  — scrape a BGA Connect Four table and return its move sequence
router.get('/:tableId', bgaController.scrape);

module.exports = router;
