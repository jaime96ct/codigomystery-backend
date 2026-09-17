import express from 'express';
import { publishToYouTube } from './youtube.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const n8nActionWebhookUrl = process.env.N8N_ACTION_WEBHOOK_URL || '';
const n8nActionSecret = process.env.N8N_ACTION_SECRET || '';
const backendActionSecret = process.env.BACKEND_ACTION_SECRET || '';

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'codigomystery-backend',
    n8n_configured: Boolean(n8nActionWebhookUrl),
    youtube_configured: Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REFRESH_TOKEN),
    timestamp: new Date().toISOString(),
  });
});

function parseCallbackData(body) {
  const callbackData = body?.callback_query?.data ?? body?.callback_data ?? body?.data;
  if (typeof callbackData !== 'string' || !callbackData.trim()) {
    return { ok: false, status: 400, error: 'missing_callback_data' };
  }
  const match = callbackData.match(/^(publish|regenerate|discard)_(CM-.+)$/);
  if (!match) {
    return { ok: false, status: 400, error: 'invalid_callback_data', callback_data: callbackData };
  }
  const [, action, projectId] = match;
  return { ok: true, action, project_id: projectId, callback_data: callbackData };
}

async function sendActionToN8n(payload) {
  if (!n8nActionWebhookUrl) {
    const error = new Error('N8N_ACTION_WEBHOOK_URL is not configured');
    error.code = 'n8n_not_configured';
    throw error;
  }
  const headers = { 'content-type': 'application/json' };
  if (n8nActionSecret) headers['x-codigomystery-secret'] = n8nActionSecret;
  const response = await fetch(n8nActionWebhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const responseText = await response.text();
  let data = null;
  if (responseText) {
    try { data = JSON.parse(responseText); } catch { data = { raw: responseText }; }
  }
  if (!response.ok) {
    const error = new Error(`n8n responded with HTTP ${response.status}`);
    error.code = 'n8n_request_failed';
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

app.post('/webhook/codigomystery-telegram', async (req, res) => {
  if (telegramWebhookSecret && req.get('x-codigomystery-secret') !== telegramWebhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const parsed = parseCallbackData(req.body);
  if (!parsed.ok) return res.status(parsed.status).json(parsed);
  const payload = {
    action: parsed.action,
    project_id: parsed.project_id,
    callback_data: parsed.callback_data,
    source: 'telegram',
    received_at: new Date().toISOString(),
  };
  try {
    const n8n = await sendActionToN8n(payload);
    return res.json({ ok: true, ...payload, n8n });
  } catch (error) {
    return res.status(error.code === 'n8n_not_configured' ? 503 : 502).json({
      ok: false,
      error: error.code || 'n8n_error',
      message: error.message,
      action: payload.action,
      project_id: payload.project_id,
      n8n_status: error.status ?? null,
      n8n_response: error.data ?? null,
    });
  }
});

app.post('/actions/project', async (req, res) => {
  const { action, project_id: projectId } = req.body ?? {};
  if (!['publish', 'regenerate', 'discard'].includes(action)) {
    return res.status(400).json({ ok: false, error: 'invalid_action' });
  }
  if (typeof projectId !== 'string' || !projectId.startsWith('CM-')) {
    return res.status(400).json({ ok: false, error: 'invalid_project_id' });
  }
  const payload = { action, project_id: projectId, source: 'api', received_at: new Date().toISOString() };
  try {
    const n8n = await sendActionToN8n(payload);
    return res.json({ ok: true, ...payload, n8n });
  } catch (error) {
    return res.status(error.code === 'n8n_not_configured' ? 503 : 502).json({
      ok: false,
      error: error.code || 'n8n_error',
      message: error.message,
      action,
      project_id: projectId,
      n8n_status: error.status ?? null,
      n8n_response: error.data ?? null,
    });
  }
});

app.post('/publish/youtube', async (req, res) => {
  if (backendActionSecret && req.get('x-codigomystery-secret') !== backendActionSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const body = req.body ?? {};
  try {
    const result = await publishToYouTube({
      projectId: body.project_id,
      title: body.title,
      description: body.description ?? '',
      tags: body.tags ?? [],
      videoPath: body.video_path,
      privacyStatus: body.privacy_status,
    });
    return res.json({
      ok: true,
      project_id: body.project_id,
      published_at: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    const statusMap = {
      invalid_project_id: 400,
      invalid_video_path: 400,
      invalid_title: 400,
      video_not_found: 404,
      video_not_file: 400,
      youtube_not_configured: 503,
    };
    return res.status(statusMap[error.code] || 502).json({
      ok: false,
      error: error.code || 'youtube_publish_failed',
      message: error.message,
      project_id: body.project_id ?? null,
      missing: error.missing ?? null,
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

app.listen(port, () => {
  console.log(`CodigoMystery backend listening on port ${port}`);
});
