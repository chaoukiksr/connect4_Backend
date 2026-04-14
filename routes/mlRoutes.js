'use strict';

const express = require('express');
const router = express.Router();
const { getStatus, getMLMove, analysePosition } = require('../controllers/mlController');

router.get('/status', getStatus);
router.post('/move', getMLMove);
router.post('/analyse', analysePosition);

module.exports = router;
