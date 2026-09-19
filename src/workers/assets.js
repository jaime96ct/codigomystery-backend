import { requireSupabase } from '../supabase.js';
import { renderStickmanSvg } from '../renderers/stickmanSvg.js';

async function updateProject(projectId, patch) {
  const supabase = requireSupabase();
  const { error } = await supabase.from('projects').update(patch).eq('project_id', projectId);
  if (error) throw error;
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

  await updateProject(projectId, { status: 'GENERATING_IMAGES', error_message: null });

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
        .update({ image_url: path, status: 'IMAGE_READY' })
        .eq('id', scene.id);
      if (sceneError) throw sceneError;

      const { error: assetError } = await supabase
        .from('assets')
        .insert({
          project_id: projectId,
          scene_id: scene.id,
          type: 'image_svg',
          provider: 'codigomystery_procedural',
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

    await updateProject(projectId, { status: 'READY_FOR_VOICE' });
    return { ok: true, status: 'READY_FOR_VOICE', scenes: project.scenes.length };
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

  return { ...project, scenes };
}
