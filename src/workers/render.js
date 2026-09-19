import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { requireSupabase } from '../supabase.js';
import { probeMedia, qualityCheckVideo } from './videoQa.js';

function extensionFromPath(storagePath, fallback) {
  const ext = path.extname(storagePath || '').toLowerCase();
  return ext || fallback;
}

async function storageDownloadToFile(supabase, storagePath, localPath) {
  const { data, error } = await supabase.storage.from('projects').download(storagePath);
  if (error) throw error;
  const buffer = Buffer.from(await data.arrayBuffer());
  await fs.writeFile(localPath, buffer);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      const error = new Error('FFmpeg binary is unavailable');
      error.code = 'ffmpeg_unavailable';
      reject(error);
      return;
    }

    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 18000) stderr = stderr.slice(-18000);
    });

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const error = new Error(`FFmpeg exited with code ${code}`);
      error.code = 'ffmpeg_failed';
      error.stderr = stderr;
      reject(error);
    });
  });
}

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

function splitSubtitleChunks(text, maxWords = 4) {
  const words = String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const chunks = [];
  for (let index = 0; index < words.length; index += maxWords) {
    chunks.push(words.slice(index, index + maxWords).join(' '));
  }
  return chunks;
}

function buildVoiceSyncedTimeline(scenes, voiceDuration) {
  const originalTotal = scenes.reduce(
    (sum, scene) => sum + Math.max(0.1, Number(scene.duration || 1)),
    0,
  );
  const targetDuration = Math.max(0.5, Number(voiceDuration || originalTotal));
  const scale = targetDuration / originalTotal;

  let cursor = 0;
  return scenes.map((scene, index) => {
    const isLast = index === scenes.length - 1;
    const duration = isLast
      ? Math.max(0.5, targetDuration - cursor)
      : Math.max(0.5, Number(scene.duration || 1) * scale);

    const start = cursor;
    const end = isLast ? targetDuration : Math.min(targetDuration, start + duration);
    cursor = end;

    return {
      ...scene,
      duration: Math.max(0.5, end - start),
      start_time: start,
      end_time: end,
    };
  });
}

function buildChunkedSrt(scenes) {
  const entries = [];
  let index = 1;

  for (const scene of scenes) {
    const chunks = splitSubtitleChunks(scene.narration, 4);
    if (!chunks.length) continue;

    const wordCounts = chunks.map((chunk) => chunk.split(/\s+/).length);
    const totalWords = wordCounts.reduce((sum, count) => sum + count, 0);
    let cursor = Number(scene.start_time || 0);
    const sceneEnd = Number(scene.end_time || cursor + Number(scene.duration || 0));

    chunks.forEach((chunk, chunkIndex) => {
      const isLast = chunkIndex === chunks.length - 1;
      const proportional = totalWords
        ? Number(scene.duration || 0) * (wordCounts[chunkIndex] / totalWords)
        : Number(scene.duration || 0) / chunks.length;
      const end = isLast ? sceneEnd : Math.min(sceneEnd, cursor + proportional);

      entries.push([
        String(index),
        `${formatSrtTime(cursor)} --> ${formatSrtTime(end)}`,
        chunk,
        '',
      ].join('\n'));

      cursor = end;
      index += 1;
    });
  }

  return entries.join('\n');
}

async function persistVoiceSyncedTimeline(supabase, projectId, scenes) {
  const srt = buildChunkedSrt(scenes);
  const storagePath = `${projectId}/subtitles/subtitles.srt`;

  const { error: uploadError } = await supabase.storage
    .from('projects')
    .upload(storagePath, Buffer.from(srt, 'utf8'), {
      contentType: 'application/x-subrip',
      upsert: true,
      cacheControl: '3600',
    });
  if (uploadError) throw uploadError;

  for (const scene of scenes) {
    const { error } = await supabase
      .from('scenes')
      .update({
        start_time: scene.start_time,
        end_time: scene.end_time,
      })
      .eq('id', scene.id);
    if (error) throw error;
  }

  const timeline = scenes.map((scene) => ({
    scene_number: scene.scene_number,
    start: scene.start_time,
    end: scene.end_time,
    duration: scene.duration,
    narration: scene.narration || '',
  }));

  const totalDuration = scenes.length
    ? Number(scenes[scenes.length - 1].end_time || 0)
    : 0;

  const { error: projectError } = await supabase
    .from('projects')
    .update({
      estimated_duration: totalDuration,
      subtitles_url: storagePath,
      timeline,
    })
    .eq('project_id', projectId);
  if (projectError) throw projectError;

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
      provider: 'codigomystery_voice_synced_timeline',
      url: storagePath,
      metadata: {
        format: 'srt',
        estimated_duration: totalDuration,
        chunk_max_words: 4,
        timing_source: 'voice_duration_scaled',
      },
    });
  if (assetError) throw assetError;

  return { storagePath, srt, totalDuration };
}

