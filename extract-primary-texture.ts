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
import { pathToFileURL } from 'url';
import {
  DXGI_FORMATS,
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

export interface ExtractionResult {
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

function getTextureEntries(buffer: Buffer, header: BLPHeader): TextureEntry[] {
  try {
    const packageData = buffer.subarray(
      header.packageDataOffset,
      header.packageDataOffset + header.packageDataSize,
    );

    const preamble = parsePreamble(packageData, 0);
    if (preamble.version !== 5) {
      return [];
    }

    const packageHeader = parsePackageHeader(packageData, 0);
    const stripeMap = chooseStripeMap(packageData, packageHeader.stripes);

    const allocations = parseAllocationTable(
      packageData,
      stripeMap,
      packageHeader.linkerDataOffset,
      packageHeader.sizeOfPackageAllocation || 40,
    );

    if (allocations.length === 0) {
      return [];
    }

    const textures: TextureEntry[] = [];
    let debugTextureCount = 0;
    for (const alloc of allocations) {
      const typeName = getTypeName(alloc, allocations, packageData, stripeMap);
      if (!typeName || !typeName.endsWith('TextureEntry')) {
        continue;
      }

      const entry = readTextureEntry(
        alloc,
        allocations,
        packageData,
        stripeMap,
      );
      if (entry) {
        textures.push(entry);
        debugTextureCount++;
        if (debugTextureCount <= 3 || debugTextureCount > textures.length - 3) {
          // Log first 3 and last 3 for debugging
          if (process.env.DEBUG_TEXTURES) {
            console.log(
              `  [DEBUG] Texture ${textures.length - 1}: ${entry.name} ${entry.width}x${entry.height}, format=${entry.format}, offset=${entry.offset}`,
            );
          }
        }
      }
    }

    // BigData is ordered by payload offset, so sort to align indices.
    textures.sort((a, b) => a.offset - b.offset);
    return textures;
  } catch {
    return [];
  }
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

function normaliseTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) =>
      token.endsWith('s') && token.length > 3 ? token.slice(0, -1) : token,
    );
}

function tokenMatches(a: string, b: string): boolean {
  return (
    a === b ||
    a.startsWith(b) ||
    b.startsWith(a) ||
    a.endsWith(b) ||
    b.endsWith(a)
  );
}

function looksLikeContainerLabelForFile(
  candidateName: string,
  blpPath: string,
): boolean {
  const fileStem = path.basename(blpPath, path.extname(blpPath));
  const candidateTokens = normaliseTokens(candidateName);
  const fileTokens = normaliseTokens(fileStem);

  if (candidateTokens.length === 0 || fileTokens.length === 0) {
    return false;
  }

  let matches = 0;
  for (const c of candidateTokens) {
    if (fileTokens.some((f) => tokenMatches(c, f))) {
      matches++;
    }
  }

  // Treat as a container label if all candidate tokens match file stem tokens,
  // with at least 2 matches to avoid accidental single-token drops.
  return matches >= 2 && matches === candidateTokens.length;
}

function maybeSkipLeadingContainerLabel(
  names: string[],
  blpPath?: string,
): string[] {
  if (!blpPath || names.length === 0) {
    return names;
  }

  if (looksLikeContainerLabelForFile(names[0]!, blpPath)) {
    return names.slice(1);
  }

  return names;
}

function getTextureNameByIndex(
  buffer: Buffer,
  header: BLPHeader,
  textureIndex: number,
  blpPath?: string,
): string {
  // First preference: resolve texture name from parsed TextureEntry metadata.
  const textureEntries = getTextureEntries(buffer, header);
  const entryNames = textureEntries.map((entry) => entry.name);
  const alignedEntryNames = maybeSkipLeadingContainerLabel(entryNames, blpPath);
  if (textureIndex >= 0 && textureIndex < alignedEntryNames.length) {
    const entryName = alignedEntryNames[textureIndex];
    if (entryName && entryName.length > 0) {
      return entryName;
    }
  }

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

    const alignedNames = maybeSkipLeadingContainerLabel(names, blpPath);

    // Prefer a list aligned with BigData count when possible.
    if (alignedNames.length >= header.bigDataCount && header.bigDataCount > 0) {
      const namesByBigData = alignedNames.slice(0, header.bigDataCount);
      if (textureIndex < namesByBigData.length) {
        return namesByBigData[textureIndex]!;
      }
    }

    // Fallback: return by scanned index if available.
    if (textureIndex < alignedNames.length) {
      return alignedNames[textureIndex]!;
    }
  } catch (error) {
    // If anything goes wrong, fall back to generic name
  }

  return `texture_${textureIndex}`;
}

