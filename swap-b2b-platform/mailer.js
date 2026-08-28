/* =====================================================================
   B2B SWAP — real email delivery via SMTP (Nodemailer)

   Works with any SMTP provider: Gmail (App Password), SendGrid, Postmark,
   AWS SES SMTP, Resend, or a self-hosted mail server — set the SMTP_*
   variables in .env. If they are not set, email sending is skipped and
   every call resolves with { sent:false, reason:'not_configured' } so the
   rest of the app can degrade gracefully instead of crashing.
   ===================================================================== */
'use strict';

const nodemailer = require('nodemailer');

const isConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transporter = null;
if (isConfigured) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
} else {
  console.warn('[mailer] SMTP_* env vars not set — running with email delivery DISABLED. ' +
    'Emails will be logged to the console instead of sent. See .env.example.');
}

async function sendMail({ to, subject, text, html }) {
  if (!isConfigured) {
    console.log(`[mailer:DISABLED] would send to ${to} — subject: "${subject}"`);
    return { sent: false, reason: 'not_configured' };
  }
  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to, subject, text, html: html || undefined,
    });
    return { sent: true };
  } catch (err) {
    console.error('[mailer] send failed:', err.message);
    return { sent: false, reason: 'send_error', error: err.message };
  }
}

module.exports = { sendMail, isConfigured };
