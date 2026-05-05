const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

// Load .env file manually if it exists (for local dev)
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const idx = trimmed.indexOf("=");
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET      = process.env.WEBHOOK_SECRET;
const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const DASHBOARD_PASSWORD  = process.env.DASHBOARD_PASSWORD || "2026";
const DB_FILE             = path.join(__dirname, "data.json");

console.log("✅ Config loaded:", {
  key: RAZORPAY_KEY_ID ? RAZORPAY_KEY_ID.slice(0, 12) + "..." : "MISSING",
  telegram: TELEGRAM_BOT_TOKEN ? "SET" : "MISSING",
  chat: TELEGRAM_CHAT_ID || "MISSING",
});

// ─── SIMPLE JSON DB ──────────────────────────────────────────────────────────
function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ events: [] }, null, 2));
  }
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return { events: [] }; }
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}
function saveEvent(event) {
  const db = readDB();
  const entry = { id: Date.now() + Math.random().toString(36).slice(2), ...event, timestamp: new Date().toISOString() };
  db.events.unshift(entry);
  if (db.events.length > 5000) db.events = db.events.slice(0, 5000);
  writeDB(db);
  return entry;
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram not configured, skipping");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" }),
    });
    const data = await res.json();
    if (!data.ok) console.error("Telegram error:", data.description);
  } catch (e) { console.error("Telegram fetch error:", e.message); }
}

function istTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true
  });
}

