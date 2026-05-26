const express = require('express');
const axios = require('axios');

const app = express();
app.use(require('cors')());
app.use(express.json());

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;
const WARM_MODEL   = process.env.WARM_MODEL || 'deepseek-ai/deepseek-v4-flash';

// ── Keep NVIDIA model warm every 4 minutes ──────────────────────────────────
// UptimeRobot keeps Railway alive every 1 min.
// This keeps the NVIDIA model GPU-warm independently, using only ~360 req/day.
let lastWarm = 0;
async function warmNvidia() {
  if (!NIM_API_KEY) return;
  try {
    await axios.post(`${NIM_API_BASE}/chat/completions`, {
      model: WARM_MODEL,
      messages: [{ role: 'user', content: '.' }],
      max_tokens: 1,
      stream: false
    }, {
      headers: { Authorization: `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    lastWarm = Date.now();
    console.log('NVIDIA warm OK', new Date().toISOString());
  } catch (e) {
    console.log('NVIDIA warm failed:', e.message);
  }
}

// Fire once 10s after boot (Railway needs a moment to settle), then every 4 min
setTimeout(() => {
  warmNvidia();
  setInterval(warmNvidia, 4 * 60 * 1000);
}, 10000);

// ── Endpoints ────────────────────────────────────────────────────────────────
app.get('/',       (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok', last_warm: lastWarm ? new Date(lastWarm).toISOString() : 'pending' }));

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const stream = req.body.stream || false;

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, req.body, {
      headers: { Authorization: `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
      responseType: stream ? 'stream' : 'json'
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) res.write(line + '\n\n');
        }
      });
      response.data.on('end',   () => res.end());
      response.data.on('error', () => res.end());

    } else {
      res.json(response.data);
    }

  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: { message: error.message, type: 'proxy_error' }
    });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Proxy ready'));
