// 📁 server.js (seguro, USB y Wi-Fi LAN; listo para panel → Contabo/Local)
"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");
const { spawn } = require("child_process");

// 👇 NUEVO: HTTP + WS
const http = require("http");
const WebSocket = require("ws");
const url = require("url");

const app = express();

// ⚙️ Config
const PORT = Number(process.env.PORT || 5501);
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "*"; // ajusta a tu dominio/panel si lo deseas
const STATIC_DIR = path.join(__dirname, "public");
// 👇 NUEVO: TOKEN para WS
const TOKEN = process.env.TOKEN || "CAMBIA_ESTE_TOKEN_SUPER_SEGURO_2025";

// 🔐 CORS (restringe si ya tienes dominio del panel)
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(express.static(STATIC_DIR));

// 🧪 Healthcheck
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, ts: Date.now(), version: "1.0.0" });
});

// 🛡️ Validaciones
const IPV4_RE =
  /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;

function isValidIPv4(ip) {
  return IPV4_RE.test(ip);
}
function isValidPort(p) {
  const n = Number(p);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

// 🧵 Util spawn con logs acotados (sin inyección)
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "pipe", ...opts });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => resolve({ ok: false, code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) =>
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() })
    );
  });
}

// 📶 Wi-Fi (LAN): adb connect ip:port → scrcpy -s ip:port
app.post("/conectar-wifi", async (req, res) => {
  const ip = String(req.body?.ip || "").trim();
  const port = Number(req.body?.port || 5555);

  if (!ip || !isValidIPv4(ip)) {
    return res.status(400).json({ ok: false, error: "IP inválida" });
  }
  if (!isValidPort(port)) {
    return res.status(400).json({ ok: false, error: "Puerto inválido" });
  }

  const target = `${ip}:${port}`;

  // 1) adb connect
  const adb = await run("adb", ["connect", target]);
  if (!adb.ok && !/already\s+connected/i.test(adb.stdout + adb.stderr)) {
    return res
      .status(500)
      .json({ ok: false, step: "adb_connect", error: adb.stderr || adb.stdout || "Fallo adb connect" });
  }

  // 2) scrcpy -s ip:port (no esperamos a que cierre; indicamos inicio)
  const sc = spawn("scrcpy", ["-s", target], { stdio: "ignore", detached: true });
  sc.unref();

  return res.json({ ok: true, message: `Conectando a ${target} y lanzando scrcpy...` });
});

// 🔌 USB directo: scrcpy
app.post("/conectar-usb", async (_req, res) => {
  const sc = spawn("scrcpy", [], { stdio: "ignore", detached: true });
  sc.unref();
  return res.json({ ok: true, message: "scrcpy (USB) iniciado" });
});

// 🔄 Backcompat: /conectar { ip } → usar /conectar-wifi con puerto por defecto
app.post("/conectar", async (req, res) => {
  const ip = String(req.body?.ip || "").trim();
  if (!ip || !isValidIPv4(ip)) {
    return res.status(400).json({ ok: false, error: "IP inválida" });
  }
  req.body.port = req.body?.port || 5555;
  return app._router.handle(req, res, () => {}, "post", "/conectar-wifi");
});

// 🧯 Manejo de errores no atrapados
app.use((err, _req, res, _next) => {
  const msg = (err && (err.message || String(err))) || "Error interno";
  res.status(500).json({ ok: false, error: msg });
});

/* =========================
   🔌 WebSocket /ws (SECURE)
   ========================= */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// helpers
function sendOK(ws, type, payload = {}) {
  try { ws.send(JSON.stringify({ type, payload })); } catch {}
}
function deny(socket, reason = "unauthorized") {
  try { socket.destroy(); } catch {}
}

// mensajes del panel → respuestas básicas
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  // estado inicial
  sendOK(ws, "app_status", { connected: false });

  ws.on("message", (raw) => {
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || msg.type !== "cmd") return;

    const action = msg.payload?.action;
    if (action === "ping")   return sendOK(ws, "pong",   { ts: Date.now() });
    if (action === "status") return sendOK(ws, "status", { online: true, state: "idle" });
    if (action === "start")  return sendOK(ws, "status", { online: true, state: "starting" });
    if (action === "stop")   return sendOK(ws, "status", { online: false, state: "stopped" });
  });
});

// upgrade HTTP → WS sólo para /ws y con token válido
server.on("upgrade", (request, socket, head) => {
  const { pathname, query } = url.parse(request.url, true);
  if (pathname !== "/ws") return deny(socket);

  const token = (query?.token || "").toString();
  if (!token || token !== TOKEN) return deny(socket);

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

// heartbeat
const hb = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(hb));

// ⏯️ ARRANQUE (reemplaza app.listen por server.listen)
server.listen(PORT, () => {
  console.log(`🟢 API + WS en http://localhost:${PORT}`);
  console.log(`   REST: POST /conectar-usb | POST /conectar-wifi | GET /healthz`);
  console.log(`   WS  : GET  /ws?role=panel&token=******`);
});
