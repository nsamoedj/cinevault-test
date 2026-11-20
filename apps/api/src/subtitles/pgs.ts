// PGS (Blu-ray "HDMV Presentation Graphic Stream", a .sup file): subtitles as
// pictures. This reads them into one grey picture per subtitle, with its
// times, for text recognition (ocr.ts).
//
// A .sup is a list of segments ("PG", PTS, DTS, type, size): a presentation
// composition (PCS) says which objects show where, a palette (PDS) gives their
// colours (Y, Cr, Cb, alpha), an object (ODS) is a run-length coded bitmap,
// and END closes a display set. A display set without objects clears the screen.

export interface PgsPicture {
  /** Seconds in the file. */
  start: number;
  end: number;
  width: number;
  height: number;
  /** Grey, one byte per pixel: dark text on white, ready to read. */
  data: Uint8Array;
}

const PDS = 0x14;
const ODS = 0x15;
const PCS = 0x16;
const END = 0x80;
/** A subtitle still on screen at the end of the stream: this long. */
const LAST_SECONDS = 4;
/** White around the text, which text recognition likes. */
const PADDING = 12;

interface PgsObject {
  width: number;
  height: number;
  /** Run-length coded lines, collected over the object's segments. */
  rle: Uint8Array[];
}

interface Composition {
  pts: number;
  paletteId: number;
  objects: { id: number; x: number; y: number }[];
}

/** One coded bitmap as palette indexes. */
export function decodeRle(rle: Uint8Array, width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height);
  let x = 0;
  let y = 0;
  let i = 0;
  const put = (count: number, colour: number) => {
    const n = Math.min(count, width - x);
    if (y < height && n > 0) pixels.fill(colour, y * width + x, y * width + x + n);
    x += count;
  };
  while (i < rle.length && y < height) {
    const byte = rle[i++] ?? 0;
    if (byte !== 0) {
      put(1, byte);
      continue;
    }
    const flag = rle[i++] ?? 0;
    if (flag === 0) {
      // End of a line.
      x = 0;
      y++;
      continue;
    }
    const long = (flag & 0x40) !== 0;
    const coloured = (flag & 0x80) !== 0;
    let count = flag & 0x3f;
    if (long) count = (count << 8) | (rle[i++] ?? 0);
    put(count, coloured ? (rle[i++] ?? 0) : 0);
  }
  return pixels;
}

