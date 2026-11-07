/**
 * 最小 PNG 解码 + 像素差（MAD）。
 *
 * 为什么需要它：验收要求「无头渲出来的帧与面板渲出来的帧，同 t 的像素差异
 * MAD < 0.02」。要量这个数就必须能把两张 PNG 解成像素 —— 而不引入任何新依赖。
 * Node 自带 zlib，PNG 的像素数据本来就是 zlib 流，所以这里只做：
 *   解 IHDR → 拼 IDAT → inflate → 逐扫描线反滤波。
 *
 * 支持范围（够用且明确）：位深 8、colorType 2(RGB) / 6(RGBA)、非隔行。
 * 浏览器 canvas.toDataURL('image/png') 的产物一定落在这个范围里。
 * 出了范围就抛 PNG_UNSUPPORTED，绝不猜。
 */

import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 PNG → { width, height, channels, data:Uint8Array(RGBA 8bit) }。
 * 非 RGB/RGBA 的 PNG 直接拒绝，不做调色板/gray 的近似（会悄悄改变像素）。
 */
export function decodePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const error = new Error('不是 PNG（签名不匹配）');
    error.code = 'PNG_INVALID';
    throw error;
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buf.length) {
      const error = new Error('PNG 块越界: ' + type);
      error.code = 'PNG_INVALID';
      throw error;
    }
    if (type === 'IHDR') {
      width = buf.readUInt32BE(start);
      height = buf.readUInt32BE(start + 4);
      bitDepth = buf[start + 8];
      colorType = buf[start + 9];
      interlace = buf[start + 12];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4; // 跳过 CRC
  }
  if (!width || !height) {
    const error = new Error('PNG 缺 IHDR');
    error.code = 'PNG_INVALID';
    throw error;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    const error = new Error(`不支持的 PNG 形态（bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}）`);
    error.code = 'PNG_UNSUPPORTED';
    throw error;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const value = raw[pos + x];
      const left = x >= channels ? line[x - channels] : 0;
      const up = prev[x];
      const upLeft = x >= channels ? prev[x - channels] : 0;
      let out;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + left;
          break;
        case 2:
          out = value + up;
          break;
        case 3:
          out = value + ((left + up) >> 1);
          break;
        case 4:
          out = value + paeth(left, up, upLeft);
          break;
        default: {
          const error = new Error('未知 PNG 滤波类型: ' + filter);
          error.code = 'PNG_INVALID';
          throw error;
        }
      }
      line[x] = out & 0xff;
    }
    pos += stride;
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      pixels[dst] = line[src];
      pixels[dst + 1] = line[src + 1];
      pixels[dst + 2] = line[src + 2];
      pixels[dst + 3] = channels === 4 ? line[src + 3] : 255;
    }
    prev = line;
  }
  return { width, height, channels, data: pixels };
}

/**
 * 两张 PNG 的平均绝对差（MAD），归一到 0..1。
 *
 * 只比 RGB：alpha 在「铺满的不透明底」上没有信息，把它算进去只会稀释数字。
 * 尺寸不一致直接抛 SIZE_MISMATCH —— 那说明对比的前提就错了，不该给个假数字。
 */
export function pngMad(bufferA, bufferB) {
  const a = decodePng(bufferA);
  const b = decodePng(bufferB);
  if (a.width !== b.width || a.height !== b.height) {
    const error = new Error(`尺寸不一致: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
    error.code = 'SIZE_MISMATCH';
    throw error;
  }
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs(a.data[i] - b.data[i]);
    sum += Math.abs(a.data[i + 1] - b.data[i + 1]);
    sum += Math.abs(a.data[i + 2] - b.data[i + 2]);
    count += 3;
  }
  return count ? sum / count / 255 : 0;
}
