import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { requireSupabase } from '../supabase.js';

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
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
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

function buildFfmpegArgs({ scenes, imagePaths, voicePath, subtitlesPath, outputPath, burnSubtitles }) {
  const args = ['-y'];

  scenes.forEach((scene, index) => {
    const duration = Math.max(0.5, Number(scene.duration || 1));
    args.push('-loop', '1', '-t', String(duration), '-i', imagePaths[index]);
  });

  const audioInputIndex = scenes.length;
  args.push('-i', voicePath);

  const filters = scenes.map((_, index) =>
    `[${index}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${index}]`,
  );

  const concatInputs = scenes.map((_, index) => `[v${index}]`).join('');
  filters.push(`${concatInputs}concat=n=${scenes.length}:v=1:a=0[vcat]`);

  let videoLabel = '[vcat]';
  if (burnSubtitles && subtitlesPath) {
    const escaped = subtitlesPath.replaceAll('\\', '/').replaceAll("'", "\\'");
    filters.push(
      `[vcat]subtitles='${escaped}':force_style='FontSize=18,Alignment=2,MarginV=120,Outline=2,Shadow=0,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010'[vout]`,
    );
    videoLabel = '[vout]';
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', videoLabel,
    '-map', `${audioInputIndex}:a:0`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
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
    .select('project_id,title,status,subtitles_url,scenes(*),assets(*)')
    .eq('project_id', projectId)
    .single();

  if (projectError) throw projectError;

  const scenes = (project.scenes ?? [])
    .slice()
    .sort((a, b) => a.scene_number - b.scene_number);

  if (!scenes.length) {
    const error = new Error('Project has no scenes');
    error.code = 'project_has_no_scenes';
    throw error;
  }

  const missingImages = scenes.filter((scene) => scene.status !== 'IMAGE_READY' || !scene.image_url);
  if (missingImages.length) {
    const error = new Error('Not all scene images are ready');
    error.code = 'images_not_ready';
    error.pending_scene_ids = missingImages.map((scene) => scene.id);
    throw error;
  }

  const voiceAsset = (project.assets ?? []).find(
    (asset) => asset.type === 'voice_final' && asset.url,
  );
  if (!voiceAsset) {
    const error = new Error('Voice asset is not ready');
    error.code = 'voice_not_ready';
    throw error;
  }

  await supabase
    .from('projects')
    .update({ status: 'RENDERING', error_message: null })
    .eq('project_id', projectId);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codigomystery-'));

  try {
    const imagePaths = [];
    for (const scene of scenes) {
      const localPath = path.join(
        workDir,
        `scene-${String(scene.scene_number).padStart(2, '0')}${extensionFromPath(scene.image_url, '.webp')}`,
      );
      await storageDownloadToFile(supabase, scene.image_url, localPath);
      imagePaths.push(localPath);
    }

    const voicePath = path.join(workDir, `voice${extensionFromPath(voiceAsset.url, '.mp3')}`);
    await storageDownloadToFile(supabase, voiceAsset.url, voicePath);

    let subtitlesPath = null;
    if (project.subtitles_url) {
      subtitlesPath = path.join(workDir, 'subtitles.srt');
      try {
        await storageDownloadToFile(supabase, project.subtitles_url, subtitlesPath);
      } catch {
        subtitlesPath = null;
      }
    }

    const outputPath = path.join(workDir, 'final.mp4');

    try {
      await runFfmpeg(buildFfmpegArgs({
        scenes,
        imagePaths,
        voicePath,
        subtitlesPath,
        outputPath,
        burnSubtitles: Boolean(subtitlesPath),
      }));
    } catch (error) {
      if (!subtitlesPath) throw error;
      console.warn('[render-worker] subtitle burn-in failed; retrying without burned subtitles');
      await runFfmpeg(buildFfmpegArgs({
        scenes,
        imagePaths,
        voicePath,
        subtitlesPath: null,
        outputPath,
        burnSubtitles: false,
      }));
    }

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
          subtitles_burn_attempted: Boolean(subtitlesPath),
        },
      });
    if (assetError) throw assetError;

    const { error: updateError } = await supabase
      .from('projects')
      .update({
        status: 'READY_FOR_REVIEW',
        final_video_url: storagePath,
        preview_url: storagePath,
        error_message: null,
      })
      .eq('project_id', projectId);
    if (updateError) throw updateError;

    return {
      ok: true,
      project_id: projectId,
      status: 'READY_FOR_REVIEW',
      final_video_url: storagePath,
      bytes: videoBuffer.length,
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
