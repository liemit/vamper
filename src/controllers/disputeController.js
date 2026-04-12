const db = require('../config/db');
const NotificationService = require('../services/notificationService');

function safeCategory(raw) {
    const s = (raw !== undefined && raw !== null) ? String(raw).trim().toLowerCase() : '';
    const allowed = new Set(['scam', 'non_payment', 'non_delivery', 'harassment', 'other']);
    return allowed.has(s) ? s : 'scam';
}

async function notifyAdmins(title, body, url) {
    try {
        const [admins] = await db.query(
            `SELECT id
             FROM users
             WHERE role = 'admin' AND is_active = 1
             ORDER BY id ASC
             LIMIT 50`
        );
        const list = Array.isArray(admins) ? admins : [];
        for (const a of list) {
            const adminId = a && a.id ? Number(a.id) : null;
            if (!adminId) continue;
            try {
                await NotificationService.createPersonal(
                    adminId,
                    title,
                    body,
                    'warning',
                    url
                );
            } catch (_) {}
        }
    } catch (_) {}
}

async function createDisputeCore({ creatorId, creatorRole, jobId, reportedUserId, proposalIdRaw, categoryRaw, messageRaw, files }) {
    const jobIdNum = Number(jobId);
    const reportedIdNum = Number(reportedUserId);

    if (!Number.isFinite(jobIdNum) || jobIdNum <= 0) {
        return { ok: false, status: 400, error: 'Invalid job_id' };
    }
    if (!Number.isFinite(reportedIdNum) || reportedIdNum <= 0) {
        return { ok: false, status: 400, error: 'Invalid reported_user_id' };
    }

    const msg = (messageRaw !== undefined && messageRaw !== null) ? String(messageRaw).trim() : '';
    if (!msg) {
        return { ok: false, status: 400, error: 'Message is required' };
    }

    const category = safeCategory(categoryRaw);

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [jobRows] = await conn.query(
            `SELECT id, title, employer_id, job_type
             FROM jobs
             WHERE id = ?
             LIMIT 1
             FOR UPDATE`,
            [jobIdNum]
        );
        const job = Array.isArray(jobRows) && jobRows.length ? jobRows[0] : null;
        if (!job) {
            await conn.rollback();
            return { ok: false, status: 404, error: 'Job not found' };
        }

        const employerId = Number(job.employer_id);
        const jobTitle = job.title ? String(job.title) : 'Job';

        let proposal = null;
        if (creatorRole === 'freelancer') {
            if (reportedIdNum !== employerId) {
                await conn.rollback();
                return { ok: false, status: 403, error: 'Reported user must be the employer of this job' };
            }
            const [propRows] = await conn.query(
                `SELECT id, freelancer_id, bid_amount, is_deposited, pending_balance
                 FROM proposals
                 WHERE job_id = ? AND freelancer_id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [jobIdNum, creatorId]
            );
            proposal = Array.isArray(propRows) && propRows.length ? propRows[0] : null;
        } else {
            if (creatorId !== employerId) {
                await conn.rollback();
                return { ok: false, status: 403, error: 'Unauthorized' };
            }
            const [propRows] = await conn.query(
                `SELECT id, freelancer_id, bid_amount, is_deposited, pending_balance
                 FROM proposals
                 WHERE job_id = ? AND freelancer_id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [jobIdNum, reportedIdNum]
            );
            proposal = Array.isArray(propRows) && propRows.length ? propRows[0] : null;
        }

        if (!proposal) {
            await conn.rollback();
            return { ok: false, status: 404, error: 'Proposal not found for this job' };
        }

        const proposalId = Number(proposal.id);
        const freelancerId = Number(proposal.freelancer_id);

        if (proposalIdRaw !== undefined && proposalIdRaw !== null && String(proposalIdRaw).trim() !== '') {
            const forced = Number(proposalIdRaw);
            if (Number.isFinite(forced) && forced > 0 && forced !== proposalId) {
                await conn.rollback();
                return { ok: false, status: 400, error: 'proposal_id mismatch' };
            }
        }

        // Try to link contract
        let contractId = null;
        try {
            const [cRows] = await conn.query(
                `SELECT id, status
                 FROM contracts
                 WHERE job_id = ? AND freelancer_id = ? AND employer_id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [jobIdNum, freelancerId, employerId]
            );
            const c = Array.isArray(cRows) && cRows.length ? cRows[0] : null;
            if (c && c.id) {
                contractId = Number(c.id);
                // Q2 = A: set disputed immediately
                await conn.query(
                    `UPDATE contracts
                     SET status = 'disputed'
                     WHERE id = ?`,
                    [contractId]
                );
            }
        } catch (_) {}

        const [ins] = await conn.query(
            `INSERT INTO disputes (created_by, reported_user_id, job_id, proposal_id, contract_id, category, message, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
            [creatorId, reportedIdNum, jobIdNum, proposalId, contractId, category, msg]
        );

        const disputeId = ins && ins.insertId ? Number(ins.insertId) : null;
        if (!disputeId) {
            await conn.rollback();
            return { ok: false, status: 500, error: 'Failed to create dispute' };
        }

        const evidenceFiles = Array.isArray(files) ? files : [];
        for (const f of evidenceFiles) {
            const filename = f && f.filename ? String(f.filename) : '';
            if (!filename) continue;
            const url = '/img/' + filename;
            await conn.query(
                `INSERT INTO dispute_attachments (dispute_id, url, kind)
                 VALUES (?, ?, 'image')`,
                [disputeId, url]
            );
        }

        await conn.commit();

        const creatorLabel = creatorRole === 'freelancer' ? 'Freelancer' : 'Employer';
        await notifyAdmins(
            'New Dispute Report',
            `${creatorLabel} submitted a dispute report for job: ${jobTitle}`,
            '/admin/disputes'
        );

        try {
            const toParam = creatorRole === 'freelancer' ? String(employerId) : String(freelancerId);
            const rolePath = creatorRole === 'freelancer' ? 'freelancer' : 'employer';
            const url = `/${rolePath}/messages?to=${encodeURIComponent(toParam)}&job=${encodeURIComponent(String(jobIdNum))}`;
            await NotificationService.createPersonal(
                creatorId,
                'Report submitted',
                `Your dispute report for job: ${jobTitle} has been submitted to admin.`,
                'info',
                url
            );
        } catch (_) {}

        return { ok: true, status: 200, id: disputeId };
    } catch (err) {
        try { await conn.rollback(); } catch (_) {}
        console.error(err);
        return { ok: false, status: 500, error: 'Server Error' };
    } finally {
        try { conn.release(); } catch (_) {}
    }
}

exports.createFreelancerDispute = async (req, res) => {
    const user = req.session.user;
    const r = await createDisputeCore({
        creatorId: Number(user.id),
        creatorRole: 'freelancer',
        jobId: req.body && req.body.job_id,
        reportedUserId: req.body && req.body.reported_user_id,
        proposalIdRaw: req.body && req.body.proposal_id,
        categoryRaw: req.body && req.body.category,
        messageRaw: req.body && req.body.message,
        files: req.files
    });
    return res.status(r.status).json(r.ok ? { ok: true, id: r.id } : { ok: false, error: r.error });
};

exports.createEmployerDispute = async (req, res) => {
    const user = req.session.user;
    const r = await createDisputeCore({
        creatorId: Number(user.id),
        creatorRole: 'employer',
        jobId: req.body && req.body.job_id,
        reportedUserId: req.body && req.body.reported_user_id,
        proposalIdRaw: req.body && req.body.proposal_id,
        categoryRaw: req.body && req.body.category,
        messageRaw: req.body && req.body.message,
        files: req.files
    });
    return res.status(r.status).json(r.ok ? { ok: true, id: r.id } : { ok: false, error: r.error });
};
