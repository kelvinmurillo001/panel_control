// 📁 panel de control/server.js
"use strict";

/* =========================
   Dependencias
   ========================= */
const express   = require("express");
const cors      = require("cors");
const path      = require("path");
const { spawn } = require("child_process");
const http      = require("http");
const WebSocket = require("ws");
const url       = require("url");

/* =========================
   Configuración
   ========================= */
const app = express();

const PORT           = Number(process.env.PORT || 5501);
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "*"; // en prod, pon tu dominio ej: https://kmez.com
const STATIC_DIR     = path.join(__dirname, "public");
const TOKEN          = process.env.TOKEN || "CAMBIA_ESTE_TOKEN_SUPER_SEGURO_2025";

/* =========================
   Middlewares
   ========================= */
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

/* Fallback opcional: si piden "/" y existe scrcpy-panel.html en el proyecto raíz, servirlo */
app.get("/", (req, res, next) => {
  const panelAtRoot = path.join(__dirname, "scrcpy-panel.html");
  const panelInPub  = path.join(STATIC_DIR, "scrcpy-panel.html");
  if (require("fs").existsSync(panelInPub)) return res.sendFile(panelInPub);
  if (require("fs").existsSync(panelAtRoot)) return res.sendFile(panelAtRoot);
  return next();
});

/* =========================
   Utilidades
   ========================= */
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
const isValidIPv4 = (ip) => IPV4_RE.test(ip);
const isValidPort = (p) => Number.isInteger(Number(p)) && Number(p) >= 1 && Number(p) <= 65535;

/** Ejecuta un binario y acumula salida (para logs breves). */
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

/* =========================
   Auth simple para REST (Bearer)
   ========================= */
function requireAuth(req, res, next) {
  const h = String(req.headers["authorization"] || "");
  if (h === `Bearer ${TOKEN}`) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

/* =========================
   Healthcheck
   ========================= */
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, ts: Date.now(), version: "1.0.0" });
});

/* =========================
   Endpoints REST (ADB/Scrcpy) — opcionales
   ========================= */

/**
 * Wi-Fi/LAN: adb connect <ip:port> y lanza scrcpy -s <ip:port>
 * VPS headless: instala xvfb y crea wrapper /usr/local/bin/scrcpy con `xvfb-run -a`.
 */
app.post("/conectar-wifi", requireAuth, async (req, res) => {
  const ip   = String(req.body?.ip || "").trim();
  const port = Number(req.body?.port || 5555);

  if (!ip || !isValidIPv4(ip))  return res.status(400).json({ ok: false, error: "IP inválida" });
  if (!isValidPort(port))       return res.status(400).json({ ok: false, error: "Puerto inválido" });

  const target = `${ip}:${port}`;

  const adb = await run("adb", ["connect", target]);
  if (!adb.ok && !/already\s+connected/i.test(adb.stdout + adb.stderr)) {
    return res.status(500).json({ ok: false, step: "adb_connect", error: adb.stderr || adb.stdout || "Fallo adb connect" });
  }

  try {
    const sc = spawn("scrcpy", ["-s", target], { stdio: "ignore", detached: true });
    sc.unref();
  } catch (e) {
    return res.status(500).json({ ok: false, step: "scrcpy_spawn", error: String(e) });
  }

  return res.json({ ok: true, message: `Conectando a ${target} y lanzando scrcpy...` });
});

