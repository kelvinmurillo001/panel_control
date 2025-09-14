"use strict";

require("dotenv").config(); // 🔑 Cargar variables de entorno desde .env

const express   = require("express");
const cors      = require("cors");
const path      = require("path");
const { spawn } = require("child_process");
const http      = require("http");
const WebSocket = require("ws");
const url       = require("url");
const fs        = require("fs");

const app = express();

/* ====== CONFIG ====== */
const PORT           = Number(process.env.PORT || 5501);
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "*";
const STATIC_DIR     = path.join(__dirname, "public");
const TOKEN          = process.env.TOKEN || "CAMBIA_ESTE_TOKEN_SUPER_SEGURO_2025";

// ⚠️ Evita loguear tokens reales en producción
console.log(
  "🔑 TOKEN cargado:",
  TOKEN === "CAMBIA_ESTE_TOKEN_SUPER_SEGURO_2025" ? "(default, revisa tu .env)" : "(token personalizado)"
);

/* ====== Middleware ====== */
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGIN === "*" || origin.startsWith(ALLOWED_ORIGIN)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());
app.use(express.static(STATIC_DIR));

/* ====== Panel ====== */
const panelAtRoot = path.join(__dirname, "scrcpy-panel.html");
const panelInPub  = path.join(STATIC_DIR, "scrcpy-panel.html");

app.get("/", (req, res, next) => {
  if (fs.existsSync(panelInPub)) return res.sendFile(panelInPub);
  if (fs.existsSync(panelAtRoot)) return res.sendFile(panelAtRoot);
  return next();
});

app.get("/scrcpy-panel.html", (req, res, next) => {
  if (fs.existsSync(panelInPub)) return res.sendFile(panelInPub);
  if (fs.existsSync(panelAtRoot)) return res.sendFile(panelAtRoot);
  return res.status(404).send("scrcpy-panel.html no encontrado");
});

/* ====== Utils ====== */
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
const isValidIPv4 = (ip) => IPV4_RE.test(ip);
const isValidPort = (p) => Number.isInteger(Number(p)) && Number(p) >= 1 && Number(p) <= 65535;

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "pipe", ...opts });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ ok: false, code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function requireAuth(req, res, next) {
  const h = String(req.headers["authorization"] || "");
  if (h === `Bearer ${TOKEN}`) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

/* ====== Health ====== */
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, ts: Date.now(), version: "1.0.0" });
});

/* ====== Endpoints ====== */
app.post("/conectar-wifi", requireAuth, async (req, res) => {
  const ip   = String(req.body?.ip || "").trim();
  const port = Number(req.body?.port || 5555);
  if (!ip || !isValidIPv4(ip))  return res.status(400).json({ ok: false, error: "IP inválida" });
  if (!isValidPort(port))       return res.status(400).json({ ok: false, error: "Puerto inválido" });

  const target = `${ip}:${port}`;
  const adb = await run("adb", ["connect", target]);
  if (!adb.ok && !/already\s+connected/i.test(adb.stdout + adb.stderr)) {
    console.error("[ADB ERROR]", adb.stderr || adb.stdout);
    return res.status(500).json({ ok: false, step: "adb_connect", error: adb.stderr || adb.stdout || "Fallo adb connect" });
  }
  try {
    const sc = spawn("scrcpy", ["-s", target], { stdio: "ignore", detached: true });
    sc.unref();
  } catch (e) {
    console.error("[SCRCPY ERROR]", e);
    return res.status(500).json({ ok: false, step: "scrcpy_spawn", error: String(e) });
  }
  return res.json({ ok: true, message: `Conectando a ${target} y lanzando scrcpy...` });
});

