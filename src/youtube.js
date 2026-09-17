import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';

const outputRoot = process.env.CODIGOMYSTERY_OUTPUT_ROOT || '/data/codigomystery/output';
const clientId = process.env.YOUTUBE_CLIENT_ID || '';
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || '';
const redirectUri = process.env.YOUTUBE_REDIRECT_URI || 'http://localhost';
const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN || '';
const defaultPrivacyStatus = process.env.YOUTUBE_PRIVACY_STATUS || 'private';
const defaultCategoryId = process.env.YOUTUBE_CATEGORY_ID || '24';

function assertYouTubeConfigured() {
  const missing = [];
  if (!clientId) missing.push('YOUTUBE_CLIENT_ID');
  if (!clientSecret) missing.push('YOUTUBE_CLIENT_SECRET');
  if (!refreshToken) missing.push('YOUTUBE_REFRESH_TOKEN');

  if (missing.length) {
    const error = new Error(`Missing YouTube configuration: ${missing.join(', ')}`);
    error.code = 'youtube_not_configured';
    error.missing = missing;
    throw error;
  }
}

function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !/^CM-[A-Za-z0-9-]+$/.test(projectId)) {
    const error = new Error('Invalid project_id');
    error.code = 'invalid_project_id';
    throw error;
  }
}

function normalizePrivacyStatus(value) {
  const allowed = new Set(['private', 'unlisted', 'public']);
  return allowed.has(value) ? value : defaultPrivacyStatus;
}

function resolveVideoPath(projectId, suppliedVideoPath) {
  assertProjectId(projectId);

  const expectedProjectDir = path.resolve(outputRoot, projectId);
  const candidate = suppliedVideoPath
    ? path.resolve(suppliedVideoPath)
    : path.resolve(expectedProjectDir, 'final.mp4');

  const insideProjectDir =
    candidate === expectedProjectDir || candidate.startsWith(`${expectedProjectDir}${path.sep}`);

  if (!insideProjectDir) {
    const error = new Error('video_path must be inside the project output directory');
    error.code = 'invalid_video_path';
    throw error;
  }

  return candidate;
}

function getYouTubeClient() {
  assertYouTubeConfigured();

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return google.youtube({
    version: 'v3',
    auth: oauth2Client,
  });
}

export async function publishToYouTube({
  projectId,
  title,
  description = '',
  tags = [],
  videoPath,
  privacyStatus,
}) {
  if (typeof title !== 'string' || !title.trim()) {
    const error = new Error('title is required');
    error.code = 'invalid_title';
    throw error;
  }

  const resolvedVideoPath = resolveVideoPath(projectId, videoPath);

  try {
    await fs.promises.access(resolvedVideoPath, fs.constants.R_OK);
  } catch {
    const error = new Error(`Video file not found or unreadable: ${resolvedVideoPath}`);
    error.code = 'video_not_found';
    throw error;
  }

  const stats = await fs.promises.stat(resolvedVideoPath);
  if (!stats.isFile()) {
    const error = new Error(`Video path is not a file: ${resolvedVideoPath}`);
    error.code = 'video_not_file';
    throw error;
  }

  const youtube = getYouTubeClient();
  const safeTags = Array.isArray(tags)
    ? tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
    : [];

  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: title.trim().slice(0, 100),
        description: String(description || '').slice(0, 5000),
        tags: safeTags,
        categoryId: defaultCategoryId,
      },
      status: {
        privacyStatus: normalizePrivacyStatus(privacyStatus),
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: fs.createReadStream(resolvedVideoPath),
    },
  });

  const videoId = response.data.id;
  if (!videoId) {
    const error = new Error('YouTube upload completed without video id');
    error.code = 'youtube_missing_video_id';
    throw error;
  }

  return {
    video_id: videoId,
    youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
    privacy_status: response.data.status?.privacyStatus ?? normalizePrivacyStatus(privacyStatus),
    video_path: resolvedVideoPath,
  };
}
