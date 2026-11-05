const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const QRCode = require("qrcode");
const { Low } = require("lowdb");
const { JSONFile } = require("lowdb/node");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const db = new Low(new JSONFile("db.json"), {
  config: {
    target: "",
    jadwal: ["23:00", "03:00"],
    teks: "LAPORAN MALAM - PATROLI RUTIN\nTanggal: {tanggal} Jam: {jam}\nSituasi aman kondusif.",
    ulang: 3,
    delay: 2,
    images: []
  }
});

let sock;
let qrString = null;
let isConnected = false;
let cronJobs = [];

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

async function startWA() {
  await db.read();
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  sock = makeWASocket({ auth: state, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrString = await QRCode.toDataURL(qr);
    if (connection === 'open') {
      isConnected = true; qrString = null;
      console.log("WA Connected");
      setupCron();
    }
    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startWA();
    }
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function kirimLaporan() {
  await db.read();
  const cfg = db.data.config;
  if (!sock || !cfg.target) return;
  const now = new Date();
  const teksFinal = cfg.teks.replaceAll("{tanggal}", now.toLocaleDateString('id-ID')).replaceAll("{jam}", now.toLocaleTimeString('id-ID'));
  const jid = cfg.target.replace(/[^0-9]/g, '') + "@s.whatsapp.net";
  for (let i = 1; i <= cfg.ulang; i++) {
    await sock.sendMessage(jid, { text: `${teksFinal}\n\n[Sesi ${i}/${cfg.ulang}]` });
    await delay(cfg.delay * 1000);
    for (let img of cfg.images) {
      if (fs.existsSync(img)) {
        await sock.sendMessage(jid, { image: fs.readFileSync(img), caption: `Bukti ${path.basename(img)} Sesi ${i}` });
        await delay(cfg.delay * 1000);
      }
    }
  }
}

function setupCron() {
  cronJobs.forEach(j => j.stop());
  cronJobs = [];
  db.data.config.jadwal.forEach(waktu => {
    const [jam, menit] = waktu.split(":");
    const job = cron.schedule(`${menit} ${jam} * * *`, kirimLaporan);
    cronJobs.push(job);
  });
}

app.get('/api/status', async (req, res) => {
  await db.read();
  res.json({ connected: isConnected, qr: qrString, config: db.data.config });
});

app.post('/api/config', async (req, res) => {
  await db.read();
  db.data.config = { ...db.data.config, ...req.body };
  await db.write();
  setupCron();
  res.json({ ok: true });
});

app.post('/api/upload', upload.array('images', 10), async (req, res) => {
  await db.read();
  const files = req.files.map(f => f.path);
  db.data.config.images.push(...files);
  await db.write();
  res.json({ files });
});

app.post('/api/clear-images', async (req, res) => {
  await db.read();
  db.data.config.images = [];
  await db.write();
  res.json({ ok: true });
});

app.post('/api/test', async (req, res) => {
  kirimLaporan();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Jalan di port " + PORT);
  startWA();
});
