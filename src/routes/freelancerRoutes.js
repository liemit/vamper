const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authMiddleware = require('../middlewares/authMiddleware');

const freelancerController = require('../controllers/freelancerController');
const paymentController = require('../controllers/paymentController');
const notificationController = require('../controllers/notificationController');
const disputeController = require('../controllers/disputeController');

const multer = require('multer');

const path = require('path');



const storage = multer.diskStorage({

    destination: function (req, file, cb) {

        cb(null, path.join(__dirname, '../public/img'));

    },

    filename: function (req, file, cb) {

        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);

        const ext = path.extname(file.originalname || '');

        const safeExt = ext ? ext : '';

        const prefix = file && file.fieldname === 'avatar' ? 'avatar-' : (file && file.fieldname === 'cv' ? 'cv-' : 'file-');

        cb(null, prefix + uniqueSuffix + safeExt);

    }

});

const msgStorage = multer.diskStorage({

    destination: function (req, file, cb) {

        cb(null, path.join(__dirname, '../public/img'));

    },

    filename: function (req, file, cb) {

        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);

        cb(null, 'msg-' + uniqueSuffix + path.extname(file.originalname || ''));

    }

});

const hardCapMb = Number(process.env.MESSAGE_HARD_CAP_MB || 1024);
const msgMaxBytes = (Number.isFinite(hardCapMb) && hardCapMb > 0 ? hardCapMb : 1024) * 1024 * 1024;

const uploadMsg = multer({

    storage: msgStorage,

    limits: { fileSize: msgMaxBytes },

    fileFilter: (req, file, cb) => {

        return cb(null, true);

    }

});

const uploadMsgSingle = (req, res, next) => {
    return uploadMsg.single('attachment')(req, res, (err) => {
        if (err) {
            if (err && err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ ok: false, error: 'File too large' });
            }
            return res.status(400).json({ ok: false, error: err.message || 'Upload error' });
        }
        return next();
    });
};

const disputeStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, '../public/img'));
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'dispute-' + uniqueSuffix + path.extname(file.originalname || ''));
    }
});

const disputeMaxMb = Number(process.env.DISPUTE_MAX_FILE_MB || 5);
const disputeMaxBytes = (Number.isFinite(disputeMaxMb) && disputeMaxMb > 0 ? disputeMaxMb : 5) * 1024 * 1024;

const uploadDispute = multer({
    storage: disputeStorage,
    limits: { fileSize: disputeMaxBytes, files: 5 },
    fileFilter: (req, file, cb) => {
        const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
        if (file && allowed.has(String(file.mimetype || '').toLowerCase())) return cb(null, true);
        return cb(new Error('Only jpg/png/webp images are allowed'));
    }
});

const uploadDisputeEvidence = (req, res, next) => {
    return uploadDispute.array('evidence', 5)(req, res, (err) => {
        if (err) {
            if (err && err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ ok: false, error: 'File too large' });
            }
            return res.status(400).json({ ok: false, error: err.message || 'Upload error' });
        }
        return next();
    });
};



const upload = multer({

    storage: storage,

    limits: { fileSize: 5 * 1024 * 1024 },

    fileFilter: (req, file, cb) => {

        if (file.fieldname === 'avatar') {

            if (file.mimetype && file.mimetype.startsWith('image/')) {

                return cb(null, true);

            }

            return cb(new Error('Only images are allowed for avatar'));

        }



        if (file.fieldname === 'cv') {

            const allowed = new Set([

                'application/pdf',

                'application/msword',

                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

            ]);

            if (allowed.has(file.mimetype)) {

                return cb(null, true);

            }

            return cb(new Error('Only PDF/DOC/DOCX are allowed for CV'));

        }



        return cb(null, false);

    }

});



router.use(authMiddleware.isAuthenticated);

router.use(authMiddleware.restrictTo('freelancer'));

router.post('/disputes/create', uploadDisputeEvidence, disputeController.createFreelancerDispute);



router.get('/', freelancerController.index);

router.get('/dashboard', freelancerController.dashboard);

router.get('/deposit', paymentController.getDepositPage);
router.post('/deposit', paymentController.processDeposit);

router.get('/withdraw', paymentController.getWithdrawPage);
router.post('/withdraw', paymentController.processWithdraw);

router.get('/jobs', freelancerController.jobs);

router.get('/jobs/:slug', freelancerController.jobDetail);

router.get('/categories/:slug', freelancerController.categoryJobs);

router.get('/profile', freelancerController.profile);

router.post('/profile', upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'cv', maxCount: 1 }]), freelancerController.saveProfile);

router.get('/notifications', notificationController.notificationsPage);

router.post('/proposals/apply', freelancerController.applyToJob);

router.get('/messages', freelancerController.messagesPage);
router.post('/messages/send', uploadMsgSingle, freelancerController.sendMessage);
router.get('/messages/poll', freelancerController.pollMessages);
router.post('/messages/upload', uploadMsgSingle, freelancerController.uploadAttachment);

router.post('/messages/delete-msg/:id', freelancerController.deleteMessage);

router.get('/plans', freelancerController.listPlans);
router.post('/plans/activate', freelancerController.activatePlan);
router.post('/plans/toggle-auto-renew', freelancerController.toggleAutoRenew);
router.get('/proposals', freelancerController.myProposals);

router.post('/proposals/:id/withdraw', freelancerController.withdrawProposal);

router.post('/proposals/:id/delete', freelancerController.deleteProposal);

router.get('/sessions', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const [rows] = await db.query('SELECT session_id, data FROM sessions');
        const sessions = [];
        rows.forEach(r => {
            try {
                let d;
                if (typeof r.data === 'string') {
                    d = JSON.parse(r.data);
                } else {
                    d = r.data;
                }
                
                if (d && d.user && d.user.id === userId) {
                    sessions.push({
                        id: r.session_id,
                        is_current: r.session_id === req.sessionID,
                        device: d.device || { os_browser: 'Unknown', ip: 'Unknown', login_time: null }
                    });
                }
            } catch (e) {
                console.error('Error parsing session data:', e);
            }
        });
        res.json({ ok: true, sessions });
    } catch (err) {
        console.error('Freelancer sessions error:', err);
        res.json({ ok: false, error: err.message });
    }
});

router.post('/sessions/revoke', freelancerController.logoutSession);

router.post('/change-password', freelancerController.changePassword);

module.exports = router;

