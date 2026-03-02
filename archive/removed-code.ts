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
} from '../blp-format';

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

/**
 * Parse metadata functions to extract texture names
 */
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
