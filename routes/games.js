const express = require('express');
const gameController = require('../controllers/gameController');
const router = express.Router();

//get all the games
router.get('/', gameController.getAll);
router.post('/', gameController.create);
module.exports = router;
