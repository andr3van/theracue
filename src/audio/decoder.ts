import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";

export interface PCMFormat {
  channels: number;
  sampleRate: number;
  bitDepth: number; // 16
}

export interface DecodedStream {
  stream: Readable; // PCM signed 16-bit little-endian interleaved
  format: PCMFormat;
  ffmpegProcess: ChildProcess; // ffmpeg child process for cleanup
}

/**
 * Find the bundled or system ffmpeg executable
 */
function findFfmpeg(): string {
  // Try bundled FFmpeg first
  const platform = os.platform();
  let bundledName = '';
  
  if (platform === 'darwin') {
    bundledName = 'ffmpeg-darwin';
  } else if (platform === 'win32') {
    bundledName = 'ffmpeg-win.exe';
  } else if (platform === 'linux') {
    bundledName = 'ffmpeg-linux';
  }
  
  if (bundledName) {
    // Look for bundled FFmpeg relative to this file
    // In production: com.github.andr3van.theracue.sdPlugin/bin/plugin.js
    // FFmpeg is at: com.github.andr3van.theracue.sdPlugin/bin/ffmpeg/
    const bundledPath = path.join(__dirname, 'ffmpeg', bundledName);
    if (fs.existsSync(bundledPath)) {
      // Ensure execute permissions are set (they can be lost during zip extraction)
      try {
        fs.chmodSync(bundledPath, 0o755);
      } catch (err) {
        // If chmod fails, we'll still try to use it
        console.warn(`Failed to set execute permissions on ${bundledPath}:`, err);
      }
      return bundledPath;
    }
  }
  
  // Fallback to common system installation paths
  const SYSTEM_PATHS = [
    '/opt/homebrew/bin/ffmpeg',  // Apple Silicon Homebrew
    '/usr/local/bin/ffmpeg',      // Intel Homebrew
    'C:\\ffmpeg\\bin\\ffmpeg.exe', // Common Windows location
    'ffmpeg'                       // System PATH
  ];
  
  for (const systemPath of SYSTEM_PATHS) {
    if (systemPath === 'ffmpeg') {
      return systemPath; // Will try from PATH
    }
    if (fs.existsSync(systemPath)) {
      return systemPath;
    }
  }
  
  return 'ffmpeg'; // fallback to PATH
}

/**
 * Decode any common audio file (mp3, wav, flac, m4a, aac, ogg, etc.) into raw PCM 16-bit LE using ffmpeg.
 */
export async function decodeToPCM(filePath: string, opts?: { onStderr?: (line: string) => void }): Promise<DecodedStream> {
  if (!fs.existsSync(filePath)) throw new Error("File not found: " + filePath);
  const candidate = findFfmpeg();

  // We'll ask ffmpeg to output s16le 48k stereo by default; keep original channels if possible.
  // Simpler: force output to 2 channels (stereo) & 48k for consistent scaling.
  const args = [
    "-hide_banner",
    "-nostdin",
    "-i", filePath,
    "-ac", "2",
    "-ar", "48000",
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "pipe:1"
  ];

  const child = spawn(candidate as string, args, { stdio: ["ignore", "pipe", "pipe"] });

  let stderrBuf = "";
  child.stderr.on("data", (d: Buffer) => {
    stderrBuf += d.toString();
    let idx;
    while ((idx = stderrBuf.indexOf("\n")) >= 0) {
      const line = stderrBuf.slice(0, idx).trim();
      stderrBuf = stderrBuf.slice(idx + 1);
      if (line && opts?.onStderr) opts.onStderr(line);
    }
  });

  const stream = child.stdout as Readable;
  const format: PCMFormat = { channels: 2, sampleRate: 48000, bitDepth: 16 };

  stream.on("close", () => child.kill());

  return { stream, format, ffmpegProcess: child };
}