function buildMessage(type, data) {
  const time = istTime();
  const line = "─".repeat(28);
  const couponStr = data.coupon ? `\n🏷 <b>Coupon:</b> ${data.coupon}` : "";
  const base = `👤 <b>Name:</b> ${data.name || "—"}\n📱 <b>Phone:</b> ${data.phone || "—"}\n📧 <b>Email:</b> ${data.email || "—"}`;

  const templates = {
    lead:      `🎯 <b>NEW LEAD CAPTURED</b>\n${line}\n${base}\n💰 <b>Amount:</b> ₹${data.amount || "999"}${couponStr}\n⏰ <b>Time:</b> ${time}\n${line}`,
    initiated: `💳 <b>PAYMENT INITIATED</b>\n${line}\n${base}\n💰 <b>Amount:</b> ₹${data.amount}${couponStr}\n🆔 <b>Order:</b> ${data.orderId || "—"}\n⏰ <b>Time:</b> ${time}\n${line}`,
    success:   `✅ <b>PAYMENT SUCCESS 🎉</b>\n${line}\n${base}\n💰 <b>Paid:</b> ₹${data.amount}${couponStr}\n🆔 <b>Payment ID:</b> ${data.paymentId || "—"}\n⏰ <b>Time:</b> ${time}\n${line}`,
    failed:    `❌ <b>PAYMENT FAILED</b>\n${line}\n${base}\n💰 <b>Amount:</b> ₹${data.amount || "—"}\n⚠️ <b>Reason:</b> ${data.reason || "Unknown"}\n⏰ <b>Time:</b> ${time}\n${line}`,
    abandoned: `🚪 <b>PAYMENT ABANDONED</b>\n${line}\n${base}\n💰 <b>Amount:</b> ₹${data.amount || "—"}${couponStr}\n💡 Closed Razorpay without paying\n⏰ <b>Time:</b> ${time}\n${line}`,
  };
  return templates[type] || `📌 <b>EVENT: ${type}</b>\n${JSON.stringify(data)}`;
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use("/webhook/razorpay", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Health check
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ─── TRACK ENDPOINT ───────────────────────────────────────────────────────────
app.post("/track", async (req, res) => {
  const { type, name, phone, email, amount, coupon, orderId, paymentId, reason } = req.body;
  if (!type) return res.status(400).json({ error: "type required" });

  const event = saveEvent({ type, name, phone, email, amount, coupon, orderId, paymentId, reason });
  const msg = buildMessage(type, { name, phone, email, amount, coupon, orderId, paymentId, reason });
  await sendTelegram(msg);

  console.log(`📊 [${type.toUpperCase()}] ${name || "?"} | ${phone || "?"} | ₹${amount || "?"}`);
  res.json({ ok: true, id: event.id });
});

// ─── RAZORPAY WEBHOOK ─────────────────────────────────────────────────────────
app.post("/webhook/razorpay", async (req, res) => {
  const sig = req.headers["x-razorpay-signature"];
  const body = req.body;

  if (WEBHOOK_SECRET) {
    const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET);
    hmac.update(body);
    const digest = hmac.digest("hex");
    if (sig !== digest) {
      console.log("Webhook signature mismatch");
      return res.status(400).json({ error: "Invalid signature" });
    }
  }

  let payload;
  try { payload = JSON.parse(body.toString()); }
  catch { return res.status(400).json({ error: "Invalid JSON" }); }

  const event = payload.event;
  const payment = payload.payload?.payment?.entity;
  if (!payment) return res.json({ ok: true });

  const notes = payment.notes || {};
  const data = {
    name: notes.name || "—",
    phone: notes.phone || payment.contact || "—",
    email: notes.email || payment.email || "—",
    amount: (payment.amount / 100).toFixed(0),
    coupon: notes.coupon || null,
    paymentId: payment.id,
    orderId: payment.order_id,
    reason: payment.error_description || null,
  };

  if (event === "payment.captured") {
    saveEvent({ type: "success", ...data, source: "webhook" });
    await sendTelegram(buildMessage("success", data));
  } else if (event === "payment.failed") {
    saveEvent({ type: "failed", ...data, source: "webhook" });
    await sendTelegram(buildMessage("failed", data));
  }

  res.json({ ok: true });
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post("/api/login", (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) {
    const token = Buffer.from(DASHBOARD_PASSWORD + ":astrafxpro2026").toString("base64");
    res.json({ ok: true, token });
  } else {
    res.status(401).json({ error: "Wrong password" });
  }
});

function auth(req, res, next) {
  const token = req.headers["x-auth-token"];
  const expected = Buffer.from(DASHBOARD_PASSWORD + ":astrafxpro2026").toString("base64");
  if (token !== expected) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ─── STATS API ────────────────────────────────────────────────────────────────
app.get("/api/stats", auth, (req, res) => {
  const db = readDB();
  const events = db.events;

  const counts = { lead: 0, initiated: 0, success: 0, failed: 0, abandoned: 0 };
  events.forEach(e => { if (counts[e.type] !== undefined) counts[e.type]++; });
  const revenue = events.filter(e => e.type === "success").reduce((s, e) => s + parseFloat(e.amount || 0), 0);

  // Build user list - one row per person, highest status wins
  const priority = { lead: 1, initiated: 2, abandoned: 3, failed: 4, success: 5 };
  const userMap = {};
  events.forEach(e => {
    const key = (e.phone || e.email || e.id).replace(/\s/g, "");
    if (!userMap[key]) {
      userMap[key] = { name: e.name, phone: e.phone, email: e.email, coupon: e.coupon, amount: e.amount, status: e.type, lastSeen: e.timestamp };
    } else {
      if ((priority[e.type] || 0) > (priority[userMap[key].status] || 0)) {
        userMap[key].status = e.type;
        userMap[key].amount = e.amount || userMap[key].amount;
        userMap[key].coupon = e.coupon || userMap[key].coupon;
        userMap[key].name = e.name || userMap[key].name;
      }
      if (e.timestamp > userMap[key].lastSeen) userMap[key].lastSeen = e.timestamp;
    }
  });

  const users = Object.values(userMap).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

  res.json({
    summary: { ...counts, revenue: revenue.toFixed(0) },
    users,
    recentEvents: events.slice(0, 50),
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 AstraFXPro Tracker running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard.html`);
});
