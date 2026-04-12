const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const authMiddleware = require('../middlewares/authMiddleware');
const adminController = require('../controllers/adminController');

// Multer for banner image uploads
const bannerStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/img')),
    filename: (req, file, cb) => cb(null, 'banner-' + Date.now() + path.extname(file.originalname))
});
const uploadBanner = multer({ storage: bannerStorage, limits: { fileSize: 2 * 1024 * 1024 } });

router.use(authMiddleware.isAuthenticated);
router.use(authMiddleware.restrictTo('admin'));

router.get('/', adminController.index);
router.get('/analytics', adminController.analyticsPage);

// User Management
router.get('/users', adminController.users);
router.get('/users/create', adminController.createUser);
router.post('/users/store', adminController.storeUser);
router.get('/users/edit/:id', adminController.editUser);
router.post('/users/update/:id', adminController.updateUser);
router.post('/users/delete/:id', adminController.deleteUser);
router.post('/users/block/:id', adminController.blockUser);
router.post('/users/unblock/:id', adminController.unblockUser);

router.get('/menus', adminController.menus);
router.get('/menus/create', adminController.createMenu);
router.get('/menus/edit/:id', adminController.editMenu);
router.get('/menu-items/create', adminController.createMenuItem);
router.get('/menu-items/edit/:id', adminController.editMenuItem);
router.post('/menus/store', adminController.storeMenu);
router.post('/menus/locations/save', adminController.saveMenuLocations);
router.post('/menus/update/:id', adminController.updateMenu);
router.post('/menus/delete/:id', adminController.deleteMenu);
router.post('/menu-items/store', adminController.storeMenuItem);
router.post('/menu-items/update/:id', adminController.updateMenuItem);
router.post('/menu-items/delete/:id', adminController.deleteMenuItem);

router.get('/security', adminController.securityPage);
router.post('/security/account-limits/save', adminController.saveAccountLimits);
router.get('/withdrawals', adminController.withdrawalsPage);
router.post('/withdrawals/:id/approve', adminController.approveWithdrawal);
router.post('/withdrawals/:id/reject', adminController.rejectWithdrawal);
router.post('/withdrawals/:id/mark-paid', adminController.markWithdrawalPaid);

router.get('/disputes', adminController.disputesPage);
router.get('/disputes/:id', adminController.disputeDetailPage);
router.post('/disputes/:id/under-review', adminController.disputeMarkUnderReview);
router.post('/disputes/:id/resolve', adminController.disputeResolve);
router.post('/disputes/:id/reject', adminController.disputeReject);
router.post('/disputes/:id/ban-temp', adminController.disputeBanTemp);
router.post('/disputes/:id/ban-perm', adminController.disputeBanPerm);
router.post('/disputes/:id/unban', adminController.disputeUnban);
router.post('/disputes/:id/refund-employer', adminController.disputeRefundEmployer);
router.post('/disputes/:id/pay-freelancer', adminController.disputePayFreelancer);

router.get('/reports', adminController.disputesPage);
router.get('/reports/:id', adminController.disputeDetailPage);
router.post('/reports/:id/under-review', adminController.disputeMarkUnderReview);
router.post('/reports/:id/resolve', adminController.disputeResolve);
router.post('/reports/:id/reject', adminController.disputeReject);
router.post('/reports/:id/ban-temp', adminController.disputeBanTemp);
router.post('/reports/:id/ban-perm', adminController.disputeBanPerm);
router.post('/reports/:id/unban', adminController.disputeUnban);
router.post('/reports/:id/refund-employer', adminController.disputeRefundEmployer);
router.post('/reports/:id/pay-freelancer', adminController.disputePayFreelancer);
router.post('/security/rules', adminController.createContentFilterRule);
router.post('/security/rules/:id/update', adminController.updateContentFilterRule);
router.post('/security/rules/:id/delete', adminController.deleteContentFilterRule);

router.get('/paypal-settings', adminController.paypalSettingsPage);
router.post('/paypal-settings/update', adminController.updatePaypalSettings);

router.get('/captcha-settings', adminController.captchaSettingsPage);
router.post('/captcha-settings/update', adminController.updateCaptchaSettings);

router.get('/settings', adminController.systemSettingsPage);
router.post('/settings/update', adminController.updateSystemSettings);
router.post('/settings/test-email', adminController.testEmail);

router.get('/boost-views', adminController.boostViewsPage);
router.post('/boost-views/apply', adminController.applyBoostViews);

router.get('/roles', adminController.rolesPage);
router.post('/users/:id/role', adminController.updateUserRole);

router.get('/plans', adminController.plansPage);
router.post('/plans/:id/update', adminController.updatePlan);

router.get('/transactions', adminController.transactionsPage);

router.get('/banners', adminController.bannersPage);
router.post('/banners/store', uploadBanner.single('image'), adminController.storeBanner);
router.post('/banners/:id/update', uploadBanner.single('image'), adminController.updateBanner);
router.post('/banners/:id/toggle', adminController.toggleBanner);
router.post('/banners/:id/delete', adminController.deleteBanner);

router.get('/skills', adminController.skillsPage);
router.post('/skills/store', adminController.storeSkill);
router.post('/skills/:id/update', adminController.updateSkill);
router.post('/skills/:id/delete', adminController.deleteSkill);

router.get('/proposals', adminController.proposalsPage);

router.get('/contracts', adminController.contractsPage);

router.get('/reviews', adminController.reviewsPage);
router.post('/reviews/:id/delete', adminController.deleteReview);

router.get('/jobs', adminController.jobsModerationPage);
router.post('/jobs/:id/toggle-status', adminController.toggleJobStatus);
router.post('/jobs/:id/delete', adminController.deleteJob);

router.get('/categories', adminController.categoriesPage);
router.post('/categories/store', adminController.storeCategory);
router.post('/categories/:id/update', adminController.updateCategory);
router.post('/categories/:id/delete', adminController.deleteCategory);

module.exports = router;
