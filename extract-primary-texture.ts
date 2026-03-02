/**
 * Extract primary (mip 0) texture from Civ 6 BLP file
 *
 * Goal: Extract SV_Sprites_HillsDesert_Color_1 from strategicview_terrainsprites.blp
 * and match the reference 256x256 uncompressed RGBA image
 *
 * What we know:
 * - Reference: 256x256, 9 mipmaps, uncompressed RGBA (4 bytes/pixel)
 * - Extracted (asset_00.dds): 256x256, 7 mipmaps, BC3/DXT5 compressed
 * - BC3 stores 4x4 pixel blocks in 16 bytes
 * - 256x256 BC3 main mip = (256/4) * (256/4) * 16 = 64 * 64 * 16 = 65,536 bytes
 * - 7 mipmaps BC3 total = 65536 + 16384 + 4096 + 1024 + 256 + 64 + 16 = 87,376 bytes
 * - Extracted DDS = 128 bytes (DDS header) + 87,376 = 87,504 bytes ✓
 *
 * Strategy:
 * 1. Find BC3 texture data in BigData section
 * 2. Extract just the first 65,536 bytes (main mip only)
 * 3. Decompress BC3 to RGBA (we'll need a BC3 decoder or external tool)
 * 4. Save as uncompressed DDS to compare with reference
 */

import fs from 'fs';
import path from 'path';
import { parseBLPHeader, type BLPHeader } from './blp-format.ts';

interface ExtractionResult {
  success: boolean;
  textureIndex: number;
  textureName: string;
  format: string;
  width: number;
  height: number;
  bc3DataSize: number;
  mainMipSize: number;
  outputPath: string;
}

function getTextureNameByIndex(
  buffer: Buffer,
  header: BLPHeader,
  textureIndex: number,
  blpFileName: string,
): string {
  // Extract asset names from the package data
  // Civ 6 BLP stores texture names as null-terminated strings in the package data
  // They appear to be in sequential order corresponding to the asset indices

  try {
    const packageData = buffer.subarray(
      header.packageDataOffset,
      header.packageDataOffset + header.packageDataSize,
    );

    const names: string[] = [];

    // Scan through package data for asset name strings
    for (let i = 0; i < packageData.length - 1; i++) {
      if (packageData[i] === 0) continue;

      // Find the end of potential string
      let end = i;
      while (end < packageData.length && packageData[end] !== 0) {
        end++;
      }

      if (end - i > 3) {
        const str = packageData.subarray(i, end).toString('utf8');
        // Check for valid asset name pattern (SV_ prefix, alphanumeric + underscore/dash/dot)
        if (/^[A-Za-z0-9_\-\.]+$/.test(str) && str.startsWith('SV_')) {
          // Only add if not already in list (avoid duplicates)
          if (!names.includes(str)) {
            names.push(str);
          }
        }
      }
    }

    // Return the name for this index if found
    if (textureIndex < names.length) {
      return names[textureIndex];
    }
  } catch (error) {
    // If anything goes wrong, fall back to generic name
  }

  return `texture_${textureIndex}`;
}

/**
 * Extract BC3/DXT5 compressed texture data
 * For now, we extract the full mip chain as DDS
 */
function extractBC3Texture(
  buffer: Buffer,
  header: BLPHeader,
  textureIndex: number,
  outputDir: string,
  textureName: string,
): ExtractionResult {
  // Based on investigation.md:
  // - Each asset block is 87,552 bytes
  // - BC3 payload occupies the full 87,552 bytes (no separate prefix)
  // - Texture payload starts at: BigDataOffset + (assetIndex * 87552)
  // - Note: Earlier assumption of 176-byte prefix was incorrect;
  //   the prefix is part of the asset header, not skipped data

  const ASSET_SIZE = 87552;
  const BC3_PAYLOAD_SIZE = 87376; // 7 mipmaps worth; extra ~176 bytes unaccounted
  const MAIN_MIP_SIZE = 65536; // 256x256 BC3 (64x64 blocks * 16 bytes)

  if (header.bigDataCount === 0) {
    throw new Error('No BigData section in this BLP');
  }

  if (textureIndex >= header.bigDataCount) {
    throw new Error(
      `Texture index ${textureIndex} out of range (max ${header.bigDataCount - 1})`,
    );
  }

  // Calculate offset to this texture's BC3 payload in BigData section
  // Each asset starts at: header.bigDataOffset + (textureIndex * ASSET_SIZE)
  const bc3PayloadOffset = header.bigDataOffset + textureIndex * ASSET_SIZE;

  if (bc3PayloadOffset + BC3_PAYLOAD_SIZE > buffer.length) {
    throw new Error(`Texture ${textureIndex} would read beyond file end`);
  }

  // Extract the BC3 payload
  const bc3Data = buffer.subarray(
    bc3PayloadOffset,
    bc3PayloadOffset + BC3_PAYLOAD_SIZE,
  );

  console.log(`\nTexture ${textureIndex}: ${textureName}`);
  console.log(
    `  Offset in BigData: ${bc3PayloadOffset - header.bigDataOffset}`,
  );
  console.log(`  BC3 payload size: ${bc3Data.length} bytes`);
  console.log(`  Main mip size: ${MAIN_MIP_SIZE} bytes`);

  // Build DDS header for BC3/DXT5
  const ddsHeader = buildBC3DDSHeader(256, 256, 7);
  const ddsFile = Buffer.concat([ddsHeader, bc3Data]);

  // Save BC3 compressed version with proper name
  const outputFileName = textureName.endsWith('.dds')
    ? textureName
    : `${textureName}.dds`;
  const bc3Path = path.join(outputDir, outputFileName);
  fs.writeFileSync(bc3Path, ddsFile);
  console.log(`  Saved BC3 DDS: ${bc3Path}`);

  return {
    success: true,
    textureIndex,
    textureName,
    format: 'BC3/DXT5',
    width: 256,
    height: 256,
    bc3DataSize: bc3Data.length,
    mainMipSize: MAIN_MIP_SIZE,
    outputPath: bc3Path,
  };
}

