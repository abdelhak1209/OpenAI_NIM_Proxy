// server.js - OpenAI to NVIDIA NIM API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = true;    // true = show <think> blocks
const ENABLE_THINKING_MODE = false; // true = send thinking param to model

const MODEL_MAPPING = {
  'z-ai/glm-5.1': 'z-ai/glm-5.1',
  'minimaxai/minimax-m2.7': 'minimaxai/minimax-m2.7',
  'moonshotai/kimi-k2.6': 'moonshotai/kimi-k2.6',
  'deepseek-ai/deepseek-v4-pro': 'deepseek-ai/deepseek-v4-pro',
  'deepseek-ai/deepseek-v4-flash': 'deepseek-ai/deepseek-v4-flash',
  'stepfun-ai/step-3.5-flash': 'stepfun-ai/step-3.5-flash',
  'qwen/qwen3-coder-480b-a35b-instruct': 'qwen/qwen3-coder-480b-a35b-instruct',
  'qwen/qwen3.5-397b-a17b': 'qwen/qwen3.5-397b-a17b'
};

// Keep-alive endpoints for UptimeRobot
app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy' }));

// Models list (for Janitor AI model picker)
app.get('/v1/models', (req, res) => res.json({
  object: 'list',
  data: Object.keys(MODEL_MAPPING).map(id => ({
    id, object: 'model', created: Date.now(), owned_by: 'nvidia-nim-proxy'
  }))
}));

// Main proxy
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    // Fall back to flash model if unrecognized
    const nimModel = MODEL_MAPPING[model] || 'deepseek-ai/deepseek-v4-flash';

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, {
      model: nimModel,
      messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 9024,
      ...(ENABLE_THINKING_MODE && { extra_body: { chat_template_kwargs: { thinking: true } } }),
      stream: stream || false
    }, {
      headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
      responseType: stream ? 'stream' : 'json'
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      let reasoningStarted = false;

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          if (line.includes('[DONE]')) { res.write(line + '\n\n'); continue; }

          try {
            const data = JSON.parse(line.slice(6));
            const delta = data.choices?.[0]?.delta;

            if (delta) {
              const reasoning = delta.reasoning_content;
              const content = delta.content;
              delete delta.reasoning_content;

              if (SHOW_REASONING) {
                let out = '';
                if (reasoning && !reasoningStarted) { out = '<think>\n' + reasoning; reasoningStarted = true; }
                else if (reasoning) { out = reasoning; }
                if (content && reasoningStarted) { out += '</think>\n\n' + content; reasoningStarted = false; }
                else if (content) { out += content; }
                if (!out) continue;
                delta.content = out;
              } else {
                if (!content) continue; // skip reasoning-only chunks
                delta.content = content;
              }
            }

            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch (e) {
            res.write(line + '\n\n');
          }
        }
      });

      response.data.on('end', () => res.end());
      response.data.on('error', (err) => { console.error('Stream error:', err); res.end(); });

    } else {
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: response.data.choices.map(choice => {
          let content = choice.message?.content || '';
          if (SHOW_REASONING && choice.message?.reasoning_content)
            content = `<think>\n${choice.message.reasoning_content}\n</think>\n\n` + content;
          return { index: choice.index, message: { role: choice.message.role, content }, finish_reason: choice.finish_reason };
        }),
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: { message: error.message || 'Internal server error', type: 'invalid_request_error', code: error.response?.status || 500 }
    });
  }
});

app.all('*', (req, res) => res.status(404).json({ error: { message: `Endpoint ${req.path} not found` } }));

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