/** USB directo: scrcpy */
app.post("/conectar-usb", requireAuth, async (_req, res) => {
  try {
    const sc = spawn("scrcpy", [], { stdio: "ignore", detached: true });
    sc.unref();
    return res.json({ ok: true, message: "scrcpy (USB) iniciado" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

/** Backcompat: /conectar { ip } → equivalente a /conectar-wifi con puerto 5555 */
app.post("/conectar", requireAuth, async (req, res) => {
  const ip   = String(req.body?.ip || "").trim();
  const port = 5555;

  if (!ip || !isValidIPv4(ip)) return res.status(400).json({ ok: false, error: "IP inválida" });

  const target = `${ip}:${port}`;
  const adb = await run("adb", ["connect", target]);
  if (!adb.ok && !/already\s+connected/i.test(adb.stdout + adb.stderr)) {
    return res.status(500).json({ ok: false, step: "adb_connect", error: adb.stderr || adb.stdout || "Fallo adb connect" });
  }
  try {
    const sc = spawn("scrcpy", ["-s", target], { stdio: "ignore", detached: true });
    sc.unref();
  } catch (e) {
    return res.status(500).json({ ok: false, step: "scrcpy_spawn", error: String(e) });
  }
  return res.json({ ok: true, message: `Conectando a ${target} y lanzando scrcpy...` });
});

/* =========================
   WS /ws (roles: panel | app)
   ========================= */
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

// Estado de conexiones
const panels = new Set(); // múltiples paneles
let appWS    = null;      // única app (teléfono)

// Helpers
function sendOK(ws, type, payload = {}) {
  try { ws.send(JSON.stringify({ type, payload })); } catch {}
}
function deny(socket) {
  try { socket.destroy(); } catch {}
}
function broadcastToPanelsJSON(obj) {
  const s = JSON.stringify(obj);
  for (const p of panels) if (p.readyState === WebSocket.OPEN) p.send(s);
}
function broadcastToPanelsBinary(buf) {
  for (const p of panels) if (p.readyState === WebSocket.OPEN) p.send(buf);
}

// Conexión de Panel
function onPanelConnect(ws) {
  panels.add(ws);

  // heartbeat
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  // estado inicial de la app
  sendOK(ws, "app_status", { connected: !!appWS });

  ws.on("message", (raw) => {
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg) return;

    if (msg.type === "cmd") {
      const action = String(msg?.payload?.action || "").toLowerCase();

      // responder local SIEMPRE para status/ping
      if (action === "status") {
        return sendOK(ws, "status", { online: !!appWS, state: appWS ? "ready" : "idle" });
      }
      if (action === "ping") {
        return sendOK(ws, "pong", { ts: Date.now() });
      }

      // start/stop/otros → requieren app conectada
      if (!appWS || appWS.readyState !== WebSocket.OPEN) {
        return sendOK(ws, "error", { code: "app_not_connected" });
      }
      try { appWS.send(JSON.stringify(msg)); } catch {}
      return;
    }

    // Compat: {type:"ping"} sin payload
    if (msg.type === "ping") {
      return sendOK(ws, "pong", { ts: Date.now() });
    }
  });

  ws.on("close", () => panels.delete(ws));
}

// Conexión de App (teléfono)
function onAppConnect(ws) {
  // Si ya había una app, se reemplaza
  if (appWS && appWS !== ws && appWS.readyState === WebSocket.OPEN) {
    try { appWS.close(1012, "replaced"); } catch {}
  }
  appWS = ws;

  // heartbeat
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  // Avisar a todos los paneles que la app se conectó
  broadcastToPanelsJSON({ type: "app_status", payload: { connected: true } });

  // Reenviar binario como binario y JSON como JSON
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      return broadcastToPanelsBinary(data);
    }
    const text = data.toString();
    try {
      const msg = JSON.parse(text);
      broadcastToPanelsJSON(msg);
    } catch {
      // ignora texto no-JSON
    }
  });

  ws.on("close", () => {
    appWS = null;
    broadcastToPanelsJSON({ type: "app_status", payload: { connected: false } });
  });
}

// Router por rol
wss.on("connection", (ws) => {
  if (ws._role === "app") return onAppConnect(ws);
  return onPanelConnect(ws);
});

// Upgrade HTTP → WS (validación de token y rol aquí)
server.on("upgrade", (request, socket, head) => {
  const { pathname, query } = url.parse(request.url, true);
  if (pathname !== "/ws") return deny(socket);

  // Verificación de ORIGIN para navegadores (OkHttp NO envía Origin)
  const origin = String(request.headers.origin || "");
  if (ALLOWED_ORIGIN !== "*" && origin && !origin.startsWith(ALLOWED_ORIGIN)) {
    return deny(socket);
  }

  // 1) Parsear subprotocolos: "app, <TOKEN_OPCIONAL>"
  const sec = String(request.headers["sec-websocket-protocol"] || "");
  const protos = sec.split(",").map(s => s.trim()).filter(Boolean);
  const roleFromProto  = (protos[0] || "panel").toLowerCase();
  const tokenFromProto = protos[1] || "";

  // 2) Fallback: token por query (?token=...)
  const tokenFromQuery = (query?.token || "").toString();

  // 3) Aceptar si CUALQUIERA coincide
  const okToken = (tokenFromProto && tokenFromProto === TOKEN) ||
                  (tokenFromQuery && tokenFromQuery === TOKEN);
  if (!okToken) return deny(socket);

  const role = roleFromProto === "app" ? "app" : "panel";

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws._role = role;
    wss.emit("connection", ws, request);
  });
});

// Heartbeat WS
const hb = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30_000);

wss.on("close", () => clearInterval(hb));

/* =========================
   Arranque
   ========================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🟢 API + WS en http://localhost:${PORT}`);
  console.log(`   REST: POST /conectar-usb | POST /conectar-wifi | GET /healthz  (Authorization: Bearer <TOKEN>)`);
  console.log(`   WS  : GET /ws?role=panel|app  (token via Sec-WebSocket-Protocol, fallback ?token=****)`);
});
