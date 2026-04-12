const db = require('../config/db');
const zaloPayService = require('../services/zaloPayService');
const paypalService = require('../services/paypalService');
const NotificationService = require('../services/notificationService');

exports.getDepositPage = async (req, res) => {
    try {
        const user = req.session.user;
        const role = user.role; // 'employer' or 'freelancer'

        // Fetch active payment methods
        const [methods] = await db.query(
            "SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY id ASC"
        );

        const viewPath = role === 'employer' ? 'employer/deposit' : 'freelancer/deposit';

        return res.render(viewPath, {
            user: user,
            paymentMethods: methods || [],
            success_msg: req.flash('success_msg'),
            error_msg: req.flash('error_msg')
        });
    } catch (error) {
        console.error(error);
        return res.status(500).send('Server Error');
    }
};

exports.getWithdrawPage = async (req, res) => {
    try {
        const user = req.session.user;
        const role = user.role;

        const viewPath = role === 'employer' ? 'employer/withdraw' : 'freelancer/withdraw';
        return res.render(viewPath, {
            user: user,
            success_msg: req.flash('success_msg'),
            error_msg: req.flash('error_msg')
        });
    } catch (error) {
        console.error(error);
        return res.status(500).send('Server Error');
    }
};

exports.processWithdraw = async (req, res) => {
    try {
        const user = req.session.user;
        const role = user.role;
        const { amount, paypalEmail } = req.body;

        const withdrawAmount = Number(amount);
        const minWithdraw = 100;

        const emailRaw = (paypalEmail !== undefined && paypalEmail !== null) ? String(paypalEmail).trim() : '';

        if (!Number.isFinite(withdrawAmount) || withdrawAmount < minWithdraw) {
            req.flash('error_msg', `Minimum withdraw amount is ${minWithdraw} Credits`);
            return res.redirect(`/${role}/withdraw`);
        }

        if (!emailRaw || !emailRaw.includes('@') || emailRaw.length > 190) {
            req.flash('error_msg', 'Please enter a valid PayPal email');
            return res.redirect(`/${role}/withdraw`);
        }

        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();

            const [upd] = await conn.query(
                'UPDATE users SET balance = balance - ?, locked_balance = locked_balance + ? WHERE id = ? AND balance >= ?',
                [withdrawAmount, withdrawAmount, user.id, withdrawAmount]
            );

            const affected = upd && typeof upd.affectedRows === 'number' ? upd.affectedRows : 0;
            if (affected < 1) {
                await conn.rollback();
                req.flash('error_msg', 'Insufficient balance');
                return res.redirect(`/${role}/withdraw`);
            }

            const desc = `Withdrawal request to PayPal: ${emailRaw}`;
            const [txIns] = await conn.query(
                `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
                 VALUES (?, ?, 'withdrawal', 'pending', ?, NOW())`,
                [user.id, withdrawAmount, desc]
            );

            const transactionId = txIns && txIns.insertId ? Number(txIns.insertId) : null;

            await conn.query(
                `INSERT INTO withdraw_requests (user_id, role, method, paypal_email, amount_credits, fee_credits, net_credits, status, transaction_id, created_at)
                 VALUES (?, ?, 'paypal', ?, ?, 0.00, ?, 'pending', ?, NOW())`,
                [user.id, role, emailRaw, withdrawAmount, withdrawAmount, transactionId]
            );

            await conn.commit();
        } catch (err) {
            try {
                await conn.rollback();
            } catch (rollbackErr) {
                console.error('Withdraw rollback error:', rollbackErr);
            }
            throw err;
        } finally {
            if (conn) conn.release();
        }

        await NotificationService.createPersonal(
            user.id,
            'Withdrawal Requested',
            `We received your withdrawal request for ${withdrawAmount} Credits to PayPal (${emailRaw}). Your funds are reserved and the request is awaiting admin approval.`,
            'info',
            `/${role}/withdraw`
        );

        req.flash('success_msg', 'Withdrawal request created. It will be processed by admin shortly.');
        return res.redirect(`/${role}/withdraw`);
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Server Error');
        const role = (req.session && req.session.user && req.session.user.role) ? req.session.user.role : 'freelancer';
        return res.redirect(`/${role}/withdraw`);
    }
};

