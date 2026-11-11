/**
 * Session recording: JPEG screencast frames -> ffmpeg -> HLS (index.m3u8 +
 * .ts segments with relative, same-origin URLs) in the recording directory,
 * which the controller serves after the session ends.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";

export class Recorder {
  static readonly FPS = 5;
  private ffmpeg: ChildProcessByStdio<Writable, null, Readable> | null = null;
  private closed = false;

  constructor(
    private dir: string,
    private size: { width: number; height: number },
  ) {}

  async start(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    this.ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel", "error",
        "-f", "image2pipe",
        "-framerate", String(Recorder.FPS),
        "-c:v", "mjpeg",
        "-i", "-",
        "-vf", `scale=${this.size.width}:${this.size.height}:force_original_aspect_ratio=decrease,pad=${this.size.width}:${this.size.height}:(ow-iw)/2:(oh-ih)/2`,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "stillimage",
        "-pix_fmt", "yuv420p",
        "-g", String(Recorder.FPS * 4),
        "-f", "hls",
        "-hls_time", "4",
        "-hls_list_size", "0",
        "-hls_playlist_type", "event",
        "-hls_segment_filename", path.join(this.dir, "segment-%05d.ts"),
        path.join(this.dir, "index.m3u8"),
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    this.ffmpeg.stderr.on("data", (d: Buffer) => console.error("ffmpeg:", d.toString().trim()));
    this.ffmpeg.stdin.on("error", () => {});
  }

  write(frame: Buffer): void {
    if (this.closed || !this.ffmpeg) return;
    if (this.ffmpeg.stdin.writableLength > 8 * 1024 * 1024) return; // back-pressure: drop
    this.ffmpeg.stdin.write(frame);
  }

  async finish(): Promise<void> {
    if (this.closed || !this.ffmpeg) return;
    this.closed = true;
    const proc = this.ffmpeg;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 15000);
      proc.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.stdin.end();
    });
    // An event playlist that finished cleanly ends with #EXT-X-ENDLIST.
    const playlist = path.join(this.dir, "index.m3u8");
    if (fs.existsSync(playlist)) {
      const text = fs.readFileSync(playlist, "utf8");
      if (!text.includes("#EXT-X-ENDLIST")) fs.appendFileSync(playlist, "#EXT-X-ENDLIST\n");
    }
  }
}
