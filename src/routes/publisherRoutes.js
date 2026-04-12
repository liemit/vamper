const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const publisherController = require('../controllers/publisherController');

router.use(authMiddleware.isAuthenticated);
router.use(authMiddleware.restrictTo('publisher'));

router.get('/', publisherController.index);

module.exports = router;
