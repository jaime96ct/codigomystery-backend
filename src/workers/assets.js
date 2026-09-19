import sharp from 'sharp';
import { requireSupabase } from '../supabase.js';
import { renderStickmanSvg } from '../renderers/stickmanSvg.js';

async function updateProject(projectId, patch) {
  const supabase = requireSupabase();
  const { error } = await supabase.from('projects').update(patch).eq('project_id', projectId);
  if (error) throw error;
}


export async function normalizeSceneImage(inputBuffer) {
  const sourceMeta = await sharp(inputBuffer).metadata();
  const output = await sharp(inputBuffer)
    .rotate()
    .resize(1080, 1920, {
      fit: 'cover',
      position: 'centre',
    })
    .webp({
      quality: 90,
      effort: 5,
    })
    .toBuffer();

  return {
    buffer: output,
    mimeType: 'image/webp',
    extension: 'webp',
    width: 1080,
    height: 1920,
    sourceWidth: sourceMeta.width ?? null,
    sourceHeight: sourceMeta.height ?? null,
  };
}

export async function generateProjectImages(projectId) {
  const supabase = requireSupabase();

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('project_id,status,scenes(*)')
    .eq('project_id', projectId)
    .single();

  if (projectError) throw projectError;
  if (!project?.scenes?.length) {
    const error = new Error('Project has no scenes');
    error.code = 'project_has_no_scenes';
    throw error;
  }

  await updateProject(projectId, { status: 'GENERATING_SVG_PREVIEW', error_message: null });

  try {
    await supabase.from('assets').delete().eq('project_id', projectId).eq('type', 'image_svg');

    for (const scene of project.scenes.sort((a, b) => a.scene_number - b.scene_number)) {
      const svg = renderStickmanSvg({
        prompt: scene.image_prompt || '',
        visualSpec: scene.visual_spec || null,
        sceneNumber: scene.scene_number,
      });

      const path = `${projectId}/scenes/${scene.scene_number}/image.svg`;
      const { error: uploadError } = await supabase.storage
        .from('projects')
        .upload(path, Buffer.from(svg, 'utf8'), {
          contentType: 'image/svg+xml',
          upsert: true,
          cacheControl: '3600',
        });
      if (uploadError) throw uploadError;

      const { error: sceneError } = await supabase
        .from('scenes')
        .update({ image_url: path, status: 'SVG_PREVIEW_READY', image_provider: 'codigomystery_procedural_preview' })
        .eq('id', scene.id);
      if (sceneError) throw sceneError;

      const { error: assetError } = await supabase
        .from('assets')
        .insert({
          project_id: projectId,
          scene_id: scene.id,
          type: 'image_svg_preview',
          provider: 'codigomystery_procedural_preview',
          url: path,
          metadata: {
            width: 1080,
            height: 1920,
            format: 'svg',
            zero_cost: true,
          },
        });
      if (assetError) throw assetError;
    }

    await updateProject(projectId, { status: 'READY_FOR_IMAGES' });
    return { ok: true, status: 'READY_FOR_IMAGES', scenes: project.scenes.length };
  } catch (error) {
    await updateProject(projectId, {
      status: 'ERROR',
      error_message: error.message,
    }).catch(() => {});
    throw error;
  }
}

export async function signProjectImageUrls(project) {
  const supabase = requireSupabase();
  if (!project?.scenes?.length) return project;

  const scenes = await Promise.all(project.scenes.map(async (scene) => {
    if (!scene.image_url) return scene;
    const { data, error } = await supabase.storage
      .from('projects')
      .createSignedUrl(scene.image_url, 3600);

    return {
      ...scene,
      image_preview_url: error ? null : data?.signedUrl ?? null,
    };
  }));

  let voice_preview_url = null;
  let music_preview_url = null;
  let final_video_preview_url = null;
  const assets = Array.isArray(project.assets) ? project.assets : [];

  const voiceAsset = assets.find((asset) => asset.type === 'voice_final' && asset.url);
  if (voiceAsset?.url) {
    const { data: voiceSigned, error: voiceError } = await supabase.storage
      .from('projects')
      .createSignedUrl(voiceAsset.url, 3600);
    voice_preview_url = voiceError ? null : voiceSigned?.signedUrl ?? null;
  }

  const musicAsset = assets.find((asset) => asset.type === 'music_final' && asset.url);
  if (musicAsset?.url) {
    const { data: musicSigned, error: musicError } = await supabase.storage
      .from('projects')
      .createSignedUrl(musicAsset.url, 3600);
    music_preview_url = musicError ? null : musicSigned?.signedUrl ?? null;
  }

  const finalVideoAsset = assets.find((asset) => asset.type === 'final_video' && asset.url);
  if (finalVideoAsset?.url) {
    const { data: videoSigned, error: videoError } = await supabase.storage
      .from('projects')
      .createSignedUrl(finalVideoAsset.url, 3600);
    final_video_preview_url = videoError ? null : videoSigned?.signedUrl ?? null;
  }

  return {
    ...project,
    scenes,
    voice_preview_url,
    music_preview_url,
    final_video_preview_url,
  };
}


