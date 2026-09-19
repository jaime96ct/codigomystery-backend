import express from 'express';
import { publishToYouTube } from './youtube.js';
import { isSupabaseConfigured, requireSupabase } from './supabase.js';
import { generateProjectImages, signProjectImageUrls, materializeScheduledImages } from './workers/assets.js';
import { generateProjectTimeline } from './workers/timeline.js';
import { renderProjectVideo } from './workers/render.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const n8nActionWebhookUrl = process.env.N8N_ACTION_WEBHOOK_URL || '';
const n8nActionSecret = process.env.N8N_ACTION_SECRET || '';
const backendActionSecret = process.env.BACKEND_ACTION_SECRET || '';

app.use(express.json({ limit: '1mb' }));

const allowedOrigins = new Set([
  process.env.FRONTEND_ORIGIN || 'https://codigomystery-web.jaime96ct.workers.dev',
  'http://localhost:5173',
]);

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-codigomystery-secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'codigomystery-backend',
    n8n_configured: Boolean(n8nActionWebhookUrl),
    youtube_configured: Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REFRESH_TOKEN),
    supabase_configured: isSupabaseConfigured,
    database_configured: Boolean(process.env.DATABASE_URL),
    timestamp: new Date().toISOString(),
  });
});

function createProjectId() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const suffix = String(Date.now()).slice(-6);
  return `CM-${date}-${suffix}`;
}

app.get('/projects', async (_req, res) => {
  try {
    const supabase = requireSupabase();
    const { data, error } = await supabase
      .from('projects')
      .select('project_id,status,format,language,title,style,created_at,updated_at')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    return res.json({ ok: true, projects: data ?? [] });
  } catch (error) {
    return res.status(error.code === 'supabase_not_configured' ? 503 : 500).json({
      ok: false,
      error: error.code || 'projects_list_failed',
      message: error.message,
    });
  }
});

app.get('/content-queue/today', async (_req, res) => {
  try {
    const supabase = requireSupabase();
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Madrid',
    }).format(new Date());

    const { data, error } = await supabase
      .from('content_queue')
      .select('id,slot,status,title,topic,project_id,created_at,claimed_at,scenes')
      .eq('content_date', today)
      .order('slot', { ascending: true });

    if (error) throw error;

    const ids = (data ?? []).map((item) => item.id);
    let staged = [];
    if (ids.length) {
      const { data: stagedData, error: stagedError } = await supabase
        .from('content_queue_images')
        .select('content_queue_id,status')
        .in('content_queue_id', ids);
      if (stagedError) throw stagedError;
      staged = stagedData ?? [];
    }

    const items = (data ?? []).map(({ scenes, ...item }) => {
      const imageRows = staged.filter((row) => row.content_queue_id === item.id);
      return {
        ...item,
        scene_count: Array.isArray(scenes) ? scenes.length : 0,
        images_ready: imageRows.filter((row) => ['READY', 'MATERIALIZED'].includes(row.status)).length,
        image_errors: imageRows.filter((row) => row.status === 'ERROR').length,
      };
    });

    return res.json({ ok: true, content_date: today, items });
  } catch (error) {
    return res.status(error.code === 'supabase_not_configured' ? 503 : 500).json({
      ok: false,
      error: error.code || 'content_queue_failed',
      message: error.message,
    });
  }
});

