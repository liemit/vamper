const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authMiddleware = require('../middlewares/authMiddleware');

const employerController = require('../controllers/employerController');
const paymentController = require('../controllers/paymentController');
const notificationController = require('../controllers/notificationController');
const disputeController = require('../controllers/disputeController');

const multer = require('multer');

const path = require('path');



// Configure Multer for file upload

const storage = multer.diskStorage({

    destination: function (req, file, cb) {

        cb(null, path.join(__dirname, '../public/img'));

    },

    filename: function (req, file, cb) {

        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);

        const prefix = file && file.fieldname === 'logo' ? 'company-' : 'job-';

        cb(null, prefix + uniqueSuffix + path.extname(file.originalname));

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

    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit

    fileFilter: (req, file, cb) => {

        if (file.mimetype.startsWith('image/')) {

            cb(null, true);

        } else {

            cb(new Error('Only images are allowed'));

        }

    }

});



router.use(authMiddleware.isAuthenticated);

router.use(authMiddleware.restrictTo('employer'));

router.post('/disputes/create', uploadDisputeEvidence, disputeController.createEmployerDispute);



router.get('/', employerController.index);

router.get('/deposit', paymentController.getDepositPage);
router.post('/deposit', paymentController.processDeposit);

router.get('/withdraw', paymentController.getWithdrawPage);
router.post('/withdraw', paymentController.processWithdraw);

router.get('/notifications', notificationController.notificationsPage);

router.get('/browse-jobs', employerController.browseJobsPage);
router.get('/browse-jobs/jobs/:slug', employerController.browseJobDetailPage);

router.get('/jobs', employerController.jobsPage);

router.get('/jobs/create', employerController.createJobPage);

router.get('/post-job', (req, res) => res.redirect('/employer/jobs/create'));

const uploadJobImagesMiddleware = (req, res, next) => {
    upload.array('images', 10)(req, res, (err) => {
        if (err) {
            console.error('Multer error during job images upload:', err);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ ok: false, error: 'One or more files are too large (Max 2MB)' });
            }
            if (err.code === 'LIMIT_UNEXPECTED_FILE') {
                return res.status(400).json({ ok: false, error: 'Too many files uploaded or wrong field name' });
            }
            return res.status(400).json({ ok: false, error: err.message || 'Upload error' });
        }
        next();
    });
};

router.post('/jobs/upload-image', uploadJobImagesMiddleware, employerController.uploadJobImage);

router.post('/jobs/create', upload.single('thumbnail'), employerController.createJob);

router.post('/jobs/delete/:id', employerController.deleteJob);

router.get('/jobs/edit/:id', employerController.editJobPage);

router.post('/jobs/edit/:id', upload.single('thumbnail'), employerController.updateJob);



router.get('/applications', employerController.applicationsPage);

router.get('/applications/freelancers/:id', employerController.freelancerApplicationProfile);
router.post('/applications/:id/status', employerController.updateApplicationStatus);



router.get('/company-profile', employerController.companyProfilePage);

router.post('/company-profile', upload.single('logo'), employerController.saveCompanyProfile);



router.get('/messages', employerController.messagesPage);

router.post('/messages/send', uploadMsgSingle, employerController.sendMessage);
router.get('/messages/poll', employerController.pollMessages);
router.post('/messages/upload', uploadMsgSingle, employerController.uploadAttachment);

router.post('/messages/delete-msg/:id', employerController.deleteMessage);

router.post('/messages/make-deposit', employerController.makeDeposit);
router.post('/messages/release-payment', employerController.releasePayment);
router.post('/messages/refund-deposit', employerController.refundDeposit);

// Hourly: End Contract (reset relationship)
router.post('/messages/end-contract', employerController.endContract);

// Timer Routes for Hourly Contracts
router.post('/messages/timer/start', employerController.startTimer);
router.post('/messages/timer/stop', employerController.stopTimer);
router.post('/messages/timer/sync', employerController.syncTimer);
router.post('/messages/timer/release-pending', employerController.releasePendingPayment);
router.post('/messages/timer/refund-pending', employerController.refundPendingPayment);
router.get('/messages/timer/status', employerController.getTimerStatus);

router.get('/plans', employerController.listPlans);
router.post('/plans/activate', employerController.activatePlan);



router.get('/timesheets/:id', employerController.timesheets);
router.post('/timesheets/approve/:tid', employerController.approveTimesheet);
router.post('/timesheets/reject/:tid', employerController.rejectTimesheet);
router.post('/proposals/:pid/update-rate', employerController.updateContractRate);

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
                console.error('Error parsing employer session data:', e);
            }
        });
        res.json({ ok: true, sessions });
    } catch (err) {
        console.error('Employer sessions error:', err);
        res.json({ ok: false, error: err.message });
    }
});

router.post('/sessions/revoke', employerController.logoutSession);

router.post('/change-password', employerController.changePassword);

module.exports = router;

