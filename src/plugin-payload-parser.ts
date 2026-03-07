import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseBuffer } from 'bplist-parser';

export interface PluginPayloadParseResult {
  url?: string;
  title?: string;
  description?: string;
  siteName?: string;
  creator?: string;
  thumbnailPath?: string;
  rawData?: string;
}

function collectStringsAndBuffers(value: any, strings: string[], buffers: Buffer[], seen = new Set<any>()): void {
  if (value == null) return;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) strings.push(trimmed);
    return;
  }

  if (Buffer.isBuffer(value)) {
    buffers.push(value);
    return;
  }

  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectStringsAndBuffers(item, strings, buffers, seen);
    return;
  }

  for (const [k, v] of Object.entries(value)) {
    if (typeof k === 'string' && k.trim()) strings.push(k.trim());
    collectStringsAndBuffers(v, strings, buffers, seen);
  }
}

function firstUrl(strings: string[]): string | undefined {
  const urlRegex = /^https?:\/\/[^\s]+/i;
  return strings.find((s) => urlRegex.test(s));
}

function extractByKeyHint(parsed: any, keyHints: string[]): string | undefined {
  const entries: Array<[string, any]> = [];

  const walk = (obj: any, seen = new Set<any>()) => {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);

    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, seen);
      return;
    }

    for (const [k, v] of Object.entries(obj)) {
      entries.push([k.toLowerCase(), v]);
      walk(v, seen);
    }
  };

  walk(parsed);

  for (const [k, v] of entries) {
    if (!keyHints.some((hint) => k.includes(hint))) continue;

    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v)) {
      const hit = v.find((x) => typeof x === 'string' && x.trim());
      if (typeof hit === 'string') return hit.trim();
    }
  }

  return undefined;
}

function pickLikelyTitle(strings: string[], url?: string): string | undefined {
  const loweredUrl = url?.toLowerCase();
  const candidates = strings
    .filter((s) => s.length >= 4 && s.length <= 180)
    .filter((s) => !/^https?:\/\//i.test(s))
    .filter((s) => !/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(s))
    .filter((s) => !/^\$/.test(s))
    .filter((s) => !/^(ns\w+|cf\w+|isa|root|objects?)$/i.test(s))
    .filter((s) => !loweredUrl || !loweredUrl.includes(s.toLowerCase()));

  return candidates[0];
}

function pickLikelyDescription(strings: string[], title?: string): string | undefined {
  const candidates = strings
    .filter((s) => s.length >= 25 && s.length <= 500)
    .filter((s) => !/^https?:\/\//i.test(s))
    .filter((s) => s !== title)
    .filter((s) => !/^\$/.test(s));

  return candidates[0];
}

function guessSiteName(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./i, '');
  } catch {
    return undefined;
  }
}

function detectImageBuffer(buffers: Buffer[]): Buffer | undefined {
  for (const buf of buffers) {
    if (buf.length < 256) continue;

    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isPng =
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a;

    if (isJpeg || isPng) return buf;
  }
  return undefined;
}

function imageExtension(buf: Buffer): '.jpg' | '.png' {
  const isPng =
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47;
  return isPng ? '.png' : '.jpg';
}

export async function parsePluginPayloadAttachment(filePath: string): Promise<PluginPayloadParseResult> {
  try {
    const data = fs.readFileSync(filePath);
    if (!data || data.length === 0) {
      return { rawData: 'Empty plugin payload attachment file' };
    }

    const parsed = parseBuffer(data) as any[];
    if (!parsed?.length) {
      return { rawData: 'Unable to parse plugin payload (no plist objects found)' };
    }

    const strings: string[] = [];
    const buffers: Buffer[] = [];

    for (const root of parsed) {
      collectStringsAndBuffers(root, strings, buffers);
      if (root && typeof root === 'object' && Array.isArray((root as any).$objects)) {
        collectStringsAndBuffers((root as any).$objects, strings, buffers);
      }
    }

    const dedupedStrings = [...new Set(strings.map((s) => s.trim()).filter(Boolean))];

    const url = extractByKeyHint(parsed, ['url', 'canonical']) || firstUrl(dedupedStrings);
    const title = extractByKeyHint(parsed, ['title', 'headline']) || pickLikelyTitle(dedupedStrings, url);
    const description =
      extractByKeyHint(parsed, ['description', 'summary', 'snippet', 'abstract']) ||
      pickLikelyDescription(dedupedStrings, title);
    const siteName =
      extractByKeyHint(parsed, ['site', 'publisher', 'domain', 'source']) || guessSiteName(url);
    const creator = extractByKeyHint(parsed, ['creator', 'author', 'byline']);

    let thumbnailPath: string | undefined;
    const imageBuf = detectImageBuffer(buffers);
    if (imageBuf) {
      const ext = imageExtension(imageBuf);
      const outPath = path.join(os.tmpdir(), `plugin-thumb-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
      fs.writeFileSync(outPath, imageBuf);
      thumbnailPath = outPath;
    }

    return {
      url,
      title,
      description,
      siteName,
      creator,
      thumbnailPath,
      rawData: dedupedStrings.join('\n').slice(0, 10000),
    };
  } catch (err: any) {
    return {
      rawData: `Failed to parse plugin payload attachment: ${err?.message || 'unknown error'}`,
    };
  }
}
