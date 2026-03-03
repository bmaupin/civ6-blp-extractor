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
import {
  parseBLPHeader,
  parsePreamble,
  readUInt64LE,
  toNumber,
  type BLPHeader,
  type AllocationEntry,
  type StripeInfo,
  type StripeMap,
  type TextureEntry,
} from './blp-format.ts';

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

function parseStripeInfo(buffer: Buffer, offset: number): StripeInfo {
  return {
    start: buffer.readUInt32LE(offset),
    size: buffer.readUInt32LE(offset + 4),
  };
}

function parsePackageHeader(packageData: Buffer, preambleOffset: number) {
  const headerOffset = preambleOffset + 16;
  const stripes: StripeInfo[] = [];

  for (let i = 0; i < 5; i++) {
    stripes.push(parseStripeInfo(packageData, headerOffset + i * 8));
  }

  const linkerDataOffset = packageData.readUInt32LE(headerOffset + 40);
  const sizeOfPackageAllocation = packageData.readUInt32LE(headerOffset + 64);

  return {
    stripes,
    linkerDataOffset,
    sizeOfPackageAllocation,
  };
}

function readRootTypeName(
  packageData: Buffer,
  stripe: StripeInfo,
): string | null {
  const slice = packageData.subarray(stripe.start, stripe.start + stripe.size);
  const end = slice.indexOf(0x00);
  const length = end >= 0 ? end : slice.length;
  const value = slice.subarray(0, length).toString('ascii');
  if (!value || !/^[\x20-\x7E]+$/.test(value)) {
    return null;
  }
  return value;
}

function chooseStripeMap(
  packageData: Buffer,
  stripes: StripeInfo[],
): StripeMap {
  const mappingA: StripeMap = {
    resourceLinker: stripes[0]!,
    packageBlock: stripes[1]!,
    tempData: stripes[2]!,
    typeInfo: stripes[3]!,
    rootTypeName: stripes[4]!,
  };
  const mappingB: StripeMap = {
    rootTypeName: stripes[0]!,
    typeInfo: stripes[1]!,
    packageBlock: stripes[2]!,
    tempData: stripes[3]!,
    resourceLinker: stripes[4]!,
  };

  const rootA = readRootTypeName(packageData, mappingA.rootTypeName);
  if (rootA && rootA.includes('BLP::')) {
    return mappingA;
  }

  const rootB = readRootTypeName(packageData, mappingB.rootTypeName);
  if (rootB && rootB.includes('BLP::')) {
    return mappingB;
  }

  return mappingA;
}

function getStripeData(
  packageData: Buffer,
  stripeMap: StripeMap,
  stripeIndex: number,
): Buffer {
  switch (stripeIndex) {
    case 0:
      return packageData.subarray(
        stripeMap.packageBlock.start,
        stripeMap.packageBlock.start + stripeMap.packageBlock.size,
      );
    case 1:
      return packageData.subarray(
        stripeMap.tempData.start,
        stripeMap.tempData.start + stripeMap.tempData.size,
      );
    case 2:
      return packageData.subarray(
        stripeMap.typeInfo.start,
        stripeMap.typeInfo.start + stripeMap.typeInfo.size,
      );
    case 3:
      return packageData.subarray(
        stripeMap.rootTypeName.start,
        stripeMap.rootTypeName.start + stripeMap.rootTypeName.size,
      );
    case 4:
      return packageData.subarray(
        stripeMap.resourceLinker.start,
        stripeMap.resourceLinker.start + stripeMap.resourceLinker.size,
      );
    default:
      return Buffer.alloc(0);
  }
}

function parseAllocationTable(
  packageData: Buffer,
  stripeMap: StripeMap,
  linkerDataOffset: number,
  entrySize = 40,
): AllocationEntry[] {
  const tempData = getStripeData(packageData, stripeMap, 1);
  const start = linkerDataOffset;
  if (start <= 0 || start >= tempData.length) {
    return [];
  }

  const entries: AllocationEntry[] = [];
  const count = Math.floor((tempData.length - start) / entrySize);

  for (let i = 0; i < count; i++) {
    const offset = start + i * entrySize;
    const stripeIndexRaw = readUInt64LE(tempData, offset);
    const stripeIndex = Number(stripeIndexRaw & BigInt(0xff));
    const byteOffset = tempData.readUInt32LE(offset + 8);
    const size = tempData.readUInt32LE(offset + 12);
    const elementCount = tempData.readUInt32LE(offset + 16);
    const userData = readUInt64LE(tempData, offset + 24);
    const typeNamePtr = readUInt64LE(tempData, offset + 32);

    entries.push({
      index: i,
      stripeIndex,
      byteOffset,
      size,
      elementCount,
      userData,
      typeNamePtr,
    });
  }

  return entries;
}

function resolveAllocation(
  ptr: bigint,
  allocations: AllocationEntry[],
): AllocationEntry | null {
  if (ptr === BigInt(0)) {
    return null;
  }
  const index = toNumber(ptr - BigInt(1));
  if (index < 0 || index >= allocations.length) {
    return null;
  }
  return allocations[index] || null;
}

