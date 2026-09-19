import { requireSupabase } from '../supabase.js';

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(ms, 3)}`;
}

export async function generateProjectTimeline(projectId) {
  const supabase = requireSupabase();

  const { data: scenes, error } = await supabase
    .from('scenes')
    .select('id,scene_number,narration,duration')
    .eq('project_id', projectId)
    .order('scene_number', { ascending: true });

  if (error) throw error;
  if (!scenes?.length) {
    const timelineError = new Error('Project has no scenes');
    timelineError.code = 'project_has_no_scenes';
    throw timelineError;
  }

  let cursor = 0;
  const timeline = [];

  for (const scene of scenes) {
    const duration = Number(scene.duration || 0);
    const start = cursor;
    const end = cursor + duration;
    cursor = end;

    const { error: updateError } = await supabase
      .from('scenes')
      .update({ start_time: start, end_time: end })
      .eq('id', scene.id);
    if (updateError) throw updateError;

    timeline.push({
      scene_number: scene.scene_number,
      start,
      end,
      duration,
      narration: scene.narration || '',
    });
  }

  const srt = timeline
    .map((item, index) => [
      String(index + 1),
      `${formatSrtTime(item.start)} --> ${formatSrtTime(item.end)}`,
      item.narration,
      '',
    ].join('\n'))
    .join('\n');

  const storagePath = `${projectId}/subtitles/subtitles.srt`;
  const { error: uploadError } = await supabase.storage
    .from('projects')
    .upload(storagePath, Buffer.from(srt, 'utf8'), {
      contentType: 'application/x-subrip',
      upsert: true,
      cacheControl: '3600',
    });
  if (uploadError) throw uploadError;

  await supabase
    .from('assets')
    .delete()
    .eq('project_id', projectId)
    .eq('type', 'subtitles_srt');

  const { error: assetError } = await supabase
    .from('assets')
    .insert({
      project_id: projectId,
      type: 'subtitles_srt',
      provider: 'codigomystery_timeline',
      url: storagePath,
      metadata: {
        format: 'srt',
        estimated_duration: cursor,
        timing_source: 'scene_duration',
      },
    });
  if (assetError) throw assetError;

  const { error: projectError } = await supabase
    .from('projects')
    .update({
      estimated_duration: cursor,
      subtitles_url: storagePath,
      timeline,
    })
    .eq('project_id', projectId);
  if (projectError) throw projectError;

  return {
    ok: true,
    project_id: projectId,
    estimated_duration: cursor,
    subtitles_url: storagePath,
    timeline,
  };
}