app.post('/projects', async (req, res) => {
  try {
    const supabase = requireSupabase();
    const body = req.body ?? {};
    const projectId = createProjectId();
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Madrid',
    }).format(new Date());

    const { data, error } = await supabase.rpc('claim_daily_content', {
      p_project_id: projectId,
      p_content_date: today,
      p_format: body.format || 'Micro-misterio',
      p_language: body.language || 'Español',
      p_style: body.style || 'Stickman CodigoMystery',
    });

    if (error) throw error;

    if (!data) {
      return res.status(409).json({
        ok: false,
        error: 'no_prepared_content_today',
        message: 'No hay contenido preparado disponible para hoy.',
      });
    }

    setTimeout(() => {
      void generateProjectTimeline(projectId).catch((timelineError) => {
        console.error('[timeline-worker] generation failed:', timelineError.message);
      });
      void materializeScheduledImages(projectId).catch((assetError) => {
        console.error('[scheduled-images] materialization failed:', assetError.message);
      });
    }, 0);

    return res.status(201).json({ ok: true, project: data });
  } catch (error) {
    return res.status(error.code === 'supabase_not_configured' ? 503 : 500).json({
      ok: false,
      error: error.code || 'project_create_failed',
      message: error.message,
    });
  }
});

app.get('/projects/:projectId', async (req, res) => {
  try {
    const supabase = requireSupabase();
    const { data, error } = await supabase
      .from('projects')
      .select('*, scenes(*), jobs(*), assets(*)')
      .eq('project_id', req.params.projectId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ ok: false, error: 'project_not_found' });
      }
      throw error;
    }

    const project = await signProjectImageUrls(data);
    return res.json({ ok: true, project });
  } catch (error) {
    return res.status(error.code === 'supabase_not_configured' ? 503 : 500).json({
      ok: false,
      error: error.code || 'project_read_failed',
      message: error.message,
    });
  }
});

app.post('/projects/:projectId/generate-svg-preview', async (req, res) => {
  if (!backendActionSecret || req.get('x-codigomystery-secret') !== backendActionSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const result = await generateProjectImages(req.params.projectId);
    return res.json({ ...result, preview_only: true });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.code || 'svg_preview_generation_failed',
      message: error.message,
    });
  }
});


app.post(
  '/projects/:projectId/scenes/:sceneId/image',
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '12mb' }),
  async (req, res) => {
    try {
      const supabase = requireSupabase();
      const mimeType = req.get('content-type') || '';
      const extensionMap = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
      };
      const extension = extensionMap[mimeType];

      if (!extension || !Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ ok: false, error: 'invalid_image_upload' });
      }

      const { data: scene, error: sceneReadError } = await supabase
        .from('scenes')
        .select('id,project_id,scene_number,image_url')
        .eq('id', req.params.sceneId)
        .eq('project_id', req.params.projectId)
        .single();

      if (sceneReadError) {
        if (sceneReadError.code === 'PGRST116') {
          return res.status(404).json({ ok: false, error: 'scene_not_found' });
        }
        throw sceneReadError;
      }

      const storagePath = `${req.params.projectId}/scenes/${scene.scene_number}/image.${extension}`;
      const { error: uploadError } = await supabase.storage
        .from('projects')
        .upload(storagePath, req.body, {
          contentType: mimeType,
          upsert: true,
          cacheControl: '3600',
        });
      if (uploadError) throw uploadError;

      if (scene.image_url && scene.image_url !== storagePath) {
        await supabase.storage.from('projects').remove([scene.image_url]).catch(() => {});
      }

      const provider = req.get('x-image-provider') || 'manual_upload';
      const { error: sceneUpdateError } = await supabase
        .from('scenes')
        .update({
          image_url: storagePath,
          status: 'IMAGE_READY',
          image_provider: provider,
          image_generation_notes: req.get('x-image-notes') || null,
        })
        .eq('id', scene.id);
      if (sceneUpdateError) throw sceneUpdateError;

      await supabase
        .from('assets')
        .delete()
        .eq('scene_id', scene.id)
        .eq('type', 'image_final');

      const { error: assetError } = await supabase
        .from('assets')
        .insert({
          project_id: req.params.projectId,
          scene_id: scene.id,
          type: 'image_final',
          provider,
          url: storagePath,
          metadata: {
            mime_type: mimeType,
            bytes: req.body.length,
            aspect_ratio: '9:16',
            character_model: 'codigomystery_stickman_v1',
          },
        });
      if (assetError) throw assetError;

      const { data: signed, error: signedError } = await supabase.storage
        .from('projects')
        .createSignedUrl(storagePath, 3600);

      return res.status(201).json({
        ok: true,
        scene_id: scene.id,
        image_url: storagePath,
        image_preview_url: signedError ? null : signed?.signedUrl ?? null,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.code || 'image_upload_failed',
        message: error.message,
      });
    }
  },
);

