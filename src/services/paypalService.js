const checkoutNodeJssdk = require('@paypal/checkout-server-sdk');

class PaypalService {
    constructor() {
        this.clientId = process.env.PAYPAL_CLIENT_ID || 'ATe6...'; // Default Sandbox
        this.clientSecret = process.env.PAYPAL_CLIENT_SECRET || 'EM...'; // Default Sandbox
        this.environment = (process.env.PAYPAL_MODE === 'live')
            ? new checkoutNodeJssdk.core.LiveEnvironment(this.clientId, this.clientSecret)
            : new checkoutNodeJssdk.core.SandboxEnvironment(this.clientId, this.clientSecret);
        
        this.client = new checkoutNodeJssdk.core.PayPalHttpClient(this.environment);
        
        this.returnUrl = process.env.PAYPAL_RETURN_URL || 'http://localhost:3000/payment/paypal/return';
        this.cancelUrl = process.env.PAYPAL_CANCEL_URL || 'http://localhost:3000/payment/paypal/cancel';
        this.useMock = process.env.PAYPAL_USE_MOCK === 'true';
    }

    /**
     * Create an Order
     * @param {string} orderId Internal Order ID (for tracking)
     * @param {number} amount Amount in USD
     */
    async createOrder(orderId, amount) {
        if (this.useMock) {
            console.log("Using Mock PayPal Create Order");
            const mockToken = 'MOCK_TOKEN_' + Date.now();
            return {
                id: mockToken,
                status: 'CREATED',
                links: [
                    {
                        href: `${this.returnUrl}?token=${mockToken}&PayerID=MOCK_PAYER`,
                        rel: 'approve',
                        method: 'GET'
                    }
                ]
            };
        }

        const request = new checkoutNodeJssdk.orders.OrdersCreateRequest();
        request.prefer("return=representation");
        request.requestBody({
            intent: 'CAPTURE',
            purchase_units: [{
                reference_id: orderId,
                amount: {
                    currency_code: 'USD',
                    value: amount.toFixed(2)
                },
                description: `Deposit ${amount} Credits to Vamper`
            }],
            application_context: {
                return_url: this.returnUrl,
                cancel_url: this.cancelUrl,
                brand_name: 'Vamper Inc',
                user_action: 'PAY_NOW'
            }
        });

        try {
            const order = await this.client.execute(request);
            return order.result;
        } catch (err) {
            console.error('PayPal Create Order Error:', err);
            throw err;
        }
    }

    /**
     * Capture Payment
     * @param {string} paypalOrderId The Order ID returned by PayPal
     */
    async captureOrder(paypalOrderId) {
        if (this.useMock) {
            console.log("Using Mock PayPal Capture Order");
            return {
                status: 'COMPLETED',
                purchase_units: [{
                    payments: {
                        captures: [{
                            id: 'MOCK_CAPTURE_' + Date.now(),
                            status: 'COMPLETED'
                        }]
                    }
                }]
            };
        }

        const request = new checkoutNodeJssdk.orders.OrdersCaptureRequest(paypalOrderId);
        request.requestBody({});

        try {
            const capture = await this.client.execute(request);
            return capture.result;
        } catch (err) {
            console.error('PayPal Capture Error:', err);
            throw err;
        }
    }
}

module.exports = new PaypalService();
