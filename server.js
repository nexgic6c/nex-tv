const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Libera arquivos estáticos da pasta public
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Defina aqui a URL do vídeo/música padrão do modo Standby
const STANDBY_URL = "https://pub-a384c7ff61e54479b2bc601c3930cded.r2.dev/wallpaper/standby_video.mp4"; 

// Estado Mestre Central com Fila e Suporte a Standby
let masterState = {
  video: null,          
  ativo: false,         
  playing: false,       
  reproduzindo: false,  
  currentTime: 0,       
  updatedAt: Date.now(),
  volume: 100,
  mudo: false,
  seek: 0,
  ultimoComando: null,
  comandoId: 0,
  fila: [],
  atual: 0,
  modoStandby: false
};

function getCurrentPosition() {
  if (!masterState.playing || !masterState.video) {
    return masterState.currentTime;
  }
  const elapsedSeconds = (Date.now() - masterState.updatedAt) / 1000;
  return masterState.currentTime + elapsedSeconds;
}

// Disparador otimizado via WebSocket
function broadcastState(acaoExtra = null) {
  const currentPos = getCurrentPosition();

  if (masterState.playing && masterState.video) {
    masterState.currentTime = currentPos;
    masterState.updatedAt = Date.now();
  }

  const payload = JSON.stringify({
    tipo: acaoExtra ? "comando" : "sync-transmission",
    slink: acaoExtra,
    ...masterState,
    currentTime: masterState.currentTime,
    reproduzindo: masterState.playing,
    updatedAt: masterState.updatedAt
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Verifica e gerencia o modo Standby automaticamente
function verificarStandby() {
  const temItensNaFila = Array.isArray(masterState.fila) && masterState.fila.length > 0;
  const dentroDoIndice = temItensNaFila && masterState.atual < masterState.fila.length;

  if (!temItensNaFila || !dentroDoIndice) {
    // Entra em modo Standby se não houver mídias válidas para tocar
    masterState.modoStandby = true;
    masterState.video = STANDBY_URL;
    masterState.ativo = true;
    masterState.playing = true;
    masterState.reproduzindo = true;
    masterState.currentTime = 0;
  } else {
    // Sai do modo Standby e assume o item atual da fila
    masterState.modoStandby = false;
    const itemAtual = masterState.fila[masterState.atual];
    masterState.video = itemAtual.url || itemAtual;
    masterState.ativo = true;
    masterState.playing = true;
    masterState.reproduzindo = true;
  }
}

// Rota HTTP Polling usada pela Smart TV
app.get('/status', (req, res) => {
  const currentPos = getCurrentPosition();
  res.json({
    ...masterState,
    ativo: !!masterState.video,
    playing: masterState.playing,
    reproduzindo: masterState.playing,
    currentTime: currentPos,
    position: currentPos
  });
});

// Envio de nova mídia (Adiciona na fila em sigilo SEM reiniciar o vídeo atual)
app.post('/enviar', (req, res) => {
  const url = req.body.url;
  const titulo = req.body.titulo || `Mídia ${masterState.fila.length + 1}`;

  if (url) {
    const itemMidia = { id: Date.now().toString(), url: url, titulo: titulo };
    masterState.fila.push(itemMidia);

    // Se estava em Standby ou sem nenhum vídeo ativo, assume e começa a tocar imediatamente
    if (masterState.modoStandby || !masterState.video || !masterState.ativo) {
      masterState.atual = masterState.fila.length - 1;
      verificarStandby();
      masterState.updatedAt = Date.now();
      masterState.ultimoComando = "enviar";
      masterState.comandoId = masterState.updatedAt;
      broadcastState("play");
    } else {
      // Se JÁ ESTÁ TOCANDO algo, apenas atualiza a fila de forma silenciosa na TV
      masterState.updatedAt = Date.now();
      masterState.ultimoComando = "fila_adicionada";
      masterState.comandoId = masterState.updatedAt;
      broadcastState(); 
    }
  }
  res.json({ success: true, state: masterState });
});

// Recepção de comandos do Controle Remoto (App Android) - Ultra Rápido
app.post('/controle', (req, res) => {
  const slink = req.body.slink || req.body.comando;
  const targetTime = req.body.time !== undefined ? req.body.time : req.body.seek;

  if (slink || targetTime !== undefined) {
    if (masterState.video) {
      masterState.currentTime = getCurrentPosition();
      masterState.updatedAt = Date.now();
    }

    switch (slink) {
      case 'play':
        if (!masterState.video && masterState.fila.length > 0) {
          verificarStandby();
        }
        if (!masterState.video) break;
        masterState.playing = true;
        masterState.reproduzindo = true;
        break;

      case 'resume':
      case 'toggle-play':
        if (!masterState.video) break;
        masterState.playing = !masterState.playing;
        masterState.reproduzindo = masterState.playing;
        break;

      case 'pause':
        masterState.playing = false;
        masterState.reproduzindo = false;
        break;

      case 'power':
      case 'stop':
        masterState.fila = [];
        masterState.atual = 0;
        verificarStandby();
        break;

      case 'clear':
      case 'limpar':
        masterState.video = null;
        masterState.ativo = false;
        masterState.playing = false;
        masterState.reproduzindo = false;
        masterState.currentTime = 0;
        masterState.fila = [];
        masterState.atual = 0;
        verificarStandby();
        break;

      // Avançar 15 segundos
      case 'forward':
      case 'avancar_15':
      case 'forward_15':
      case '+15':
        if (masterState.video) {
          masterState.currentTime += 15;
        }
        break;

      // Voltar 15 segundos
      case 'rewind':
      case 'voltar_15':
      case 'rewind_15':
      case '-15':
        if (masterState.video) {
          masterState.currentTime = Math.max(0, masterState.currentTime - 15);
        }
        break;

      case 'mute':
        masterState.mudo = !masterState.mudo;
        break;

      case 'vol_up':
        masterState.volume = Math.min(100, masterState.volume + 10);
        break;

      case 'vol_down':
        masterState.volume = Math.max(0, masterState.volume - 10);
        break;

      case 'zerar_seek':
        masterState.seek = 0;
        break;

      // Próximo na Fila
      case 'next':
      case 'proximo_video':
        if (Array.isArray(masterState.fila) && masterState.fila.length > 0) {
          if (masterState.atual < masterState.fila.length - 1) {
            masterState.atual++;
            verificarStandby();
            masterState.currentTime = 0;
          } else {
            masterState.atual = masterState.fila.length;
            verificarStandby();
          }
        } else {
          verificarStandby();
        }
        break;

      // Anterior na Fila
      case 'prev':
      case 'previous':
        if (Array.isArray(masterState.fila) && masterState.fila.length > 0) {
          if (masterState.atual > 0) {
            masterState.atual--;
            verificarStandby();
            masterState.currentTime = 0;
          }
        }
        break;
    }

    if (targetTime !== undefined && !isNaN(targetTime)) {
      masterState.currentTime = Math.max(0, Number(targetTime));
      masterState.seek = masterState.currentTime;
    }

    masterState.updatedAt = Date.now();
    masterState.ultimoComando = slink || 'seek';
    masterState.comandoId = masterState.updatedAt;

    broadcastState(slink || 'seek');
  }

  res.json({ success: true, state: masterState });
});

// WebSocket para o Player / Clientes
wss.on('connection', (ws) => {
  if (masterState.fila.length === 0 && !masterState.video) {
    verificarStandby();
  }

  ws.send(JSON.stringify({
    tipo: "sync-transmission",
    ...masterState,
    currentTime: getCurrentPosition(),
    updatedAt: Date.now()
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.tipo === 'sync-request') {
        ws.send(JSON.stringify({
          tipo: "sync-transmission",
          ...masterState,
          currentTime: getCurrentPosition(),
          updatedAt: Date.now()
        }));
      }
    } catch(e) {}
  });
});

app.get(['/', '/smart-tv', '/smart-tv.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'smart-tv.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor X-Stream rodando na porta ${PORT} (Com Fila, Histórico e Modo Standby Automático)`);
});