/** Every subtitle picture of a .sup, in order of time. */
export function readPgs(sup: Uint8Array): PgsPicture[] {
  const view = new DataView(sup.buffer, sup.byteOffset, sup.byteLength);
  const palettes = new Map<number, Uint8Array>();
  const objects = new Map<number, PgsObject>();
  const shown: { pts: number; picture?: Omit<PgsPicture, 'start' | 'end'> }[] = [];
  let composition: Composition | undefined;

  let offset = 0;
  while (offset + 13 <= sup.length) {
    if (sup[offset] !== 0x50 || sup[offset + 1] !== 0x47) {
      // Not "PG": out of step; look for the next segment.
      offset++;
      continue;
    }
    const pts = view.getUint32(offset + 2) / 90_000;
    const type = sup[offset + 10];
    const size = view.getUint16(offset + 11);
    const start = offset + 13;
    const end = Math.min(sup.length, start + size);
    const data = sup.subarray(start, end);
    offset = end;

    if (type === PCS && data.length >= 11) {
      const state = data[7] ?? 0;
      // An epoch start: palettes and objects from before are gone.
      if (state & 0x80) {
        palettes.clear();
        objects.clear();
      }
      const count = data[10] ?? 0;
      const placed: Composition['objects'] = [];
      let at = 11;
      for (let n = 0; n < count && at + 8 <= data.length; n++) {
        const id = (data[at] ?? 0) * 256 + (data[at + 1] ?? 0);
        const cropped = ((data[at + 3] ?? 0) & 0x40) !== 0;
        const x = (data[at + 4] ?? 0) * 256 + (data[at + 5] ?? 0);
        const y = (data[at + 6] ?? 0) * 256 + (data[at + 7] ?? 0);
        placed.push({ id, x, y });
        at += cropped ? 16 : 8;
      }
      composition = { pts, paletteId: data[9] ?? 0, objects: placed };
    } else if (type === PDS && data.length >= 2) {
      const id = data[0] ?? 0;
      // Y and alpha per index: all that a grey picture needs.
      const palette = palettes.get(id) ?? new Uint8Array(512);
      for (let at = 2; at + 5 <= data.length; at += 5) {
        const index = data[at] ?? 0;
        palette[index * 2] = data[at + 1] ?? 0;
        palette[index * 2 + 1] = data[at + 4] ?? 0;
      }
      palettes.set(id, palette);
    } else if (type === ODS && data.length >= 4) {
      const id = (data[0] ?? 0) * 256 + (data[1] ?? 0);
      const sequence = data[3] ?? 0;
      if (sequence & 0x80 && data.length >= 11) {
        const width = (data[7] ?? 0) * 256 + (data[8] ?? 0);
        const height = (data[9] ?? 0) * 256 + (data[10] ?? 0);
        objects.set(id, { width, height, rle: [data.subarray(11)] });
      } else {
        objects.get(id)?.rle.push(data.subarray(4));
      }
    } else if (type === END && composition) {
      const picture = compose(composition, palettes, objects);
      shown.push({ pts: composition.pts, ...(picture && { picture }) });
      composition = undefined;
    }
  }

  // A picture lasts until the next display set (another picture, or a clear).
  const pictures: PgsPicture[] = [];
  for (let n = 0; n < shown.length; n++) {
    const current = shown[n];
    if (!current?.picture) continue;
    const end = shown[n + 1]?.pts ?? current.pts + LAST_SECONDS;
    if (end <= current.pts) continue;
    pictures.push({ start: current.pts, end, ...current.picture });
  }
  return pictures;
}

/** The objects of a composition on one grey picture: as big as they need, with a margin. */
function compose(
  composition: Composition,
  palettes: Map<number, Uint8Array>,
  objects: Map<number, PgsObject>,
): Omit<PgsPicture, 'start' | 'end'> | undefined {
  const palette = palettes.get(composition.paletteId);
  const placed = composition.objects.flatMap((p) => {
    const object = objects.get(p.id);
    return object && object.width > 0 && object.height > 0 ? [{ ...p, object }] : [];
  });
  if (!palette || placed.length === 0) return undefined;
  const left = Math.min(...placed.map((p) => p.x));
  const top = Math.min(...placed.map((p) => p.y));
  const right = Math.max(...placed.map((p) => p.x + p.object.width));
  const bottom = Math.max(...placed.map((p) => p.y + p.object.height));
  const width = right - left + PADDING * 2;
  const height = bottom - top + PADDING * 2;
  if (width * height > 4096 * 2160) return undefined;
  const data = new Uint8Array(width * height).fill(255);
  for (const { x, y, object } of placed) {
    const rle = concat(object.rle);
    const indexes = decodeRle(rle, object.width, object.height);
    for (let row = 0; row < object.height; row++) {
      const target = (y - top + PADDING + row) * width + (x - left + PADDING);
      for (let column = 0; column < object.width; column++) {
        const index = indexes[row * object.width + column] ?? 0;
        const luma = palette[index * 2] ?? 0;
        const alpha = palette[index * 2 + 1] ?? 0;
        // The bright fill of the letters becomes dark; their dark outline and
        // the transparent rest stay white.
        const ink = (Math.max(0, luma - 16) * alpha) / (219 * 255);
        data[target + column] = Math.round(255 - Math.min(1, ink) * 255);
      }
    }
  }
  return { width, height, data };
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] ?? new Uint8Array();
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}