export function extractTextureByName(
  blpPath: string,
  targetTextureName: string,
  outputDir: string,
): ExtractionResult {
  if (!fs.existsSync(blpPath)) {
    throw new Error(`File not found: ${blpPath}`);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const buffer = fs.readFileSync(blpPath);
  const header = parseBLPHeader(buffer);

  const normalisedTarget = targetTextureName.toLowerCase();
  const targetWithoutExt = normalisedTarget.endsWith('.dds')
    ? normalisedTarget.slice(0, -4)
    : normalisedTarget;

  let textureIndex = -1;
  for (let i = 0; i < header.bigDataCount; i++) {
    const guessedName = getTextureNameByIndex(
      buffer,
      header,
      i,
      blpPath,
    ).toLowerCase();
    const guessedWithoutExt = guessedName.endsWith('.dds')
      ? guessedName.slice(0, -4)
      : guessedName;
    if (
      guessedName === normalisedTarget ||
      guessedWithoutExt === targetWithoutExt
    ) {
      textureIndex = i;
      break;
    }
  }

  if (textureIndex < 0) {
    throw new Error(
      `Texture not found in metadata: ${targetTextureName} (${path.basename(blpPath)})`,
    );
  }

  const textureName = getTextureNameByIndex(
    buffer,
    header,
    textureIndex,
    blpPath,
  );

  return extractBC3Texture(
    buffer,
    header,
    textureIndex,
    outputDir,
    textureName,
    null,
  );
}

function computeTextureSize(
  width: number,
  height: number,
  mipCount: number,
  blockBytes?: number,
  bytesPerPixel?: number,
): number {
  let total = 0;

  for (let mip = 0; mip < mipCount; mip++) {
    const mw = Math.max(1, width >> mip);
    const mh = Math.max(1, height >> mip);

    if (blockBytes) {
      const bw = Math.max(1, Math.ceil(mw / 4));
      const bh = Math.max(1, Math.ceil(mh / 4));
      total += bw * bh * blockBytes;
    } else if (bytesPerPixel) {
      total += mw * mh * bytesPerPixel;
    }
  }

  return total;
}

/**
 * Extract texture payload from BigData as DDS using TextureEntry metadata.
 */
function extractBC3Texture(
  buffer: Buffer,
  header: BLPHeader,
  textureIndex: number,
  outputDir: string,
  textureName: string,
  textureEntry?: TextureEntry | null,
): ExtractionResult {
  if (header.bigDataCount === 0) {
    throw new Error('No BigData section in this BLP');
  }

  if (textureIndex >= header.bigDataCount) {
    throw new Error(
      `Texture index ${textureIndex} out of range (max ${header.bigDataCount - 1})`,
    );
  }

  let entry = textureEntry || null;
  if (!entry) {
    const entries = getTextureEntries(buffer, header);
    entry = entries[textureIndex] || null;
  }

  // Fallback for files where TextureEntry parsing fails.
  const fallbackAssetSize = 87552;
  const fallbackPayloadSize = 87376;
  const fallbackWidth = 256;
  const fallbackHeight = 256;
  const fallbackMips = 7;
  const fallbackFormat = 77;

  const format = entry?.format ?? fallbackFormat;
  const formatInfo = DXGI_FORMATS[format];
  const blockBytes = formatInfo?.blockBytes;
  const bytesPerPixel = formatInfo?.bytesPerPixel;

  const width = entry
    ? Math.max(1, entry.width >> entry.droppedMips)
    : fallbackWidth;
  const height = entry
    ? Math.max(1, entry.height >> entry.droppedMips)
    : fallbackHeight;
  const mipCount = entry
    ? Math.max(1, entry.mips - entry.droppedMips)
    : fallbackMips;

  const payloadOffset = entry
    ? header.bigDataOffset + entry.offset
    : header.bigDataOffset + textureIndex * fallbackAssetSize;
  const payloadSize = entry?.size ?? fallbackPayloadSize;

  if (payloadOffset + payloadSize > buffer.length) {
    throw new Error(`Texture ${textureIndex} would read beyond file end`);
  }

  const payload = buffer.subarray(payloadOffset, payloadOffset + payloadSize);

  const expectedSize = computeTextureSize(
    width,
    height,
    mipCount,
    blockBytes,
    bytesPerPixel,
  );
  const mainMipSize = computeTextureSize(
    width,
    height,
    1,
    blockBytes,
    bytesPerPixel,
  );

  console.log(`\nTexture ${textureIndex}: ${textureName}`);
  console.log(`  Format: DXGI ${format} (${formatInfo?.name || 'UNKNOWN'})`);
  console.log(`  Stored size: ${width}x${height}, mips=${mipCount}`);
  console.log(`  Offset in BigData: ${payloadOffset - header.bigDataOffset}`);
  console.log(`  Payload size: ${payload.length} bytes`);
  if (expectedSize > 0 && expectedSize !== payload.length) {
    console.log(
      `  ⚠️  Size mismatch: expected ${expectedSize}, found ${payload.length}`,
    );
  }

  const ddsHeader = buildDDSHeaderDX10(
    width,
    height,
    mipCount,
    format,
    blockBytes,
    bytesPerPixel,
  );
  const ddsFile = Buffer.concat([ddsHeader, payload]);

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
    format: formatInfo?.name || `DXGI_${format}`,
    width,
    height,
    bc3DataSize: payload.length,
    mainMipSize: mainMipSize,
    outputPath: bc3Path,
  };
}

