/**
 * Civilization VI BLP File Format Specification
 *
 * This file documents the KNOWN and VERIFIED structures of Civ 6 BLP files.
 * Only include information that has been confirmed through testing.
 *
 * References:
 * - https://civ6.fandom.com/wiki/BLP
 * - Civ 7 BLP spec (similar but not identical): https://github.com/ghost-ng/blp-studio/wiki/BLP-Format-Specification
 */

/**
 * BLP File Header (1024 bytes at offset 0x00)
 *
 * VERIFIED fields:
 * - 0x00: Magic "CIVBLP" (6 bytes)
 * - 0x08: packageDataOffset (uint32) - offset to package data section
 * - 0x0C: packageDataSize (uint32) - size of package data in bytes
 * - 0x10: bigDataOffset (uint32) - offset to BigData section (embedded assets)
 * - 0x14: bigDataCount (uint32) - number of assets in BigData section
 * - 0x18: fileSize (uint32) - total BLP file size
 */
export interface BLPHeader {
  magic: string; // "CIVBLP"
  packageDataOffset: number;
  packageDataSize: number;
  bigDataOffset: number;
  bigDataCount: number;
  fileSize: number;
}

/**
 * Package Data Preamble (16 bytes at packageDataOffset)
 *
 * VERIFIED fields:
 * - 0x00: version (uint32)
 * - 0x04: ptrSize (uint16) - typically 8 for 64-bit pointers
 * - 0x06: alignment (uint16)
 * - 0x08: headerSize (uint32)
 * - 0x0C: endian (uint32) - 0 = little endian
 */
export interface PackagePreamble {
  version: number;
  ptrSize: number;
  alignment: number;
  headerSize: number;
  endian: number;
}

/**
 * Stripe Info (8 bytes)
 * Describes a data region within package data
 */
export interface StripeInfo {
  start: number; // uint32 - offset from packageDataOffset
  size: number; // uint32 - size in bytes
}

/**
 * Package Header (follows preamble at packageDataOffset + 16)
 *
 * Contains 5 stripes that organize package data:
 * The exact order can vary between files, need to detect via rootTypeName content
 */
export interface PackageHeader {
  stripes: StripeInfo[]; // 5 stripes (40 bytes total)
  linkerDataOffset: number; // uint32
  packageBlockAlignment: number; // uint32
  sizeOfPackageAllocation: number; // uint32 - typically 40 bytes per entry
  // Other fields may exist but not fully verified
}

/**
 * Stripe Mapping
 * Maps logical stripe names to physical stripe indices
 *
 * KNOWN stripe types:
 * - resourceLinker: Resource linking information
 * - packageBlock: Main data block with object instances
 * - tempData: Temporary/allocation data including allocation table
 * - typeInfo: Type information for reflection
 * - rootTypeName: String containing root type (e.g., "BLP::TextureArchive")
 */
export interface StripeMap {
  resourceLinker: StripeInfo;
  packageBlock: StripeInfo;
  tempData: StripeInfo;
  typeInfo: StripeInfo;
  rootTypeName: StripeInfo;
}

/**
 * Allocation Table Entry (typically 40 bytes)
 * Located in tempData stripe starting at linkerDataOffset
 *
 * VERIFIED fields:
 * - 0x00: stripeIndex (uint64, low byte is actual index)
 * - 0x08: byteOffset (uint32) - offset within the stripe
 * - 0x0C: size (uint32) - size of allocation in bytes
 * - 0x10: elementCount (uint32)
 * - 0x18: userData (uint64)
 * - 0x20: typeNamePtr (uint64) - pointer to type name allocation
 */
export interface AllocationEntry {
  index: number;
  stripeIndex: number;
  byteOffset: number;
  size: number;
  elementCount: number;
  userData: bigint;
  typeNamePtr: bigint;
}

/**
 * TextureEntry allocation data (88 bytes minimum)
 * Found in packageBlock stripe, identified by typeName ending with "TextureEntry"
 *
 * VERIFIED fields:
 * - 0x08: namePtr (uint64) - pointer to texture name string
 * - 0x20: offset (uint64) - offset within BigData section
 * - 0x28: size (uint32) - size of texture data in BigData
 * - 0x40: textureClassPtr (uint64) - pointer to texture class string
 * - 0x48: format (uint16) - DXGI format (e.g., 77 = BC3_UNORM/DXT5)
 * - 0x4C: width (uint16) - original texture width
 * - 0x4E: height (uint16) - original texture height
 * - 0x54: mips (uint8) - total mipmap count in original texture
 * - 0x56: droppedMips (uint8) - number of largest mips not stored
 */
export interface TextureEntry {
  name: string;
  textureClass?: string;
  width: number; // Original dimensions
  height: number;
  mips: number; // Original mipmap count
  droppedMips: number; // Mips not stored (usually 2)
  format: number; // DXGI format
  offset: number; // Offset in BigData section
  size: number; // Size in BigData section
}

/**
 * DXGI Format Constants
 * Subset of formats found in Civ 6 textures
 */
export const DXGI_FORMATS: Record<
  number,
  { name: string; blockBytes?: number; bytesPerPixel?: number }
> = {
  28: { name: 'R8G8B8A8_UNORM', bytesPerPixel: 4 },
  29: { name: 'R8G8B8A8_UNORM_SRGB', bytesPerPixel: 4 },
  71: { name: 'BC1_UNORM', blockBytes: 8 }, // DXT1
  72: { name: 'BC1_UNORM_SRGB', blockBytes: 8 },
  74: { name: 'BC2_UNORM', blockBytes: 16 }, // DXT3
  75: { name: 'BC2_UNORM_SRGB', blockBytes: 16 },
  77: { name: 'BC3_UNORM', blockBytes: 16 }, // DXT5
  78: { name: 'BC3_UNORM_SRGB', blockBytes: 16 },
  80: { name: 'BC4_UNORM', blockBytes: 8 },
  83: { name: 'BC5_UNORM', blockBytes: 16 },
  95: { name: 'BC6H_UF16', blockBytes: 16 },
  98: { name: 'BC7_UNORM', blockBytes: 16 },
  99: { name: 'BC7_UNORM_SRGB', blockBytes: 16 },
};

/**
 * Parse BLP header from buffer
 */
export function parseBLPHeader(buffer: Buffer): BLPHeader {
  const magic = buffer.toString('ascii', 0, 6);
  if (magic !== 'CIVBLP') {
    throw new Error(`Invalid BLP magic: ${magic}`);
  }

  return {
    magic,
    packageDataOffset: buffer.readUInt32LE(0x08),
    packageDataSize: buffer.readUInt32LE(0x0c),
    bigDataOffset: buffer.readUInt32LE(0x10),
    bigDataCount: buffer.readUInt32LE(0x14),
    fileSize: buffer.readUInt32LE(0x18),
  };
}

/**
 * Parse package preamble
 */
export function parsePreamble(buffer: Buffer, offset: number): PackagePreamble {
  return {
    version: buffer.readUInt32LE(offset),
    ptrSize: buffer.readUInt16LE(offset + 4),
    alignment: buffer.readUInt16LE(offset + 6),
    headerSize: buffer.readUInt32LE(offset + 8),
    endian: buffer.readUInt32LE(offset + 12),
  };
}

/**
 * Helper: Read uint64 as bigint
 */
export function readUInt64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

/**
 * Helper: Convert bigint to number safely
 */
export function toNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Pointer value exceeds safe integer range');
  }
  return Number(value);
}