/**
 * Build DDS header for BC3/DXT5 compressed texture
 */
function buildBC3DDSHeader(
  width: number,
  height: number,
  mipCount: number,
): Buffer {
  const header = Buffer.alloc(128, 0);

  // DDS magic
  header.write('DDS ', 0, 4, 'ascii');

  // DDS_HEADER
  header.writeUInt32LE(124, 4); // dwSize

  // Flags
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

  header.writeUInt32LE(height, 12); // dwHeight
  header.writeUInt32LE(width, 16); // dwWidth

  // dwPitchOrLinearSize - for BC3, size of top mip in bytes
  const linearSize =
    Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * 16;
  header.writeUInt32LE(linearSize, 20);

  header.writeUInt32LE(0, 24); // dwDepth
  header.writeUInt32LE(mipCount, 28); // dwMipMapCount

  // DDS_PIXELFORMAT (32 bytes at offset 76)
  header.writeUInt32LE(32, 76); // dwSize
  header.writeUInt32LE(0x4, 80); // dwFlags = DDPF_FOURCC
  header.write('DXT5', 84, 4, 'ascii'); // dwFourCC

  // Caps
  const DDSCAPS_COMPLEX = 0x8;
  const DDSCAPS_TEXTURE = 0x1000;
  const DDSCAPS_MIPMAP = 0x400000;
  header.writeUInt32LE(DDSCAPS_COMPLEX | DDSCAPS_TEXTURE | DDSCAPS_MIPMAP, 108);

  return header;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log(
      'Usage: node extract-primary-texture.ts <blp-file> [texture-index] [output-dir]',
    );
    console.log('');
    console.log('Example:');
    console.log(
      '  node extract-primary-texture.ts workdir/strategicview_terrainsprites.blp 0 workdir/output',
    );
    console.log('');
    console.log('Texture indices (based on analysis):');
    console.log('  0 = SV_Sprites_HillsDesert_Color_1.dds');
    console.log('  1 = SV_Sprites_HillsDesert_Color_2.dds');
    process.exit(1);
  }

  const blpPath = args[0];
  const textureIndex = args[1] ? parseInt(args[1], 10) : 0;
  const outputDir = args[2] || './output';

  if (!fs.existsSync(blpPath)) {
    console.error(`File not found: ${blpPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`\n📦 Extracting texture from: ${path.basename(blpPath)}`);

  const buffer = fs.readFileSync(blpPath);
  const header = parseBLPHeader(buffer);

  console.log(`\nBLP Info:`);
  console.log(`  Magic: ${header.magic}`);
  console.log(`  File size: ${header.fileSize} bytes`);
  console.log(`  BigData offset: ${header.bigDataOffset}`);
  console.log(`  BigData count: ${header.bigDataCount}`);

  // Get the proper texture name from metadata or known mappings
  const textureName = getTextureNameByIndex(
    buffer,
    header,
    textureIndex,
    blpPath,
  );

  const result = extractBC3Texture(
    buffer,
    header,
    textureIndex,
    outputDir,
    textureName,
  );

  console.log(`\n✅ Extraction complete!`);
  console.log(`\nTo decompress BC3 to RGBA for comparison:`);
  console.log(`  # Install NVIDIA Texture Tools if not already installed`);
  console.log(`  # Ubuntu/Debian: sudo apt install libnvtt-bin`);
  console.log(`  nvdecompress ${result.outputPath} output_rgba.dds`);
  console.log(`\nOr use ImageMagick:`);
  console.log(`  convert ${result.outputPath} output_rgba.png`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
