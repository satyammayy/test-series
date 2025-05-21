// app.js
const express = require('express');
const crypto = require('crypto');
const dotenv = require('dotenv');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  getUrlInfo,
  DisconnectReason
} = require('@whiskeysockets/baileys');

dotenv.config();

const PORT = process.env.PORT || 3000;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = 'Sheet1';

if (!SHEET_ID) throw new Error('Missing SHEET_ID in .env');

// Google Sheets auth
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

async function getClient() {
  return auth.getClient();
}

// compute last roll
async function getLastRollNumber() {
  const client = await getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!B2:B`
  });
  const rows = res.data.values || [];
  const count = rows.filter(r => r[0] && !isNaN(r[0])).length;
  return 1000 + count;
}

// check duplicates by paymentId in column C
async function hasProcessed(paymentId) {
  const client = await getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!C2:C`
  });
  const ids = (res.data.values || []).flat();
  return ids.includes(paymentId);
}

// append row
async function appendToSheet(paymentData, rollStr) {
  const client = await getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const row = [
    new Date().toLocaleString('en-IN'),
    rollStr,
    paymentData.paymentId,
    paymentData.name,
    paymentData.email,
    paymentData.contact,
    paymentData.dob,
    paymentData.guardian_name,
    paymentData.address,
    paymentData.amount,
    paymentData.method
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:K`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
}

// WhatsApp (Baileys) setup
let sockPromise;
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      console.log('📸 Scan this QR code:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) sockPromise = startSock();
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp ready');
    }
  });

  await new Promise(res => sock.ev.on('connection.update', u => u.connection === 'open' && res()));
  return sock;
}
function getSocket() {
  if (!sockPromise) sockPromise = startSock();
  return sockPromise;
}
function cleanIndianMobile(raw) {
  let n = String(raw).replace(/[^0-9]/g, '').replace(/^0+/, '');
  if (n.length === 10) return '91' + n;
  if (/^91\d{10}$/.test(n)) return n;
  throw new Error(`Invalid Indian mobile number: ${raw}`);
}

async function sendWhatsAppMessage(paymentData, roll) {
  const sock = await getSocket();
  const { orderId, paymentId, amount, currency, method, email, contact, notes = {} } = paymentData;

  const jid = `${cleanIndianMobile(notes.whatsapp_number || contact)}@s.whatsapp.net`;
  const text =
    `💳 *GENESIS BIOLOGY PAYMENT RECEIPT*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ *Payment Captured*\n\n` +
    `📄 *Order ID:* ${orderId}\n` +
    `💳 *Payment ID:* ${paymentId}\n` +
    `🎟️ *Roll Number:* ${roll.toString().padStart(4, '0')}\n` +
    `💰 *Amount:* ₹${amount/100} ${currency}\n` +
    `📱 *Contact:* ${contact}\n` +
    `📧 *Email:* ${email}\n` +
    `🏦 *Method:* ${method}\n\n` +
    `👤 *Name:* ${notes.name}\n` +
    `🎂 *DOB:* ${notes.dob}\n` +
    `📍 *Address:* ${notes.address}\n` +
    `👨‍👩‍👦 *Guardian:* ${notes.guardian_name}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `Thank you for registering for TEST-SERIES with Genesis Biology!\n` +
    `Join group: https://chat.whatsapp.com/Gr8LWnfJU9oAsQPRgy0HdO`;

  await sock.sendMessage(jid, { text });
  const preview = await getUrlInfo('https://chat.whatsapp.com/Gr8LWnfJU9oAsQPRgy0HdO');
  await sock.sendMessage(jid, { text: preview.preview, linkPreview: { ...preview } });
}

// process payment logic
async function handlePayment(evt) {
  try {
    const payment = evt.payload.payment.entity;
    const {
      id: paymentId,
      order_id: orderId,
      amount,
      currency,
      method,
      email,
      contact,
      notes = {}
    } = payment;

    if (!notes.name || !notes.whatsapp_number) return;
    if (await hasProcessed(paymentId)) return;

    const lastRoll = await getLastRollNumber();
    const nextRoll = lastRoll + 1;
    const rollStr = nextRoll.toString().padStart(4, '0');

    await appendToSheet({
      paymentId,
      name: notes.name,
      email,
      contact,
      dob: notes.dob,
      guardian_name: notes.guardian_name,
      address: notes.address,
      amount: amount / 100,
      method
    }, rollStr);

    await sendWhatsAppMessage({
      orderId,
      paymentId,
      amount,
      currency,
      method,
      email,
      contact,
      notes
    }, nextRoll);

  } catch (err) {
    console.error('❌ handlePayment error:', err);
  }
}

// initialize server
async function init() {
  try {
    await getSocket(); // ensure WhatsApp session

    const app = express();
    app.use(express.static(path.join(__dirname, 'public')));
    app.use('/webhook', express.json({
      verify: (req, res, buf) => { req.rawBody = buf; }
    }));
    app.use(express.json());

      // ─────────── Manual message send ───────────
      app.post('/api/manual-send', async (req, res) => {
        try {
          const {
            rollNumber,
            orderId = 'MANUAL_ORDER',
            paymentId = 'MANUAL_PAYMENT',
            amount = 50000,
            currency = 'INR',
            method = 'manual',
            email,
            contact,
            notes = {}
          } = req.body;
  
          if (!rollNumber || !contact || !notes.name || !notes.whatsapp_number) {
            return res.status(400).json({ error: 'Missing required fields' });
          }
  
          await sendWhatsAppMessage({
            orderId,
            paymentId,
            amount,
            currency,
            method,
            email,
            contact,
            notes
          }, rollNumber);
  
          res.status(200).json({ message: `✅ WhatsApp message sent to ${notes.whatsapp_number}` });
        } catch (err) {
          console.error('❌ Manual send error:', err);
          res.status(500).json({ error: err.message });
        }
      });

    // Razorpay webhook
    app.post('/webhook', (req, res) => {
      // verify signature
      const sig = req.headers['x-razorpay-signature'] || '';
      const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
        .update(req.rawBody).digest('hex');

      // immediate ACK
      res.status(200).send('OK');

      if (sig !== expected) {
        console.warn('❌ invalid signature');
        return;
      }
      if (req.body.event !== 'payment.captured') {
        return console.log('⏭️ ignored event', req.body.event);
      }

      // defer actual work
      process.nextTick(() => handlePayment(req.body));
    });

    app.listen(PORT, () => {
      console.log(`🚀 Server listening on http://localhost:${PORT}`);
    });

  } catch (err) {
    console.error('❌ init error:', err);
  }
}

init();
process.on('unhandledRejection', console.error);
