// test-ws.js
const WebSocket = require("ws");

const url = "ws://localhost:5501/ws";
const protocols = ["panel", "KMEZ123456789TOKEN"]; // role + token

const ws = new WebSocket(url, protocols);

ws.on("open", () => {
  console.log("✅ Conectado al servidor WS con token correcto");
  ws.send(JSON.stringify({ type: "cmd", payload: { action: "ping" } }));
});

ws.on("message", (msg) => {
  console.log("📩 Mensaje:", msg.toString());
});

ws.on("close", (code, reason) => {
  console.log("❌ Conexión cerrada", code, reason.toString());
});

ws.on("error", (err) => {
  console.error("⚠️ Error WS:", err.message);
});
