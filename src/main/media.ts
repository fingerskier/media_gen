import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertDirectory } from "./storage";
import {
  mkdir,
  writeFile,
  rename,
  lstat,
  copyFile,
  unlink,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import type { Mode, Downloaded } from "../shared/types";
import {
  requestBytes,
  NetworkFailure,
  parseRetryAfter,
  type Exchange,
} from "./network";

export function assetPath(root: string, filename: string) {
  if (!/^[a-f0-9]{64}\.(png|jpg|webp|mp4|webm)$/.test(filename))
    throw Error("Invalid asset filename");
  return join(root, "assets", filename);
}
function identify(bytes: Buffer): {
  mime: string;
  extension: string;
  mode: Mode;
} {
  if (bytes.length < 24) throw Error("Media is empty or truncated");
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { mime: "image/png", extension: "png", mode: "image" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return { mime: "image/jpeg", extension: "jpg", mode: "image" };
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return { mime: "image/webp", extension: "webp", mode: "image" };
  if (bytes.toString("ascii", 4, 8) === "ftyp")
    return { mime: "video/mp4", extension: "mp4", mode: "video" };
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
    return { mime: "video/webm", extension: "webm", mode: "video" };
  throw Error("Unsupported media file");
}
const execute = promisify(execFile);
async function probe(file: string, mode: Mode) {
  try {
    const { stdout, stderr } = await execute(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-threads",
        "1",
        "-count_frames",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,nb_read_frames,duration:format=duration",
        "-of",
        "json",
        file,
      ],
      {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (stderr.trim()) throw Error("Media decode error");
    const result = JSON.parse(stdout);
    const stream = result.streams?.find(
      (value: { codec_type?: string }) => value.codec_type === "video",
    );
    if (
      !stream ||
      !Number.isInteger(stream.width) ||
      !Number.isInteger(stream.height) ||
      stream.width <= 0 ||
      stream.height <= 0 ||
      !(Number(stream.nb_read_frames) > 0)
    )
      throw Error("No decodable media frames");
    const duration = Number(stream.duration ?? result.format?.duration);
    if (mode === "video" && (!Number.isFinite(duration) || duration <= 0))
      throw Error("Invalid video duration");
    return {
      width: stream.width as number,
      height: stream.height as number,
      ...(mode === "video" ? { duration } : {}),
    };
  } catch {
    throw Error("Media structural validation failed");
  }
}
export function createDownloader(
  root: string,
  exchange: Exchange = requestBytes,
) {
  return async (url: string, mode: Mode): Promise<Downloaded> => {
    let response;
    const maxBytes = (mode === "image" ? 64 : 256) * 1024 * 1024;
    for (let redirects = 0; redirects <= 4; redirects++) {
      response = await exchange(url, { maxBytes, timeoutMs: 120000 });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.headers.location) throw Error("Invalid media redirect");
        url = new URL(response.headers.location, url).href;
        continue;
      }
      break;
    }
    if (!response || response.status !== 200)
      throw new NetworkFailure(
        "Output download unavailable",
        parseRetryAfter(response?.headers["retry-after"]),
      );
    if (
      response.bytes.length > maxBytes ||
      Number(response.headers["content-length"]) > maxBytes
    )
      throw Error("Output exceeds size limit");
    const detected = identify(response.bytes);
    if (detected.mode !== mode)
      throw Error("Provider returned wrong media type");
    const declared = response.headers["content-type"]?.split(";")[0];
    if (
      declared &&
      declared !== "application/octet-stream" &&
      declared !== detected.mime
    )
      throw Error("Output content type mismatch");
    const sha256 = createHash("sha256").update(response.bytes).digest("hex");
    const filename = sha256 + "." + detected.extension;
    assertDirectory(root);
    await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
    assertDirectory(join(root, "assets"));
    const file = assetPath(root, filename),
      temp = file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temp, response.bytes, { mode: 0o600, flag: "wx" });
      const metadata = await probe(temp, mode);
      assertDirectory(join(root, "assets"));
      const existing = await lstat(file).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (existing && !existing.isFile()) throw Error("Unsafe media file");
      await rename(temp, file);
      return {
        id: randomUUID(),
        filename,
        mime: detected.mime,
        bytes: response.bytes.length,
        sha256,
        ...metadata,
      };
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  };
}
export async function exportFile(source: string, destination: string) {
  assertDirectory(join(source, ".."));
  if (!(await lstat(source)).isFile()) throw Error("Unsafe media file");
  await copyFile(source, destination);
}
export async function serveFile(
  file: string,
  mime: string,
  request: Request,
): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405 });
  let size: number;
  try {
    assertDirectory(join(file, ".."));
    const info = await lstat(file);
    if (!info.isFile()) throw Error("Unsafe media file");
    size = info.size;
  } catch {
    return new Response(null, { status: 404 });
  }
  let start = 0,
    end = size - 1,
    status = 200;
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end =
      match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= size
    )
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    status = 206;
  }
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
  if (status === 206)
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  const stream =
    request.method === "HEAD"
      ? null
      : Readable.toWeb(createReadStream(file, { start, end }));
  return new Response(stream as ReadableStream<Uint8Array> | null, {
    status,
    headers,
  });
}
