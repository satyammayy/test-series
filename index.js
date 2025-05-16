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

if (!SHEET_ID) throw new Error('Missing SHEET_ID');

// Express setup
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/webhook', express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Google Sheets auth
const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

async function getLastRollNumber() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!B2:B`
  });

  const rows = res.data.values || [];
  const last = rows.map(r => parseInt(r[0])).filter(n => !isNaN(n)).pop();
  return Number(last || 0);
}

async function appendToSheet(data, rollStr) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const row = [
    new Date().toLocaleString('en-IN'),
    rollStr,
    data.payment_id,
    data.name,
    data.email,
    data.phone,
    data.dob,
    data.guardian_name,
    data.address,
    data.amount,
    data.method
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:K`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
}

// WhatsApp
let sockPromise;
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) sockPromise = startSock();
    }
    if (connection === 'open') console.log('✅ WhatsApp ready');
  });

  await new Promise((res) => sock.ev.on('connection.update', u => u.connection === 'open' && res()));
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
  const {
    orderId, paymentId, amount, currency, method,
    email, contact, notes = {}
  } = paymentData;

  const jid = `${cleanIndianMobile(notes.whatsapp_number || contact)}@s.whatsapp.net`;

  const message = `💳 *GENESIS BIOLOGY PAYMENT RECEIPT*
━━━━━━━━━━━━━━━━━━━━━
✅ *Payment Verified*

📄 *Order ID:* ${orderId}
💳 *Payment ID:* ${paymentId}
🎟️ *Roll Number:* ${roll.toString().padStart(4, '0')}
💰 *Amount:* ₹${amount / 100} ${currency}
📱 *Contact:* ${contact}
📧 *Email:* ${email}
🏦 *Method:* ${method}

👤 *Name:* ${notes.name}
🎂 *DOB:* ${notes.dob}
📍 *Address:* ${notes.address}
👨‍👩‍👦 *Guardian Name:* ${notes.guardian_name}

━━━━━━━━━━━━━━━━━━━━━
Thank you for registering for TEST-SERIES with Genesis Biology!
📢 Please join the group:

https://chat.whatsapp.com/Gr8LWnfJU9oAsQPRgy0HdO

For support contact:
1. +917005589986 (Sir Loya)
2. +916009989088 (Radip K)
3. +919863461949 (Satyam M)
4. +918415809253 (Ka Seitabanta)`;

  await sock.sendMessage(jid, { text: message });

  const groupInfo = await getUrlInfo('https://chat.whatsapp.com/Gr8LWnfJU9oAsQPRgy0HdO');
  await sock.sendMessage(jid, {
    text: 'https://chat.whatsapp.com/Gr8LWnfJU9oAsQPRgy0HdO',
    linkPreview: {
      ...groupInfo,
      title: 'Genesis Biology – Test-Series Group',
      description: 'Announcements, rules, and more'
    }
  });
}

// Webhook Handler
app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');

  if (signature !== expectedSignature) {
    console.log("❌ Signature mismatch");
    return res.status(400).send("Invalid signature");
  }

  const payment = req.body?.payload?.payment?.entity;
  if (!payment) return res.status(400).send("Invalid payload");

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

  // Reject invalid / test payment
  if (!notes.name || !notes.whatsapp_number || amount < 50000) {
    console.warn("❌ Skipped invalid or test payment:", paymentId);
    return res.status(200).send("Ignored test/incomplete payment");
  }

  try {
    // Get and increment roll safely
    const lastRoll = await getLastRollNumber();
    const nextRoll = lastRoll + 1;
    const rollStr = nextRoll.toString().padStart(4, '0');

    // Append to sheet with final roll
    await appendToSheet({
      roll: rollStr,
      payment_id: paymentId,
      name: notes.name,
      email,
      phone: contact,
      dob: notes.dob,
      guardian_name: notes.guardian_name,
      address: notes.address,
      amount: amount / 100,
      method
    }, rollStr);

    console.log("✅ Appended to Google Sheet with roll:", rollStr);

    // Send WhatsApp confirmation
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

    console.log("📤 WhatsApp message sent");
    res.status(200).send("Webhook received");
  } catch (err) {
    console.error("❌ Error processing payment:", err.message);
    res.status(500).send("Error processing");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
