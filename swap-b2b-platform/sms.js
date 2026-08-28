/* =====================================================================
   B2B SWAP — real SMS delivery via Twilio

   If TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER are all
   set in .env, real SMS is sent. Otherwise every call resolves with
   { sent:false, reason:'not_configured' } and the message is logged to
   the console instead — the platform stays fully usable without Twilio,
   it just can't text anyone yet.

   Note for US numbers: Twilio requires A2P 10DLC campaign registration
   before it will deliver business SMS at real volume. Low-volume testing
   works without it. See https://www.twilio.com/docs/messaging/compliance/a2p-10dlc
   ===================================================================== */
'use strict';

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
const from = process.env.TWILIO_FROM_NUMBER;
const isConfigured = !!(sid && token && from);

let client = null;
if (isConfigured) {
  client = require('twilio')(sid, token);
} else {
  console.warn('[sms] TWILIO_* env vars not set — running with SMS delivery DISABLED. ' +
    'SMS will be logged to the console instead of sent. See .env.example.');
}

async function sendSms({ to, body }) {
  if (!isConfigured) {
    console.log(`[sms:DISABLED] would text ${to} — "${body}"`);
    return { sent: false, reason: 'not_configured' };
  }
  try {
    await client.messages.create({ to, from, body });
    return { sent: true };
  } catch (err) {
    console.error('[sms] send failed:', err.message);
    return { sent: false, reason: 'send_error', error: err.message };
  }
}

module.exports = { sendSms, isConfigured };
