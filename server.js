// 📁 server.js
const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const path = require('path');

const app = express();
const port = 5501;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // para favicon y assets

// 📡 Ruta que recibe la IP directamente
app.post('/conectar', async (req, res) => {
  const { ip } = req.body;

  if (!ip) {
    return res.status(400).json({ ok: false, error: 'IP no proporcionada' });
  }

  const comando = `scrcpy --tcpip=${ip}`;
  console.log(`🔧 Ejecutando: ${comando}`);

  exec(comando, (err, stdout, stderr) => {
    if (err) {
      console.error("❌ Error ejecutando:", stderr);
      return res.status(500).json({ ok: false, error: stderr });
    }
    return res.json({ ok: true, output: stdout });
  });
});

app.listen(port, () => {
  console.log(`🟢 Servidor Scrcpy listo en http://localhost:${port}`);
});