function readStringFromAllocation(
  alloc: AllocationEntry,
  allocations: AllocationEntry[],
  packageData: Buffer,
  stripeMap: StripeMap,
): string | null {
  const stripeData = getStripeData(packageData, stripeMap, alloc.stripeIndex);
  const slice = stripeData.subarray(
    alloc.byteOffset,
    alloc.byteOffset + alloc.size,
  );
  if (slice.length === 0) {
    return null;
  }

  if (slice.length >= 8) {
    const ptr = readUInt64LE(slice, 0);
    const storageAlloc = resolveAllocation(ptr, allocations);
    if (storageAlloc) {
      const storageStripe = getStripeData(
        packageData,
        stripeMap,
        storageAlloc.stripeIndex,
      );
      const storage = storageStripe.subarray(
        storageAlloc.byteOffset,
        storageAlloc.byteOffset + storageAlloc.size,
      );
      if (storage.length >= 8) {
        const length = storage.readUInt32LE(4);
        if (length > 0 && length <= storage.length - 8) {
          return storage.subarray(8, 8 + length).toString('utf8');
        }
      }
    }
  }

  const zero = slice.indexOf(0x00);
  const end = zero >= 0 ? zero : slice.length;
  const text = slice.subarray(0, end).toString('utf8');
  if (!text || !/^[\x20-\x7E]+$/.test(text)) {
    return null;
  }
  return text;
}

function readStringFromPtr(
  ptr: bigint,
  allocations: AllocationEntry[],
  packageData: Buffer,
  stripeMap: StripeMap,
): string {
  const alloc = resolveAllocation(ptr, allocations);
  if (!alloc) {
    return '';
  }
  return (
    readStringFromAllocation(alloc, allocations, packageData, stripeMap) || ''
  );
}

function getTypeName(
  alloc: AllocationEntry,
  allocations: AllocationEntry[],
  packageData: Buffer,
  stripeMap: StripeMap,
): string {
  if (alloc.typeNamePtr === BigInt(0)) {
    return '';
  }
  return readStringFromPtr(
    alloc.typeNamePtr,
    allocations,
    packageData,
    stripeMap,
  );
}

function readTextureEntry(
  alloc: AllocationEntry,
  allocations: AllocationEntry[],
  packageData: Buffer,
  stripeMap: StripeMap,
): TextureEntry | null {
  const stripeData = getStripeData(packageData, stripeMap, alloc.stripeIndex);
  const data = stripeData.subarray(
    alloc.byteOffset,
    alloc.byteOffset + alloc.size,
  );
  if (data.length < 88) {
    return null;
  }

  const namePtr = readUInt64LE(data, 8);
  const name = readStringFromPtr(namePtr, allocations, packageData, stripeMap);
  const offset = Number(readUInt64LE(data, 32));
  const size = data.readUInt32LE(40);
  const format = data.readUInt16LE(72);
  const width = data.readUInt16LE(76);
  const height = data.readUInt16LE(78);
  const mips = data.readUInt8(84);
  const droppedMips = data.readUInt8(86);

  return {
    name,
    width,
    height,
    mips,
    droppedMips,
    format,
    offset,
    size,
  };
}

function hasMetadataLikePrefix(name: string): boolean {
  // Common metadata/member-name prefixes observed in package strings
  if (/^m_/i.test(name)) return true;
  if (/^(dw|qw|by)(_|[A-Z])/i.test(name)) return true;
  if (/^(w|n|p)(_|[A-Z])/.test(name)) return true;

  // Type-ish names are not texture asset names
  if (/^(u?int\d*|float\d*|bool|char)\b/i.test(name)) return true;
  if (/^fgx/i.test(name)) return true;

  return false;
}

function isLikelyTextureAssetName(name: string): boolean {
  if (name.length < 6 || name.length > 120) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) return false;

  // Civ 6 texture assets we care about consistently use underscores.
  if (!name.includes('_')) return false;

  if (hasMetadataLikePrefix(name)) return false;

  const lowerName = name.toLowerCase();

  // Exclude common package/system metadata labels
  if (
    lowerName.includes('stripe') ||
    lowerName.includes('package') ||
    lowerName.includes('entry') ||
    lowerName.includes('linker') ||
    lowerName.includes('allocator') ||
    lowerName.includes('library') ||
    lowerName.includes('class') ||
    lowerName === 'm_sz' ||
    lowerName === 'sz'
  ) {
    return false;
  }

  // Texture names are usually at least two tokens, often three+.
  const tokens = name.split('_').filter((token) => token.length > 0);
  if (tokens.length < 2) return false;

  return true;
}

function getTextureNameByIndex(
  buffer: Buffer,
  header: BLPHeader,
  textureIndex: number,
): string {
  // Civ 6 BLPs have package data with mostly zeroed headers, so Civ 7-style
  // metadata parsing is unreliable. Texture names are still present as
  // null-terminated strings, mixed with lots of metadata field/type names.
  // We scan for strings and filter with asset-focused heuristics.

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

      const length = end - i;
      if (length >= 4 && length <= 120) {
        const str = packageData.subarray(i, end).toString('utf8');
        if (isLikelyTextureAssetName(str)) {
          // Only add if not already in list (avoid duplicates)
          if (!names.includes(str)) {
            names.push(str);
          }
        }
      }

      // Skip to end of this string
      i = end;
    }

    // Prefer a list aligned with BigData count when possible.
    if (names.length >= header.bigDataCount && header.bigDataCount > 0) {
      const alignedNames = names.slice(0, header.bigDataCount);
      if (textureIndex < alignedNames.length) {
        return alignedNames[textureIndex]!;
      }
    }

    // Fallback: return by scanned index if available.
    if (textureIndex < names.length) {
      return names[textureIndex]!;
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

  // Get the proper texture name from metadata
  const textureName = getTextureNameByIndex(buffer, header, textureIndex);

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
