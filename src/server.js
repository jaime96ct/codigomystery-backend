import express from 'express';

const app = express();
const port = Number(process.env.PORT || 3000);
const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'codigomystery-backend',
    timestamp: new Date().toISOString(),
  });
});

app.post('/webhook/codigomystery-telegram', (req, res) => {
  if (telegramWebhookSecret) {
    const receivedSecret = req.get('x-codigomystery-secret');
    if (receivedSecret !== telegramWebhookSecret) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  const callbackData = req.body?.callback_query?.data ?? req.body?.callback_data ?? req.body?.data;

  if (typeof callbackData !== 'string' || !callbackData.trim()) {
    return res.status(400).json({
      ok: false,
      error: 'missing_callback_data',
    });
  }

  const match = callbackData.match(/^(publish|regenerate|discard)_(CM-.+)$/);

  if (!match) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_callback_data',
      callback_data: callbackData,
    });
  }

  const [, action, projectId] = match;

  return res.json({
    ok: true,
    action,
    project_id: projectId,
    callback_data: callbackData,
    received_at: new Date().toISOString(),
  });
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

app.listen(port, () => {
  console.log(`CodigoMystery backend listening on port ${port}`);
});