function buildFfmpegArgs({
  scenes,
  imagePaths,
  voicePath,
  musicPath,
  subtitlesPath,
  outputPath,
  burnSubtitles,
}) {
  const args = ['-y'];

  scenes.forEach((scene, index) => {
    const duration = Math.max(0.5, Number(scene.duration || 1));
    args.push('-loop', '1', '-t', String(duration), '-i', imagePaths[index]);
  });

  const voiceInputIndex = scenes.length;
  args.push('-i', voicePath);

  let musicInputIndex = null;
  if (musicPath) {
    musicInputIndex = scenes.length + 1;
    args.push('-stream_loop', '-1', '-i', musicPath);
  }

  const filters = scenes.map((_, index) =>
    `[${index}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(zoom+0.00045,1.045)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${index}]`,
  );

  const concatInputs = scenes.map((_, index) => `[v${index}]`).join('');
  filters.push(`${concatInputs}concat=n=${scenes.length}:v=1:a=0[vcat]`);

  let videoLabel = '[vcat]';
  if (burnSubtitles && subtitlesPath) {
    const escaped = subtitlesPath.replaceAll('\\', '/').replaceAll("'", "\\'");
    filters.push(
      `[vcat]subtitles='${escaped}':force_style='FontSize=28,Alignment=2,MarginV=155,Outline=3,Shadow=0,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010'[vout]`,
    );
    videoLabel = '[vout]';
  }

  let audioMap = `${voiceInputIndex}:a:0`;
  if (musicInputIndex !== null) {
    filters.push(
      `[${voiceInputIndex}:a]volume=1.0[voice]`,
      `[${musicInputIndex}:a]volume=0.12[music]`,
      '[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]',
    );
    audioMap = '[aout]';
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', videoLabel,
    '-map', audioMap,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '21',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    outputPath,
  );

  return args;
}

