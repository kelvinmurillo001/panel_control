// 📁 server.js
const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const path = require('path');
const axios = require('axios'); // 🔁 NUEVO: para hacer peticiones HTTP

const app = express();
const port = 5501;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Servir favicon o assets

// 📡 Ruta que recibe el ID del dispositivo
app.post('/conectar', async (req, res) => {
  const { idDispositivo } = req.body;

  if (!idDispositivo) {
    return res.status(400).json({ ok: false, error: 'ID del dispositivo no proporcionado' });
  }

  try {
    // 🌐 Consulta al servidor remoto (Contabo)
    const respuesta = await axios.get(`https://tuservidorcontabo.com/dispositivos/${idDispositivo}`);
    
    const ip = respuesta.data?.ip;
    if (!ip) {
      return res.status(404).json({ ok: false, error: 'IP no encontrada para el dispositivo' });
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
  } catch (error) {
    console.error("❌ Error al consultar la IP:", error.message);
    return res.status(500).json({ ok: false, error: 'Error al obtener IP del servidor' });
  }
});

app.listen(port, () => {
  console.log(`🟢 Servidor Scrcpy listo en http://localhost:${port}`);
});
