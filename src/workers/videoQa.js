import { spawn } from 'node:child_process';
import ffprobeStatic from 'ffprobe-static';
import ffmpegPath from 'ffmpeg-static';

const ffprobePath = ffprobeStatic?.path || ffprobeStatic;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`${command} exited with code ${code}`);
      error.stderr = stderr;
      reject(error);
    });
  });
}

export async function probeMedia(filePath) {
  if (!ffprobePath) {
    const error = new Error('FFprobe binary is unavailable');
    error.code = 'ffprobe_unavailable';
    throw error;
  }

  const { stdout } = await run(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=index,codec_type,codec_name,width,height,duration',
    '-of', 'json',
    filePath,
  ]);

  return JSON.parse(stdout || '{}');
}

async function detectBlackFrames(filePath) {
  if (!ffmpegPath) return [];

  const { stderr } = await run(ffmpegPath, [
    '-hide_banner',
    '-i', filePath,
    '-vf', 'blackdetect=d=1.2:pix_th=0.03:pic_th=0.98',
    '-an',
    '-f', 'null',
    '-',
  ]);

  const matches = [...stderr.matchAll(/black_start:([0-9.]+) black_end:([0-9.]+) black_duration:([0-9.]+)/g)];
  return matches.map((match) => ({
    start: Number(match[1]),
    end: Number(match[2]),
    duration: Number(match[3]),
  }));
}

async function detectSilence(filePath) {
  if (!ffmpegPath) return [];

  const { stderr } = await run(ffmpegPath, [
    '-hide_banner',
    '-i', filePath,
    '-af', 'silencedetect=noise=-45dB:d=1.2',
    '-vn',
    '-f', 'null',
    '-',
  ]);

  const starts = [...stderr.matchAll(/silence_start: ([0-9.]+)/g)].map((match) => Number(match[1]));
  const ends = [...stderr.matchAll(/silence_end: ([0-9.]+) \| silence_duration: ([0-9.]+)/g)]
    .map((match) => ({ end: Number(match[1]), duration: Number(match[2]) }));

  return ends.map((entry, index) => ({
    start: starts[index] ?? Math.max(0, entry.end - entry.duration),
    end: entry.end,
    duration: entry.duration,
  }));
}

export async function qualityCheckVideo(filePath, { expectedDuration = null } = {}) {
  const probe = await probeMedia(filePath);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const duration = Number(probe.format?.duration || video?.duration || audio?.duration || 0);

  const checks = {
    has_video: Boolean(video),
    has_audio: Boolean(audio),
    resolution_1080x1920: Boolean(video && video.width === 1080 && video.height === 1920),
    duration_reasonable: duration >= 15 && duration <= 80,
    duration_matches_plan: expectedDuration == null
      ? true
      : Math.abs(duration - Number(expectedDuration)) <= Math.max(3, Number(expectedDuration) * 0.12),
  };

  let blackSegments = [];
  let silenceSegments = [];
  try {
    blackSegments = await detectBlackFrames(filePath);
  } catch (error) {
    console.warn('[video-qa] black detection failed:', error.message);
  }
  try {
    silenceSegments = await detectSilence(filePath);
  } catch (error) {
    console.warn('[video-qa] silence detection failed:', error.message);
  }

  checks.no_long_black_frames = !blackSegments.some((segment) => segment.duration >= 1.2);

  const warnings = [];
  if (silenceSegments.some((segment) => segment.duration >= 2.0)) {
    warnings.push('Detected one or more audio silences >= 2 seconds.');
  }

  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

  return {
    passed: failed.length === 0,
    checks,
    failed,
    warnings,
    duration,
    expected_duration: expectedDuration,
    video: video
      ? {
          codec: video.codec_name,
          width: video.width,
          height: video.height,
        }
      : null,
    audio: audio ? { codec: audio.codec_name } : null,
    black_segments: blackSegments,
    silence_segments: silenceSegments,
  };
}