app.post('/projects/:projectId/approve-images', async (req, res) => {
  try {
    const supabase = requireSupabase();
    const { data: scenes, error } = await supabase
      .from('scenes')
      .select('id,status,image_url')
      .eq('project_id', req.params.projectId);

    if (error) throw error;
    if (!scenes?.length) {
      return res.status(400).json({ ok: false, error: 'project_has_no_scenes' });
    }

    const pending = scenes.filter((scene) => scene.status !== 'IMAGE_READY' || !scene.image_url);
    if (pending.length) {
      return res.status(409).json({
        ok: false,
        error: 'images_not_ready',
        pending_scene_ids: pending.map((scene) => scene.id),
      });
    }

    const { error: projectError } = await supabase
      .from('projects')
      .update({ status: 'READY_FOR_VOICE', error_message: null })
      .eq('project_id', req.params.projectId);
    if (projectError) throw projectError;

    return res.json({ ok: true, status: 'READY_FOR_VOICE' });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.code || 'image_approval_failed',
      message: error.message,
    });
  }
});


app.post(
  '/projects/:projectId/voice',
  express.raw({
    type: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/aac', 'audio/ogg'],
    limit: '30mb',
  }),
  async (req, res) => {
    try {
      const supabase = requireSupabase();
      const mimeType = req.get('content-type') || '';
      const extensionMap = {
        'audio/mpeg': 'mp3',
        'audio/wav': 'wav',
        'audio/x-wav': 'wav',
        'audio/mp4': 'm4a',
        'audio/aac': 'aac',
        'audio/ogg': 'ogg',
      };
      const extension = extensionMap[mimeType];

      if (!extension || !Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ ok: false, error: 'invalid_voice_upload' });
      }

      const { data: project, error: projectError } = await supabase
        .from('projects')
        .select('project_id')
        .eq('project_id', req.params.projectId)
        .single();
      if (projectError) {
        if (projectError.code === 'PGRST116') {
          return res.status(404).json({ ok: false, error: 'project_not_found' });
        }
        throw projectError;
      }

      const storagePath = `${req.params.projectId}/voice/voice.${extension}`;
      const { error: uploadError } = await supabase.storage
        .from('projects')
        .upload(storagePath, req.body, {
          contentType: mimeType,
          upsert: true,
          cacheControl: '3600',
        });
      if (uploadError) throw uploadError;

      await supabase
        .from('assets')
        .delete()
        .eq('project_id', req.params.projectId)
        .eq('type', 'voice_final');

      const provider = req.get('x-voice-provider') || 'manual_upload';
      const { error: assetError } = await supabase
        .from('assets')
        .insert({
          project_id: req.params.projectId,
          type: 'voice_final',
          provider,
          url: storagePath,
          metadata: {
            mime_type: mimeType,
            bytes: req.body.length,
          },
        });
      if (assetError) throw assetError;

      const { data: scenes, error: scenesError } = await supabase
        .from('scenes')
        .select('id,status,image_url')
        .eq('project_id', req.params.projectId);
      if (scenesError) throw scenesError;

      const imagesReady = Boolean(
        scenes?.length &&
        scenes.every((scene) => scene.status === 'IMAGE_READY' && scene.image_url),
      );

      const nextStatus = imagesReady ? 'READY_FOR_RENDER' : 'VOICE_READY_IMAGES_PENDING';
      const { error: statusError } = await supabase
        .from('projects')
        .update({ status: nextStatus, error_message: null })
        .eq('project_id', req.params.projectId);
      if (statusError) throw statusError;

      if (imagesReady) {
        setTimeout(() => {
          void renderProjectVideo(req.params.projectId).catch((renderError) => {
            console.error('[render-worker] project failed:', renderError.message);
          });
        }, 0);
      }

      const { data: signed, error: signedError } = await supabase.storage
        .from('projects')
        .createSignedUrl(storagePath, 3600);

      return res.status(201).json({
        ok: true,
        project_id: project.project_id,
        status: nextStatus,
        voice_url: storagePath,
        voice_preview_url: signedError ? null : signed?.signedUrl ?? null,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.code || 'voice_upload_failed',
        message: error.message,
      });
    }
  },
);


