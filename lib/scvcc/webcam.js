/**
 * SCVCC Tennis Court Webcam Snapshot & Video Clip Utilities (IPCamLive / HLS)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const courtsConfig = require('../courtsConfig');
const { resolveCourtConfigName } = require('./config');

// Default SCVCC Tennis Court Webcam URLs (IPCamLive)
const DEFAULT_SCVCC_WEBCAM_PLAYER_URL = 'https://g1.ipcamlive.com/player/player.php?alias=5ca7b2391ca5e&autoplay=1';
const DEFAULT_SCVCC_WEBCAM_SNAPSHOT_URL = 'https://g1.ipcamlive.com/player/snapshot.php?alias=5ca7b2391ca5e';
const DEFAULT_SCVCC_WEBCAM_HLS_URL = 'http://s109.ipcamlive.com/streams/6dd25m4ylhnxtnxg9/stream.m3u8';

const hlsUrlCache = new Map();

/**
 * Dynamically resolves the active HLS stream URL from an IPCamLive player page.
 */
async function resolveIpcamliveStreamUrl(playerUrl) {
  if (!playerUrl) return null;
  try {
    const res = await fetch(playerUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Referer': 'https://g1.ipcamlive.com/'
      }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const addressMatch = html.match(/var\s+address\s*=\s*['"]([^'"]+)['"]/i);
    const streamIdMatch = html.match(/var\s+streamid\s*=\s*['"]([^'"]+)['"]/i);
    if (addressMatch && streamIdMatch) {
      const address = addressMatch[1].replace(/\/+$/, '');
      const streamId = streamIdMatch[1];
      return `${address}/streams/${streamId}/stream.m3u8`;
    }
  } catch (err) {
    console.warn('[webcam] Failed to dynamically resolve IPCamLive stream URL:', err.message);
  }
  return null;
}

/**
 * Resolves the active HLS stream URL for a court configuration.
 * For IPCamLive feeds, parses the current dynamic stream ID directly from player.php.
 */
async function resolveCourtHlsUrl(config, forceRefresh = false) {
  const cacheKey = config?.playerUrl || config?.hlsUrl || 'default';
  const now = Date.now();

  if (!forceRefresh) {
    const cached = hlsUrlCache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return cached.url;
    }
  }

  // If a custom hlsUrl is set and is not the default SCVCC fallback, use it directly
  if (config?.hlsUrl && config.hlsUrl !== DEFAULT_SCVCC_WEBCAM_HLS_URL && !config?.playerUrl?.includes('ipcamlive.com')) {
    return config.hlsUrl;
  }

  // Try dynamic resolution from player.php
  if (config?.playerUrl && config.playerUrl.includes('ipcamlive.com')) {
    const dynamicUrl = await resolveIpcamliveStreamUrl(config.playerUrl);
    if (dynamicUrl) {
      hlsUrlCache.set(cacheKey, { url: dynamicUrl, expiresAt: now + 5 * 60 * 1000 });
      return dynamicUrl;
    }
  }

  return config?.hlsUrl || DEFAULT_SCVCC_WEBCAM_HLS_URL;
}

function getCourtWebcamConfig(venueOrChatId = null) {
  const configName = resolveCourtConfigName(venueOrChatId);
  const courtConfig = courtsConfig.getCourtConfig(configName || 'SCVCC', 'scvcc');
  const sysConfig = courtsConfig.getSystemConfig('scvcc');

  const playerUrl = courtConfig?.webcam?.playerUrl || sysConfig?.webcam?.playerUrl || DEFAULT_SCVCC_WEBCAM_PLAYER_URL;
  const snapshotUrl = courtConfig?.webcam?.snapshotUrl || sysConfig?.webcam?.snapshotUrl || DEFAULT_SCVCC_WEBCAM_SNAPSHOT_URL;
  const hlsUrl = courtConfig?.webcam?.hlsUrl || sysConfig?.webcam?.hlsUrl || DEFAULT_SCVCC_WEBCAM_HLS_URL;

  return { playerUrl, snapshotUrl, hlsUrl };
}

async function getCourtWebcamSnapshot(venueOrChatId = null) {
  const config = getCourtWebcamConfig(venueOrChatId);
  try {
    const res = await fetch(config.snapshotUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Referer': 'https://g1.ipcamlive.com/'
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const arrayBuf = await res.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuf);
    return {
      success: true,
      imageBuffer,
      ...config
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      ...config
    };
  }
}

/**
 * Captures a short video clip (default 10s) from the court HLS stream using ffmpeg.
 */
async function getCourtWebcamClip(durationSeconds = 10, venueOrChatId = null) {
  let ffmpegPath = null;
  try {
    ffmpegPath = require('ffmpeg-static');
  } catch (e) {
    try {
      const { execSync } = require('child_process');
      const which = execSync('which ffmpeg').toString().trim();
      if (which) ffmpegPath = which;
    } catch (err) {}
  }

  if (!ffmpegPath) {
    return {
      success: false,
      error: 'ffmpeg binary is not available to capture video clip.'
    };
  }

  const config = getCourtWebcamConfig(venueOrChatId);
  const streamUrl = await resolveCourtHlsUrl(config, false);

  const captureFromUrl = (targetUrl) => {
    const tempFile = path.join(os.tmpdir(), `courtcam_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    const cleanupTempFile = () => {
      if (fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch (e) {}
      }
    };
    return new Promise((resolve) => {
      const proc = spawn(ffmpegPath, [
        '-y',
        '-i', targetUrl,
        '-t', String(durationSeconds),
        '-c:v', 'copy',
        '-an',
        '-movflags', '+faststart',
        tempFile
      ], {
        stdio: ['ignore', 'ignore', 'pipe']
      });

      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      const timeout = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (e) {}
        cleanupTempFile();
        resolve({
          success: false,
          error: 'Video clip capture timed out.'
        });
      }, (durationSeconds + 12) * 1000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0 && fs.existsSync(tempFile)) {
          try {
            const videoBuffer = fs.readFileSync(tempFile);
            cleanupTempFile();
            resolve({
              success: true,
              videoBuffer,
              duration: durationSeconds,
              ...config,
              hlsUrl: targetUrl
            });
          } catch (readErr) {
            resolve({
              success: false,
              error: `Failed to read video file: ${readErr.message}`,
              ...config
            });
          }
        } else {
          cleanupTempFile();
          resolve({
            success: false,
            error: `ffmpeg process exited with code ${code}: ${stderr.slice(-200)}`,
            ...config
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        cleanupTempFile();
        resolve({
          success: false,
          error: `Failed to launch ffmpeg: ${err.message}`,
          ...config
        });
      });
    });
  };

  let result = await captureFromUrl(streamUrl);

  // If capture failed and this is an IPCamLive stream, refresh dynamic stream ID and retry once
  if (!result.success && config.playerUrl && config.playerUrl.includes('ipcamlive.com')) {
    const freshStreamUrl = await resolveCourtHlsUrl(config, true);
    if (freshStreamUrl && freshStreamUrl !== streamUrl) {
      console.log(`[webcam] Retrying video clip with refreshed dynamic stream URL: ${freshStreamUrl}`);
      result = await captureFromUrl(freshStreamUrl);
    }
  }

  return result;
}

module.exports = {
  getCourtWebcamConfig,
  getCourtWebcamSnapshot,
  getCourtWebcamClip,
  resolveIpcamliveStreamUrl,
  resolveCourtHlsUrl
};
