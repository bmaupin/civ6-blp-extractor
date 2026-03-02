import fs from 'fs';
import path from 'path';

interface BLPHeader {
  magic: string;
  packageDataOffset: number;
  packageDataSize: number;
  bigDataOffset: number;
  bigDataCount: number;
  fileSize: number;
}

interface PackagePreamble {
  version: number;
  ptrSize: number;
  alignment: number;
  headerSize: number;
  endian: number;
}

interface StripeInfo {
  start: number;
  size: number;
}

interface PackageHeader {
  stripes: StripeInfo[];
  linkerDataOffset: number;
  packageBlockAlignment: number;
  sizeOfPackageAllocation: number;
}

interface StripeMap {
  resourceLinker: StripeInfo;
  packageBlock: StripeInfo;
  tempData: StripeInfo;
  typeInfo: StripeInfo;
  rootTypeName: StripeInfo;
}

interface AllocationEntry {
  index: number;
  stripeIndex: number;
  byteOffset: number;
  size: number;
  elementCount: number;
  userData: bigint;
  typeNamePtr: bigint;
}

interface TextureEntry {
  name: string;
  textureClass?: string;
  width: number;
  height: number;
  mips: number;
  droppedMips: number;
  format: number;
  offset: number;
  size: number;
}

const DXGI_FORMATS: Record<
  number,
  { name: string; blockBytes?: number; bytesPerPixel?: number }
> = {
  28: { name: 'R8G8B8A8_UNORM', bytesPerPixel: 4 },
  29: { name: 'R8G8B8A8_UNORM_SRGB', bytesPerPixel: 4 },
  71: { name: 'BC1_UNORM', blockBytes: 8 },
  72: { name: 'BC1_UNORM_SRGB', blockBytes: 8 },
  74: { name: 'BC2_UNORM', blockBytes: 16 },
  75: { name: 'BC2_UNORM_SRGB', blockBytes: 16 },
  77: { name: 'BC3_UNORM', blockBytes: 16 },
  78: { name: 'BC3_UNORM_SRGB', blockBytes: 16 },
  80: { name: 'BC4_UNORM', blockBytes: 8 },
  83: { name: 'BC5_UNORM', blockBytes: 16 },
  95: { name: 'BC6H_UF16', blockBytes: 16 },
  98: { name: 'BC7_UNORM', blockBytes: 16 },
  99: { name: 'BC7_UNORM_SRGB', blockBytes: 16 },
};

