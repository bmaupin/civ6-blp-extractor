import fs from 'fs';
import path from 'path';

const CIV6_RAW_PREFIX_SIZE = 176;
const BC3_BLOCK_SIZE = 16;
const FOURCC_DXT5 = 'DXT5';

interface TextureGuess {
  width: number;
  height: number;
  mipCount: number;
}

function getBcMipChainSize(
  width: number,
  height: number,
  blockSize: number,
  smallestMipDimension = 1,
): { size: number; mipCount: number } {
  let w = width;
  let h = height;
  let size = 0;
  let mipCount = 0;

  while (true) {
    const blockW = Math.max(1, Math.ceil(w / 4));
    const blockH = Math.max(1, Math.ceil(h / 4));
    size += blockW * blockH * blockSize;
    mipCount++;

    if (w <= smallestMipDimension && h <= smallestMipDimension) {
      break;
    }

    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }

  return { size, mipCount };
}

function guessSquareTexture(payloadSize: number): TextureGuess | null {
  const candidates = [64, 128, 256, 512, 1024, 2048, 4096];
  const smallestMipOptions = [1, 2, 4, 8];

  for (const dimension of candidates) {
    for (const smallestMip of smallestMipOptions) {
      const { size, mipCount } = getBcMipChainSize(
        dimension,
        dimension,
        BC3_BLOCK_SIZE,
        smallestMip,
      );

      if (size === payloadSize) {
        return {
          width: dimension,
          height: dimension,
          mipCount,
        };
      }
    }
  }

  return null;
}

function buildDDSHeaderDXT5(
  width: number,
  height: number,
  mipCount: number,
): Buffer {
  const header = Buffer.alloc(128, 0);

  // Main DDS header
  header.write('DDS ', 0, 4, 'ascii');
  header.writeUInt32LE(124, 4); // header size

  const DDSD_CAPS = 0x1;
  const DDSD_HEIGHT = 0x2;
  const DDSD_WIDTH = 0x4;
  const DDSD_PIXELFORMAT = 0x1000;
  const DDSD_MIPMAPCOUNT = 0x20000;
  const DDSD_LINEARSIZE = 0x80000;
  const flags =
    DDSD_CAPS |
    DDSD_HEIGHT |
    DDSD_WIDTH |
    DDSD_PIXELFORMAT |
    DDSD_MIPMAPCOUNT |
    DDSD_LINEARSIZE;
  header.writeUInt32LE(flags, 8);
  header.writeUInt32LE(height, 12);
  header.writeUInt32LE(width, 16);

  const topMipLinearSize =
    Math.max(1, Math.ceil(width / 4)) *
    Math.max(1, Math.ceil(height / 4)) *
    BC3_BLOCK_SIZE;
  header.writeUInt32LE(topMipLinearSize, 20);
  header.writeUInt32LE(mipCount, 28);

  // DDS_PIXELFORMAT (offset 76, size 32)
  header.writeUInt32LE(32, 76);
  const DDPF_FOURCC = 0x4;
  header.writeUInt32LE(DDPF_FOURCC, 80);
  header.write(FOURCC_DXT5, 84, 4, 'ascii');

  // Caps
  const DDSCAPS_TEXTURE = 0x1000;
  const DDSCAPS_COMPLEX = 0x8;
  const DDSCAPS_MIPMAP = 0x400000;
  header.writeUInt32LE(DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP, 108);

  return header;
}

function convertRawFile(rawPath: string, outputPath: string): boolean {
  const input = fs.readFileSync(rawPath);

  if (input.length <= CIV6_RAW_PREFIX_SIZE) {
    return false;
  }

  const payload = input.subarray(CIV6_RAW_PREFIX_SIZE);
  const guess = guessSquareTexture(payload.length);
  if (!guess) {
    return false;
  }

  const header = buildDDSHeaderDXT5(guess.width, guess.height, guess.mipCount);
  fs.writeFileSync(outputPath, Buffer.concat([header, payload]));
  return true;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log(
      'Usage: tsx convert-civ6-raw-to-dds.ts <input-dir> [output-dir]',
    );
    process.exit(1);
  }

  const inputDir = args[0];
  const outputDir = args[1] || path.join(inputDir, 'dds');

  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    console.error(`Directory not found: ${inputDir}`);
    process.exit(1);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const rawFiles = fs
    .readdirSync(inputDir)
    .filter((file) => file.endsWith('.raw'))
    .sort();

  if (rawFiles.length === 0) {
    console.log('No .raw files found.');
    process.exit(0);
  }

  let converted = 0;
  let skipped = 0;

  for (const file of rawFiles) {
    const inputPath = path.join(inputDir, file);
    const outputPath = path.join(outputDir, file.replace(/\.raw$/, '.dds'));

    const ok = convertRawFile(inputPath, outputPath);
    if (ok) {
      converted++;
      console.log(`✅ ${file} -> ${path.basename(outputPath)}`);
    } else {
      skipped++;
      console.log(`⚠️  Skipped ${file} (size/layout not recognized)`);
    }
  }

  console.log(`\nDone. Converted: ${converted}, Skipped: ${skipped}`);
}

main().catch(console.error);