exports.processDeposit = async (req, res) => {
    try {
        const user = req.session.user;
        const { amount, paymentMethodCode } = req.body;
        const depositAmount = Number(amount);

        if (!depositAmount || depositAmount <= 0) {
            req.flash('error_msg', 'Invalid amount');
            return res.redirect(`/${user.role}/deposit`);
        }

        // Get Payment Method details
        const [methods] = await db.query(
            "SELECT * FROM payment_methods WHERE code = ? AND is_active = 1 LIMIT 1",
            [paymentMethodCode]
        );

        if (!methods.length) {
            req.flash('error_msg', 'Invalid payment method');
            return res.redirect(`/${user.role}/deposit`);
        }

        const method = methods[0];
        const exchangeRate = Number(method.exchange_rate);
        
        // Calculate converted amount (Credits)
        // If method currency is same as system currency (e.g. USD -> Credits 1:1), conversion is simple.
        // If method is VND (24000), and user inputs 10 Credits:
        // Wait, the UI asks for "Amount (Credits)".
        // So we need to calculate how much they need to pay in the Gateway Currency.
        
        // Scenario: User inputs 10 Credits.
        // Method: Momo (VND, Rate 24000).
        // User needs to pay: 10 * 24000 = 240,000 VND.
        
        const amountToPay = depositAmount * exchangeRate;
        
        // Mock Processing (Simulate success)
        // In real world, we would redirect to Payment Gateway URL here.
        // For Bank Transfer, we show instructions.
        
        if (method.type === 'bank_transfer') {
            // Create pending deposit
            await db.query(
                `INSERT INTO deposits (user_id, payment_method_code, amount, currency, exchange_rate, converted_amount, status, notes)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
                [user.id, method.code, amountToPay, method.currency, exchangeRate, depositAmount, 'Please transfer to: ' + JSON.stringify(method.config)]
            );
            
            // Redirect to a "Pending/Instruction" page or show message
            req.flash('success_msg', `Please transfer ${amountToPay.toLocaleString()} ${method.currency} to the bank account listed. Your balance will be updated after approval.`);
            return res.redirect(`/${user.role}/deposit`);
        }

        // --- PAYPAL INTEGRATION ---
        if (method.code === 'paypal') {
            try {
                // Save pending deposit first
                const tempOrderId = 'PAYPAL_PENDING_' + Date.now();
                await db.query(
                    `INSERT INTO deposits (user_id, payment_method_code, amount, currency, exchange_rate, converted_amount, transaction_id, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
                    [user.id, method.code, amountToPay, method.currency, exchangeRate, depositAmount, tempOrderId]
                );
                
                // Get inserted ID to use as Reference ID
                const [rows] = await db.query("SELECT LAST_INSERT_ID() as id");
                const internalOrderId = rows[0].id.toString();

                const order = await paypalService.createOrder(internalOrderId, amountToPay);
                
                // Update transaction_id with PayPal Order ID
                await db.query("UPDATE deposits SET transaction_id = ? WHERE id = ?", [order.id, internalOrderId]);

                // Redirect to PayPal Approval URL
                const approveLink = order.links.find(link => link.rel === 'approve');
                if (approveLink) {
                    return res.redirect(approveLink.href);
                } else {
                    throw new Error('No approval link found in PayPal response');
                }

            } catch (err) {
                console.error('PayPal Error:', err);
                req.flash('error_msg', 'Could not initiate PayPal payment. Please try again.');
                return res.redirect(`/${user.role}/deposit`);
            }
        } else if (method.code === 'zalopay') {
            // --- ZALOPAY INTEGRATION ---
            const now = new Date();
            const transID = `${now.getFullYear().toString().substring(2)}${('0' + (now.getMonth() + 1)).slice(-2)}${('0' + now.getDate()).slice(-2)}_${Date.now()}`;
            const description = `Deposit ${depositAmount} Credits to Vamper`;
            
            try {
                // Save pending deposit first
                await db.query(
                    `INSERT INTO deposits (user_id, payment_method_code, amount, currency, exchange_rate, converted_amount, transaction_id, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
                    [user.id, method.code, amountToPay, method.currency, exchangeRate, depositAmount, transID]
                );

                const paymentResult = await zaloPayService.createPayment(transID, Math.round(amountToPay), description);
                
                if (paymentResult && paymentResult.order_url) {
                    return res.redirect(paymentResult.order_url);
                } else {
                    throw new Error(paymentResult.return_message || 'ZaloPay initiation failed');
                }
            } catch (err) {
                console.error('ZaloPay Error:', err);
                req.flash('error_msg', 'Could not initiate ZaloPay payment. Please try again.');
                return res.redirect(`/${user.role}/deposit`);
            }
        } else {
            // For E-Wallets/Cards (Mock Success for others)
            const transactionId = 'TXN-' + Date.now();
            
            await db.query(
                `INSERT INTO deposits (user_id, payment_method_code, amount, currency, exchange_rate, converted_amount, transaction_id, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'completed')`,
                [user.id, method.code, amountToPay, method.currency, exchangeRate, depositAmount, transactionId]
            );

            // Update User Balance
            await db.query(
                "UPDATE users SET balance = balance + ? WHERE id = ?",
                [depositAmount, user.id]
            );
            
            // Record Transaction
            await db.query(
                `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
                 VALUES (?, ?, 'deposit', 'completed', ?, NOW())`,
                [user.id, depositAmount, `Deposit via ${method.name}`]
            );

            req.flash('success_msg', `Successfully deposited ${depositAmount} Credits!`);
            return res.redirect(`/${user.role}/deposit`);
        }

    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Server Error');
        const role = (req.session && req.session.user && req.session.user.role) ? req.session.user.role : 'freelancer';
        return res.redirect(`/${role}/deposit`);
    }
};

exports.paypalReturn = async (req, res) => {
    try {
        const { token, PayerID } = req.query;
        
        // Capture order
        let captureData;
        try {
            if (paypalService.useMock) {
                captureData = await paypalService.captureOrder(token);
            } else {
                 const request = new (require('@paypal/checkout-server-sdk')).orders.OrdersCaptureRequest(token);
                 request.requestBody({});
                 const client = require('../services/paypalService').client;
                 const response = await client.execute(request);
                 captureData = response.result;
            }
        } catch (e) {
             console.error("PayPal Capture Failed", e);
             throw e;
        }

        if (captureData.status === 'COMPLETED') {
            const purchaseUnits = captureData.purchase_units;
            const purchaseUnit = purchaseUnits && purchaseUnits.length > 0 ? purchaseUnits[0] : null;
            const payments = purchaseUnit ? purchaseUnit.payments : null;
            const captures = payments ? payments.captures : null;
            const captureId = captures && captures.length > 0 ? captures[0].id : 'UNKNOWN';
            
            // Find deposit request
            const [deposits] = await db.query(
                "SELECT * FROM deposits WHERE transaction_id = ? AND status = 'pending' LIMIT 1",
                [token]
            );

            if (deposits.length > 0) {
                const deposit = deposits[0];
                const userId = deposit.user_id;
                const creditAmount = deposit.converted_amount;

                // Update Deposit Status
                await db.query(
                    "UPDATE deposits SET status = 'completed', notes = ? WHERE id = ?",
                    [JSON.stringify(captureData), deposit.id]
                );

                // Add Balance
                await db.query(
                    "UPDATE users SET balance = balance + ? WHERE id = ?",
                    [creditAmount, userId]
                );

                // Record Transaction
                await db.query(
                    `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
                     VALUES (?, ?, 'deposit', 'completed', ?, NOW())`,
                    [userId, creditAmount, `Deposit via PayPal (Capture: ${captureId})`]
                );

                // Create Notification
                await NotificationService.createPersonal(
                    userId,
                    'Deposit Successful',
                    `You have successfully deposited ${creditAmount} Credits via PayPal.`,
                    'success',
                    '/freelancer/dashboard' // Or any relevant link
                );
            }

            req.flash('success_msg', 'PayPal Payment Successful!');
            const role = (req.session && req.session.user && req.session.user.role) ? req.session.user.role : 'freelancer';
            return res.redirect(`/${role}/deposit`);
        } else {
             throw new Error('Payment not completed');
        }
    } catch (error) {
        console.error("PayPal Return Error:", error);
        req.flash('error_msg', `PayPal Payment Failed: ${error.message}`);
        const role = (req.session && req.session.user && req.session.user.role) ? req.session.user.role : 'freelancer';
        return res.redirect(`/${role}/deposit`);
    }
};

exports.paypalCancel = async (req, res) => {
    req.flash('error_msg', 'PayPal Payment Cancelled');
    const role = (req.session && req.session.user && req.session.user.role) ? req.session.user.role : 'freelancer';
    return res.redirect(`/${role}/deposit`);
};

exports.zaloPayCallback = async (req, res) => {
    try {
        const { data: dataStr, mac: reqMac } = req.body;
        
        const result = zaloPayService.verifyCallback(req.body);

        if (!result.isValid) {
            console.error("ZaloPay Invalid MAC");
            return res.json({ return_code: -1, return_message: "mac not equal" });
        }
        
        const data = result.data;
        const app_trans_id = data.app_trans_id;

        // Check if transaction exists
        const [deposits] = await db.query(
            "SELECT * FROM deposits WHERE transaction_id = ? AND status = 'pending' LIMIT 1",
            [app_trans_id]
        );

        if (deposits.length === 0) {
            // Transaction already processed or not found
            return res.json({ return_code: 1, return_message: "success" });
        }

        const deposit = deposits[0];
        
        // Update Deposit Status
        await db.query(
            "UPDATE deposits SET status = 'completed', notes = ? WHERE id = ?",
            [JSON.stringify(req.body), deposit.id]
        );

        // Add Balance
        await db.query(
            "UPDATE users SET balance = balance + ? WHERE id = ?",
            [deposit.converted_amount, deposit.user_id]
        );

        // Record Transaction
        await db.query(
            `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
             VALUES (?, ?, 'deposit', 'completed', ?, NOW())`,
            [deposit.user_id, deposit.converted_amount, `Deposit via ZaloPay (TransID: ${app_trans_id})`]
        );

        // Create Notification
        await NotificationService.createPersonal(
            deposit.user_id,
            'Deposit Successful',
            `You have successfully deposited ${deposit.converted_amount} Credits via ZaloPay.`,
            'success',
            '/freelancer/dashboard'
        );

        return res.json({ return_code: 1, return_message: "success" });
    } catch (error) {
        console.error("ZaloPay Callback Error:", error);
        return res.json({ return_code: 0, return_message: error.message });
    }
};

exports.zaloPayRedirect = async (req, res) => {
    // Redirect from ZaloPay Gateway
    const { appid, apptransid, pmcid, bankcode, amount, discountamount, status, checksum } = req.query;
    
    // Check status (1 = success)
    if (Number(status) === 1) {
         return res.send(`
            <script>
                alert('Payment Successful!');
                window.location.href = '/'; 
            </script>
        `);
    } else {
        return res.send(`
            <script>
                alert('Payment Failed or Cancelled');
                window.location.href = '/'; 
            </script>
        `);
    }
};
