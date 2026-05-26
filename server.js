const express = require('express');
const axios = require('axios');

const app = express();
app.use(require('cors')());
app.use(express.json());

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const stream = req.body.stream || false;

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, req.body, {
      headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
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
      response.data.on('end', () => res.end());
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

app.listen(process.env.PORT || 3000);

// Add this after app.listen(...)
async function warmup() {
  try {
    await axios.post(`${NIM_API_BASE}/chat/completions`, {
      model: 'deepseek-ai/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      stream: false
    }, {
      headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' }
    });
    console.log('Warmup done');
  } catch (e) {
    console.log('Warmup failed:', e.message);
  }
}
warmup();