/**
 * Build DDS header using DX10 extension for arbitrary DXGI formats.
 */
function buildDDSHeaderDX10(
  width: number,
  height: number,
  mipCount: number,
  dxgiFormat: number,
  blockBytes?: number,
  bytesPerPixel?: number,
): Buffer {
  const header = Buffer.alloc(148, 0);

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
  const DDSD_PITCH = 0x8;

  let flags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT;
  if (mipCount > 1) {
    flags |= DDSD_MIPMAPCOUNT;
  }
  if (blockBytes) {
    flags |= DDSD_LINEARSIZE;
  } else if (bytesPerPixel) {
    flags |= DDSD_PITCH;
  }

  header.writeUInt32LE(flags, 8);

  header.writeUInt32LE(height, 12); // dwHeight
  header.writeUInt32LE(width, 16); // dwWidth

  // dwPitchOrLinearSize
  if (blockBytes) {
    const topSize =
      Math.max(1, Math.ceil(width / 4)) *
      Math.max(1, Math.ceil(height / 4)) *
      blockBytes;
    header.writeUInt32LE(topSize, 20);
  } else if (bytesPerPixel) {
    header.writeUInt32LE(width * bytesPerPixel, 20);
  }

  header.writeUInt32LE(0, 24); // dwDepth
  header.writeUInt32LE(mipCount, 28); // dwMipMapCount

  // DDS_PIXELFORMAT (32 bytes at offset 76)
  header.writeUInt32LE(32, 76); // dwSize
  header.writeUInt32LE(0x4, 80); // dwFlags = DDPF_FOURCC
  header.write('DX10', 84, 4, 'ascii'); // dwFourCC

  // Caps
  const DDSCAPS_COMPLEX = 0x8;
  const DDSCAPS_TEXTURE = 0x1000;
  const DDSCAPS_MIPMAP = 0x400000;
  let caps = DDSCAPS_TEXTURE;
  if (mipCount > 1) {
    caps |= DDSCAPS_COMPLEX | DDSCAPS_MIPMAP;
  }
  header.writeUInt32LE(caps, 108);

  // DDS_HEADER_DXT10
  header.writeUInt32LE(dxgiFormat, 128);
  header.writeUInt32LE(3, 132); // D3D10_RESOURCE_DIMENSION_TEXTURE2D
  header.writeUInt32LE(0, 136); // miscFlag
  header.writeUInt32LE(1, 140); // array size
  header.writeUInt32LE(0, 144); // miscFlags2

  return header;
}

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list') || args.includes('-l');
  const positionalArgs = args.filter((arg) => arg !== '--list' && arg !== '-l');

  if (positionalArgs.length < 1) {
    console.log(
      'Usage: node extract-primary-texture.ts <blp-file> [texture-index] [output-dir] [--list|-l]',
    );
    console.log('');
    console.log('Example:');
    console.log(
      '  node extract-primary-texture.ts workdir/strategicview_terrainsprites.blp 0 workdir/output',
    );
    console.log(
      '  node extract-primary-texture.ts workdir/strategicview_terrainsprites.blp --list',
    );
    console.log('');
    console.log('Texture indices (based on analysis):');
    console.log('  0 = SV_Sprites_HillsDesert_Color_1.dds');
    console.log('  1 = SV_Sprites_HillsDesert_Color_2.dds');
    process.exit(1);
  }

  const blpPath = positionalArgs[0]!;
  const textureIndex = positionalArgs[1] ? parseInt(positionalArgs[1], 10) : 0;
  const outputDir = positionalArgs[2] || './output';

  if (!fs.existsSync(blpPath)) {
    console.error(`File not found: ${blpPath}`);
    process.exit(1);
  }

  if (!listOnly && (Number.isNaN(textureIndex) || textureIndex < 0)) {
    console.error(
      `Invalid texture index: ${positionalArgs[1]}. Expected a non-negative integer.`,
    );
    process.exit(1);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`\n📦 Extracting texture from: ${path.basename(blpPath)}`);

  const buffer = fs.readFileSync(blpPath);
  const header = parseBLPHeader(buffer);
  const textureEntries = getTextureEntries(buffer, header);

  console.log(`\nBLP Info:`);
  console.log(`  Magic: ${header.magic}`);
  console.log(`  File size: ${header.fileSize} bytes`);
  console.log(`  BigData offset: ${header.bigDataOffset}`);
  console.log(`  BigData count: ${header.bigDataCount}`);
  if (textureEntries.length > 0) {
    console.log(`  Parsed texture entries: ${textureEntries.length}`);
  }

  if (listOnly) {
    console.log('\nAsset names:');
    for (let i = 0; i < header.bigDataCount; i++) {
      const metadataName = textureEntries[i]?.name;
      const name =
        metadataName && metadataName.length > 0
          ? metadataName
          : getTextureNameByIndex(buffer, header, i, blpPath);
      console.log(`  ${i.toString().padStart(3, ' ')}: ${name}`);
    }

    if (header.bigDataCount === 0) {
      console.log('  (No assets found in BigData)');
    }

    return;
  }

  // Get the proper texture name from metadata
  const metadataEntry = textureEntries[textureIndex] || null;
  const textureName =
    metadataEntry?.name ||
    getTextureNameByIndex(buffer, header, textureIndex, blpPath);

  const result = extractBC3Texture(
    buffer,
    header,
    textureIndex,
    outputDir,
    textureName,
    metadataEntry,
  );

  console.log(`\n✅ Extraction complete!`);
  console.log(`\nTo decompress BC3 to RGBA for comparison:`);
  console.log(`  # Install NVIDIA Texture Tools if not already installed`);
  console.log(`  # Ubuntu/Debian: sudo apt install libnvtt-bin`);
  console.log(`  nvdecompress ${result.outputPath} output_rgba.dds`);
  console.log(`\nOr use ImageMagick:`);
  console.log(`  convert ${result.outputPath} output_rgba.png`);
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
