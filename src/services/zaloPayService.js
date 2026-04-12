const axios = require('axios');
const CryptoJS = require('crypto-js');
const moment = require('moment'); // We might need moment or just use Date

class ZaloPayService {
    constructor() {
        this.app_id = process.env.ZALO_APP_ID || "2554"; // Sandbox AppID
        this.key1 = process.env.ZALO_KEY1 || "sdngKKJmqEMzvh5QQcdD2A9XBSKq80v0"; // Sandbox Key1
        this.key2 = process.env.ZALO_KEY2 || "trMrHtvjo6myautxDUiAcYsVtaeQ8nhf"; // Sandbox Key2
        this.endpoint = process.env.ZALO_ENDPOINT || "https://sb-openapi.zalopay.vn/v2/create";
        this.callback_url = process.env.ZALO_CALLBACK_URL || "https://your-domain.com/payment/zalopay/callback";
        this.redirect_url = process.env.ZALO_REDIRECT_URL || "https://your-domain.com/payment/zalopay/redirect";
    }

    async createPayment(app_trans_id, amount, description, embed_data = {}, item = []) {
        const config = {
            app_id: this.app_id,
            app_user: "VamperUser",
            app_time: Date.now(), // miliseconds
            amount: amount,
            app_trans_id: app_trans_id, // format: yyMMdd_xxxx
            embed_data: JSON.stringify({ ...embed_data, redirecturl: this.redirect_url }),
            item: JSON.stringify(item),
            description: description,
            bank_code: "", // Optional
            callback_url: this.callback_url
        };

        // Mac String: app_id|app_trans_id|app_user|amount|app_time|embed_data|item
        const data = config.app_id + "|" + config.app_trans_id + "|" + config.app_user + "|" + config.amount + "|" + config.app_time + "|" + config.embed_data + "|" + config.item;
        
        config.mac = CryptoJS.HmacSHA256(data, this.key1).toString();

        try {
            const response = await axios.post(this.endpoint, null, { params: config });
            return response.data;
        } catch (error) {
            console.error("ZaloPay Create Payment Error:", error.response ? error.response.data : error.message);
            throw error;
        }
    }

    verifyCallback(body) {
        try {
            const { data: dataStr, mac: reqMac } = body;
            
            const mac = CryptoJS.HmacSHA256(dataStr, this.key2).toString();
            
            if (reqMac !== mac) {
                return { isValid: false, message: "Invalid MAC" };
            }
            
            return { isValid: true, data: JSON.parse(dataStr) };
        } catch (e) {
             return { isValid: false, message: "Exception: " + e.message };
        }
    }
}

module.exports = new ZaloPayService();