app.post('/projects/:projectId/render', async (req, res) => {
  try {
    const result = await renderProjectVideo(req.params.projectId);
    return res.json(result);
  } catch (error) {
    const statusMap = {
      project_has_no_scenes: 400,
      images_not_ready: 409,
      voice_not_ready: 409,
      ffmpeg_unavailable: 503,
    };
    return res.status(statusMap[error.code] || 500).json({
      ok: false,
      error: error.code || 'render_failed',
      message: error.message,
      pending_scene_ids: error.pending_scene_ids ?? null,
    });
  }
});


app.patch('/projects/:projectId/metadata', async (req, res) => {
  try {
    const supabase = requireSupabase();
    const body = req.body ?? {};
    const patch = {};

    if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 100);
    if (typeof body.description === 'string') patch.description = body.description.slice(0, 5000);
    if (Array.isArray(body.tags)) {
      patch.tags = body.tags
        .filter((tag) => typeof tag === 'string' && tag.trim())
        .map((tag) => tag.trim())
        .slice(0, 30);
    }
    if (['REAL', 'INVENTADO', 'INSPIRADO'].includes(body.content_origin)) {
      patch.content_origin = body.content_origin;
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({ ok: false, error: 'no_valid_metadata_fields' });
    }

    const { data, error } = await supabase
      .from('projects')
      .update(patch)
      .eq('project_id', req.params.projectId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ ok: false, error: 'project_not_found' });
      }
      throw error;
    }

    return res.json({ ok: true, project: data });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.code || 'metadata_update_failed',
      message: error.message,
    });
  }
});

app.post('/projects/:projectId/approve-review', async (req, res) => {
  try {
    const supabase = requireSupabase();
    const { data: project, error: readError } = await supabase
      .from('projects')
      .select('project_id,status,video_qa,final_video_url')
      .eq('project_id', req.params.projectId)
      .single();

    if (readError) {
      if (readError.code === 'PGRST116') {
        return res.status(404).json({ ok: false, error: 'project_not_found' });
      }
      throw readError;
    }

    if (project.status !== 'READY_FOR_REVIEW') {
      return res.status(409).json({
        ok: false,
        error: 'project_not_ready_for_review',
        status: project.status,
      });
    }

    if (!project.video_qa?.passed || !project.final_video_url) {
      return res.status(409).json({ ok: false, error: 'video_qa_not_passed' });
    }

    const { error } = await supabase
      .from('projects')
      .update({
        status: 'APPROVED',
        approved_at: new Date().toISOString(),
        error_message: null,
      })
      .eq('project_id', req.params.projectId);
    if (error) throw error;

    return res.json({ ok: true, status: 'APPROVED' });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.code || 'review_approval_failed',
      message: error.message,
    });
  }
});

app.post('/projects/:projectId/discard', async (req, res) => {
  try {
    const supabase = requireSupabase();
    const { data, error } = await supabase
      .from('projects')
      .update({ status: 'DISCARDED' })
      .eq('project_id', req.params.projectId)
      .select('project_id,status')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ ok: false, error: 'project_not_found' });
      }
      throw error;
    }

    return res.json({ ok: true, project: data });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.code || 'project_discard_failed',
      message: error.message,
    });
  }
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