export async function materializeScheduledImages(projectId) {
  const supabase = requireSupabase();

  const { data: queueItem, error: queueError } = await supabase
    .from('content_queue')
    .select('id')
    .eq('project_id', projectId)
    .maybeSingle();

  if (queueError) throw queueError;
  if (!queueItem) {
    return { ok: true, materialized: 0, pending: true, reason: 'queue_item_not_found' };
  }

  const [{ data: staged, error: stagedError }, { data: scenes, error: scenesError }] =
    await Promise.all([
      supabase
        .from('content_queue_images')
        .select('id,scene_number,status,source,mime_type,width,height,image_base64,error_message')
        .eq('content_queue_id', queueItem.id)
        .order('scene_number', { ascending: true }),
      supabase
        .from('scenes')
        .select('id,scene_number,status,image_url')
        .eq('project_id', projectId)
        .order('scene_number', { ascending: true }),
    ]);

  if (stagedError) throw stagedError;
  if (scenesError) throw scenesError;

  const stagedByScene = new Map((staged ?? []).map((row) => [row.scene_number, row]));
  let materialized = 0;

  for (const scene of scenes ?? []) {
    const source = stagedByScene.get(scene.scene_number);
    if (!source || source.status !== 'READY' || !source.image_base64) continue;

    const stagedMimeType = source.mime_type || 'image/webp';
    const stagedBytes = Buffer.from(source.image_base64, 'base64');
    const normalized = await normalizeSceneImage(stagedBytes);
    const storagePath = `${projectId}/scenes/${scene.scene_number}/image.${normalized.extension}`;

    const { error: uploadError } = await supabase.storage
      .from('projects')
      .upload(storagePath, normalized.buffer, {
        contentType: normalized.mimeType,
        upsert: true,
        cacheControl: '3600',
      });
    if (uploadError) throw uploadError;

    const { error: sceneUpdateError } = await supabase
      .from('scenes')
      .update({
        image_url: storagePath,
        status: 'IMAGE_READY',
        image_provider: source.source || 'chatgpt_scheduled',
        image_generation_notes: 'Generated ahead of time by the scheduled ChatGPT image task.',
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
        project_id: projectId,
        scene_id: scene.id,
        type: 'image_final',
        provider: source.source || 'chatgpt_scheduled',
        url: storagePath,
        metadata: {
          mime_type: normalized.mimeType,
          width: normalized.width,
          height: normalized.height,
          source_mime_type: stagedMimeType,
          source_width: normalized.sourceWidth ?? source.width,
          source_height: normalized.sourceHeight ?? source.height,
          bytes: normalized.buffer.length,
          aspect_ratio: '9:16',
          character_model: 'codigomystery_stickman_v1',
        },
      });
    if (assetError) throw assetError;

    const { error: stageUpdateError } = await supabase
      .from('content_queue_images')
      .update({
        status: 'MATERIALIZED',
        image_base64: null,
        error_message: null,
      })
      .eq('id', source.id);
    if (stageUpdateError) throw stageUpdateError;

    materialized += 1;
  }

  const { data: refreshedScenes, error: refreshError } = await supabase
    .from('scenes')
    .select('id,status,image_url')
    .eq('project_id', projectId);
  if (refreshError) throw refreshError;

  const allReady = Boolean(
    refreshedScenes?.length &&
    refreshedScenes.every((scene) => scene.status === 'IMAGE_READY' && scene.image_url),
  );

  const nextStatus = allReady ? 'IMAGES_READY_FOR_REVIEW' : 'READY_FOR_IMAGES';
  await updateProject(projectId, { status: nextStatus, error_message: null });

  return {
    ok: true,
    materialized,
    total_scenes: refreshedScenes?.length ?? 0,
    status: nextStatus,
  };
}