export async function renderProjectVideo(projectId) {
  const supabase = requireSupabase();

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('project_id,title,status,scenes(*),assets(*)')
    .eq('project_id', projectId)
    .single();

  if (projectError) throw projectError;

  const rawScenes = (project.scenes ?? [])
    .slice()
    .sort((a, b) => a.scene_number - b.scene_number);

  if (!rawScenes.length) {
    const error = new Error('Project has no scenes');
    error.code = 'project_has_no_scenes';
    throw error;
  }

  const missingImages = rawScenes.filter(
    (scene) => scene.status !== 'IMAGE_READY' || !scene.image_url,
  );
  if (missingImages.length) {
    const error = new Error('Not all scene images are ready');
    error.code = 'images_not_ready';
    error.pending_scene_ids = missingImages.map((scene) => scene.id);
    throw error;
  }

  const voiceAsset = (project.assets ?? []).find(
    (asset) => asset.type === 'voice_final' && asset.url,
  );
  const musicAsset = (project.assets ?? []).find(
    (asset) => asset.type === 'music_final' && asset.url,
  );
  if (!voiceAsset) {
    const error = new Error('Voice asset is not ready');
    error.code = 'voice_not_ready';
    throw error;
  }

  await supabase
    .from('projects')
    .update({ status: 'RENDERING', error_message: null, video_qa: null })
    .eq('project_id', projectId);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codigomystery-'));

  try {
    const imagePaths = [];
    for (const scene of rawScenes) {
      const localPath = path.join(
        workDir,
        `scene-${String(scene.scene_number).padStart(2, '0')}${extensionFromPath(scene.image_url, '.webp')}`,
      );
      await storageDownloadToFile(supabase, scene.image_url, localPath);
      imagePaths.push(localPath);
    }

    const voicePath = path.join(
      workDir,
      `voice${extensionFromPath(voiceAsset.url, '.mp3')}`,
    );
    await storageDownloadToFile(supabase, voiceAsset.url, voicePath);

    let musicPath = null;
    if (musicAsset?.url) {
      musicPath = path.join(
        workDir,
        `music${extensionFromPath(musicAsset.url, '.mp3')}`,
      );
      await storageDownloadToFile(supabase, musicAsset.url, musicPath);
    }

    const voiceProbe = await probeMedia(voicePath);
    const voiceDuration = Number(
      voiceProbe.format?.duration ||
      voiceProbe.streams?.find((stream) => stream.codec_type === 'audio')?.duration ||
      0,
    );
    if (!voiceDuration) {
      const error = new Error('Could not determine voice duration');
      error.code = 'voice_duration_unknown';
      throw error;
    }

    const scenes = buildVoiceSyncedTimeline(rawScenes, voiceDuration);
    const { storagePath: subtitleStoragePath, srt, totalDuration } =
      await persistVoiceSyncedTimeline(supabase, projectId, scenes);

    const subtitlesPath = path.join(workDir, 'subtitles.srt');
    await fs.writeFile(subtitlesPath, srt, 'utf8');

    const outputPath = path.join(workDir, 'final.mp4');
    let subtitlesBurned = true;

    try {
      await runFfmpeg(buildFfmpegArgs({
        scenes,
        imagePaths,
        voicePath,
        musicPath,
        subtitlesPath,
        outputPath,
        burnSubtitles: true,
      }));
    } catch (error) {
      console.warn('[render-worker] subtitle burn-in failed; retrying without burned subtitles');
      subtitlesBurned = false;
      await runFfmpeg(buildFfmpegArgs({
        scenes,
        imagePaths,
        voicePath,
        musicPath,
        subtitlesPath: null,
        outputPath,
        burnSubtitles: false,
      }));
    }

    const videoQa = await qualityCheckVideo(outputPath, {
      expectedDuration: voiceDuration,
    });

    const videoBuffer = await fs.readFile(outputPath);
    const storagePath = `${projectId}/final/final.mp4`;

    const { error: uploadError } = await supabase.storage
      .from('projects')
      .upload(storagePath, videoBuffer, {
        contentType: 'video/mp4',
        upsert: true,
        cacheControl: '3600',
      });
    if (uploadError) throw uploadError;

    await supabase
      .from('assets')
      .delete()
      .eq('project_id', projectId)
      .eq('type', 'final_video');

    const { error: assetError } = await supabase
      .from('assets')
      .insert({
        project_id: projectId,
        type: 'final_video',
        provider: 'ffmpeg',
        url: storagePath,
        metadata: {
          mime_type: 'video/mp4',
          bytes: videoBuffer.length,
          width: 1080,
          height: 1920,
          subtitles_url: subtitleStoragePath,
          subtitles_burned: subtitlesBurned,
          voice_duration: voiceDuration,
          planned_duration: totalDuration,
          motion: 'subtle_ken_burns',
          music_mixed: Boolean(musicPath),
          music_volume: musicPath ? 0.12 : null,
          qa_passed: videoQa.passed,
        },
      });
    if (assetError) throw assetError;

    const status = videoQa.passed ? 'READY_FOR_REVIEW' : 'VIDEO_QA_FAILED';
    const { error: updateError } = await supabase
      .from('projects')
      .update({
        status,
        final_video_url: storagePath,
        preview_url: storagePath,
        video_qa: videoQa,
        error_message: videoQa.passed
          ? null
          : `VIDEO_QA_FAILED: ${videoQa.failed.join(', ')}`,
      })
      .eq('project_id', projectId);
    if (updateError) throw updateError;

    return {
      ok: videoQa.passed,
      project_id: projectId,
      status,
      final_video_url: storagePath,
      bytes: videoBuffer.length,
      video_qa: videoQa,
    };
  } catch (error) {
    await supabase
      .from('projects')
      .update({ status: 'ERROR', error_message: error.message })
      .eq('project_id', projectId)
      .catch(() => {});
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