function parseBLPHeader(buffer: Buffer): BLPHeader {
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

function parsePreamble(buffer: Buffer, offset: number): PackagePreamble {
  return {
    version: buffer.readUInt32LE(offset),
    ptrSize: buffer.readUInt16LE(offset + 4),
    alignment: buffer.readUInt16LE(offset + 6),
    headerSize: buffer.readUInt32LE(offset + 8),
    endian: buffer.readUInt32LE(offset + 12),
  };
}

function parseStripeInfo(buffer: Buffer, offset: number): StripeInfo {
  return {
    start: buffer.readUInt32LE(offset),
    size: buffer.readUInt32LE(offset + 4),
  };
}

function parsePackageHeader(
  packageData: Buffer,
  preambleOffset: number,
): PackageHeader {
  const headerOffset = preambleOffset + 16;
  const stripes: StripeInfo[] = [];

  for (let i = 0; i < 5; i++) {
    stripes.push(parseStripeInfo(packageData, headerOffset + i * 8));
  }

  const linkerDataOffset = packageData.readUInt32LE(headerOffset + 40);
  const packageBlockAlignment = packageData.readUInt32LE(headerOffset + 56);
  const sizeOfPackageAllocation = packageData.readUInt32LE(headerOffset + 64);

  return {
    stripes,
    linkerDataOffset,
    packageBlockAlignment,
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

function readUInt64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

function toNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Pointer value exceeds safe integer range');
  }
  return Number(value);
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
  const textureClassPtr = readUInt64LE(data, 64);
  const textureClass = readStringFromPtr(
    textureClassPtr,
    allocations,
    packageData,
    stripeMap,
  );

  const offset = Number(readUInt64LE(data, 32));
  const size = data.readUInt32LE(40);
  const format = data.readUInt16LE(72);
  const width = data.readUInt16LE(76);
  const height = data.readUInt16LE(78);
  const mips = data.readUInt8(84);
  const droppedMips = data.readUInt8(86);

  return {
    name,
    textureClass: textureClass || undefined,
    width,
    height,
    mips,
    droppedMips,
    format,
    offset,
    size,
  };
}

function computeTextureSize(
  width: number,
  height: number,
  mipCount: number,
  blockBytes?: number,
  bytesPerPixel?: number,
): number {
  let total = 0;
  let w = width;
  let h = height;

  for (let mip = 0; mip < mipCount; mip++) {
    const mw = Math.max(1, w >> mip);
    const mh = Math.max(1, h >> mip);

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

function buildDDSHeaderDX10(
  width: number,
  height: number,
  mipCount: number,
  dxgiFormat: number,
  blockBytes?: number,
  bytesPerPixel?: number,
): Buffer {
  const header = Buffer.alloc(148, 0);
  header.write('DDS ', 0, 4, 'ascii');
  header.writeUInt32LE(124, 4);

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
  header.writeUInt32LE(height, 12);
  header.writeUInt32LE(width, 16);

  if (blockBytes) {
    const topSize =
      Math.max(1, Math.ceil(width / 4)) *
      Math.max(1, Math.ceil(height / 4)) *
      blockBytes;
    header.writeUInt32LE(topSize, 20);
  } else if (bytesPerPixel) {
    header.writeUInt32LE(width * bytesPerPixel, 20);
  }

  header.writeUInt32LE(mipCount, 28);

  header.writeUInt32LE(32, 76);
  header.writeUInt32LE(0x4, 80);
  header.write('DX10', 84, 4, 'ascii');

  const DDSCAPS_TEXTURE = 0x1000;
  const DDSCAPS_COMPLEX = 0x8;
  const DDSCAPS_MIPMAP = 0x400000;
  let caps = DDSCAPS_TEXTURE;
  if (mipCount > 1) {
    caps |= DDSCAPS_COMPLEX | DDSCAPS_MIPMAP;
  }
  header.writeUInt32LE(caps, 108);

  // DDS_HEADER_DXT10 (20 bytes)
  header.writeUInt32LE(dxgiFormat, 128);
  header.writeUInt32LE(3, 132); // D3D10_RESOURCE_DIMENSION_TEXTURE2D
  header.writeUInt32LE(0, 136); // miscFlag
  header.writeUInt32LE(1, 140); // array size
  header.writeUInt32LE(0, 144); // miscFlags2

  return header;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('Usage: tsx extract-textures.ts <blp-file> [output-dir]');
    process.exit(1);
  }

  const blpPath = args[0];
  const outputDir = args[1] || './textures';

  if (!fs.existsSync(blpPath)) {
    console.error(`File not found: ${blpPath}`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(blpPath);
  const header = parseBLPHeader(buffer);

  const packageData = buffer.subarray(
    header.packageDataOffset,
    header.packageDataOffset + header.packageDataSize,
  );

  const preamble = parsePreamble(packageData, 0);
  const packageHeader = parsePackageHeader(packageData, 0);
  const stripeMap = chooseStripeMap(packageData, packageHeader.stripes);

  const allocations = parseAllocationTable(
    packageData,
    stripeMap,
    packageHeader.linkerDataOffset,
    packageHeader.sizeOfPackageAllocation || 40,
  );

  if (allocations.length === 0) {
    console.error(
      'No allocation entries found; cannot resolve texture metadata.',
    );
    process.exit(1);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const textures: TextureEntry[] = [];
  for (const alloc of allocations) {
    const typeName = getTypeName(alloc, allocations, packageData, stripeMap);
    if (!typeName) {
      continue;
    }
    if (typeName.endsWith('TextureEntry')) {
      const entry = readTextureEntry(
        alloc,
        allocations,
        packageData,
        stripeMap,
      );
      if (entry) {
        textures.push(entry);
      }
    }
  }

  console.log(`Found ${textures.length} texture entries.`);
  console.log(
    `Preamble version: ${preamble.version}, headerSize: ${preamble.headerSize}`,
  );

  if (header.bigDataOffset === 0) {
    console.error('This BLP has no embedded BigData section.');
    process.exit(1);
  }

  const nameCounts = new Map<string, number>();
  let extracted = 0;

  for (const entry of textures) {
    const formatInfo = DXGI_FORMATS[entry.format];
    const blockBytes = formatInfo?.blockBytes;
    const bytesPerPixel = formatInfo?.bytesPerPixel;

    const effectiveWidth = Math.max(1, entry.width >> entry.droppedMips);
    const effectiveHeight = Math.max(1, entry.height >> entry.droppedMips);
    const storedMips = Math.max(1, entry.mips - entry.droppedMips);

    const expectedSize = computeTextureSize(
      effectiveWidth,
      effectiveHeight,
      storedMips,
      blockBytes,
      bytesPerPixel,
    );

    // Texture metadata offset points directly to BC3 payload start
    // No prefix skipping needed; entry.offset is the direct offset
    const payloadStart = header.bigDataOffset + entry.offset;
    const payloadEnd = payloadStart + entry.size;

    if (payloadEnd > buffer.length) {
      continue;
    }

    const payload = buffer.subarray(payloadStart, payloadEnd);

    const safeName = sanitizeName(entry.name || `texture_${extracted}`);
    const baseName = safeName.length > 0 ? safeName : `texture_${extracted}`;
    const count = (nameCounts.get(baseName) || 0) + 1;
    nameCounts.set(baseName, count);
    const fileName = count > 1 ? `${baseName}_${count}.dds` : `${baseName}.dds`;

    const dxgi = entry.format;
    const headerDDS = buildDDSHeaderDX10(
      effectiveWidth,
      effectiveHeight,
      storedMips,
      dxgi,
      blockBytes,
      bytesPerPixel,
    );

    fs.writeFileSync(
      path.join(outputDir, fileName),
      Buffer.concat([headerDDS, payload]),
    );
    extracted++;
  }

  console.log(`Extracted ${extracted} textures to ${outputDir}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
