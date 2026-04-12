const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

router.get('/login', authController.loginPage);
router.post('/login', authController.loginValidation, authController.login);
router.get('/register', authController.registerPage);
router.post('/register', authController.registerValidation, authController.register);
router.get('/logout', authController.logout);

router.get('/forgot-password', authController.forgotPasswordPage);
router.post('/forgot-password', authController.forgotPassword);
router.get('/reset-password', authController.resetPasswordPage);
router.post('/reset-password', authController.resetPassword);

const authMiddleware = require('../middlewares/authMiddleware');

router.get('/sessions', authMiddleware.isAuthenticated, authController.getSessions);
router.post('/sessions/revoke', authMiddleware.isAuthenticated, authController.revokeSession);

module.exports = router;