app.post("/conectar-usb", requireAuth, async (_req, res) => {
  try {
    const sc = spawn("scrcpy", [], { stdio: "ignore", detached: true });
    sc.unref();
    return res.json({ ok: true, message: "scrcpy (USB) iniciado" });
  } catch (e) {
    console.error("[SCRCPY ERROR]", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ====== WS /ws ====== */
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

const panels = new Set();
let appWS    = null;

function sendOK(ws, type, payload = {}) { try { ws.send(JSON.stringify({ type, payload })); } catch {} }
function deny(socket) { try { socket.destroy(); } catch {} }
function broadcastToPanelsJSON(obj) {
  const s = JSON.stringify(obj);
  for (const p of panels) if (p.readyState === WebSocket.OPEN) p.send(s);
}
function broadcastToPanelsBinary(buf) {
  for (const p of panels) if (p.readyState === WebSocket.OPEN) p.send(buf);
}

function onPanelConnect(ws) {
  panels.add(ws);
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  sendOK(ws, "app_status", { connected: !!appWS });

  ws.on("message", (raw) => {
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg) return;

    if (msg.type === "cmd") {
      const action = String(msg?.payload?.action || "").toLowerCase();
      if (action === "status") return sendOK(ws, "status", { online: !!appWS, state: appWS ? "ready" : "idle" });
      if (action === "ping")   return sendOK(ws, "pong", { ts: Date.now() });
      if (!appWS || appWS.readyState !== WebSocket.OPEN) return sendOK(ws, "error", { code: "app_not_connected" });
      try { appWS.send(JSON.stringify(msg)); } catch {}
      return;
    }

    if (msg.type === "ping") return sendOK(ws, "pong", { ts: Date.now() });
  });

  ws.on("close", () => panels.delete(ws));
}

function onAppConnect(ws) {
  if (appWS && appWS !== ws && appWS.readyState === WebSocket.OPEN) {
    try { appWS.close(1012, "replaced"); } catch {}
  }
  appWS = ws;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  broadcastToPanelsJSON({ type: "app_status", payload: { connected: true } });

  ws.on("message", (data, isBinary) => {
    if (isBinary) return broadcastToPanelsBinary(data);
    const text = data.toString();
    try {
      const msg = JSON.parse(text);
      broadcastToPanelsJSON(msg);
    } catch {
      console.error("[WS JSON ERROR]", text);
    }
  });

  ws.on("close", () => {
    appWS = null;
    broadcastToPanelsJSON({ type: "app_status", payload: { connected: false } });
  });
}

wss.on("connection", (ws) => {
  if (ws._role === "app") return onAppConnect(ws);
  return onPanelConnect(ws);
});

/* ====== 🔧 UPGRADE con soporte para 3 modos: query, 2 subprotocolos, 1 combinado ====== */
server.on("upgrade", (request, socket, head) => {
  const parsed = url.parse(request.url, true);
  if (parsed.pathname !== "/ws") return deny(socket);

  // CORS de origen (si se desea forzar dominio)
  const origin = String(request.headers.origin || "");
  if (ALLOWED_ORIGIN !== "*" && origin && !origin.startsWith(ALLOWED_ORIGIN)) return deny(socket);

  // 1) Intentar obtener role/token desde query
  let role  = String(parsed.query.role || "").toLowerCase();
  let token = String(parsed.query.token || "");

  // 2) Intentar desde subprotocolos
  const sec = String(request.headers["sec-websocket-protocol"] || "");
  const protos = sec.split(",").map(s => s.trim()).filter(Boolean);

  // Caso 1 subprotocolo combinado: "panel:TOKEN" (ideal para wscat)
  if (!token && protos.length === 1 && protos[0].includes(":")) {
    const [pRole, pToken] = protos[0].split(":");
    role  = role  || String(pRole || "").toLowerCase();
    token = token || String(pToken || "");
  }
  // Caso 2 subprotocolos: ["panel","TOKEN"]
  else if (!token && protos.length >= 2) {
    role  = role  || String(protos[0] || "").toLowerCase();
    token = token || String(protos[1] || "");
  }
  // Caso 1 subprotocolo simple: ["panel"]
  else if (!role && protos.length === 1) {
    role = String(protos[0] || "").toLowerCase();
  }

  // Validaciones
  if (!role || !token) return deny(socket);
  if (token !== TOKEN)  return deny(socket);
  if (role !== "app" && role !== "panel") role = "panel";

  // Upgrade OK
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws._role = role;
    wss.emit("connection", ws, request);
  });
});

/* ====== Heartbeat ====== */
const hb = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);
wss.on("close", () => clearInterval(hb));

/* ====== Arranque ====== */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🟢 API + WS escuchando en 0.0.0.0:${PORT}`);
  console.log(`🌍 Acceso público:  http://144.126.129.233:${PORT}`);
  console.log(`🌐 Panel web:      http://144.126.129.233/scrcpy-panel.html`);
});

/* ====== Manejo global de fallos ====== */
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err);
});
process.on("unhandledRejection", (reason, p) => {
  console.error("[FATAL] unhandledRejection at:", p, "reason:", reason);
});
