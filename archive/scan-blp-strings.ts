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

interface StripeInfo {
  start: number;
  size: number;
}

interface PackageHeader {
  resourceLinker: StripeInfo;
  packageBlock: StripeInfo;
  tempData: StripeInfo;
  typeInfo: StripeInfo;
  rootTypeName: StripeInfo;
  linkerDataOffset: number;
  resourceListOffset: number;
  largestResource: number;
  secondLargestResource: number;
  packageBlockAlignment: number;
  sizeOfTypeInfoStripe: number;
  sizeOfPackageAllocation: number;
  sizeOfResourceAllocationDesc: number;
}

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
  let cursor = headerOffset;

  const resourceLinker = parseStripeInfo(packageData, cursor);
  cursor += 8;
  const packageBlock = parseStripeInfo(packageData, cursor);
  cursor += 8;
  const tempData = parseStripeInfo(packageData, cursor);
  cursor += 8;
  const typeInfo = parseStripeInfo(packageData, cursor);
  cursor += 8;
  const rootTypeName = parseStripeInfo(packageData, cursor);
  cursor += 8;

  const linkerDataOffset = packageData.readUInt32LE(cursor);
  cursor += 4;
  const resourceListOffset = packageData.readUInt32LE(cursor);
  cursor += 4;
  const largestResource = packageData.readUInt32LE(cursor);
  cursor += 4;
  const secondLargestResource = packageData.readUInt32LE(cursor);
  cursor += 4;
  const packageBlockAlignment = packageData.readUInt32LE(cursor);
  cursor += 4;
  const sizeOfTypeInfoStripe = packageData.readUInt32LE(cursor);
  cursor += 4;
  const sizeOfPackageAllocation = packageData.readUInt32LE(cursor);
  cursor += 4;
  const sizeOfResourceAllocationDesc = packageData.readUInt32LE(cursor);

  return {
    resourceLinker,
    packageBlock,
    tempData,
    typeInfo,
    rootTypeName,
    linkerDataOffset,
    resourceListOffset,
    largestResource,
    secondLargestResource,
    packageBlockAlignment,
    sizeOfTypeInfoStripe,
    sizeOfPackageAllocation,
    sizeOfResourceAllocationDesc,
  };
}

function extractAsciiStrings(buffer: Buffer, minLength = 4): string[] {
  const results = new Set<string>();
  let current = '';

  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte >= 0x20 && byte <= 0x7e) {
      current += String.fromCharCode(byte);
      continue;
    }

    if (current.length >= minLength) {
      results.add(current);
    }
    current = '';
  }

  if (current.length >= minLength) {
    results.add(current);
  }

  return Array.from(results).sort();
}

function sliceStripe(packageData: Buffer, stripe: StripeInfo): Buffer {
  const start = stripe.start;
  const end = stripe.start + stripe.size;
  if (start < 0 || end > packageData.length) {
    return Buffer.alloc(0);
  }
  return packageData.subarray(start, end);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('Usage: tsx scan-blp-strings.ts <blp-file> [min-length]');
    process.exit(1);
  }

  const blpPath = args[0];
  const minLength = args[1] ? Number(args[1]) : 5;

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

  const packageHeader = parsePackageHeader(packageData, 0);

  const stripes: Array<{ name: string; data: Buffer }> = [
    {
      name: 'packageBlock',
      data: sliceStripe(packageData, packageHeader.packageBlock),
    },
    {
      name: 'tempData',
      data: sliceStripe(packageData, packageHeader.tempData),
    },
    {
      name: 'typeInfo',
      data: sliceStripe(packageData, packageHeader.typeInfo),
    },
    {
      name: 'resourceLinker',
      data: sliceStripe(packageData, packageHeader.resourceLinker),
    },
  ];

  console.log(`\nBLP: ${path.basename(blpPath)}`);
  console.log(`Package data size: ${header.packageDataSize} bytes`);
  console.log(`Min string length: ${minLength}`);
  console.log('\nStripe sizes:');
  console.log(`  packageBlock: ${packageHeader.packageBlock.size}`);
  console.log(`  tempData: ${packageHeader.tempData.size}`);
  console.log(`  typeInfo: ${packageHeader.typeInfo.size}`);
  console.log(`  resourceLinker: ${packageHeader.resourceLinker.size}`);

  let totalStrings = 0;
  for (const stripe of stripes) {
    if (stripe.data.length === 0) {
      continue;
    }
    const strings = extractAsciiStrings(stripe.data, minLength);
    totalStrings += strings.length;
    console.log(`\n[${stripe.name}] strings: ${strings.length}`);
    for (const value of strings) {
      console.log(value);
    }
  }

  if (totalStrings === 0) {
    const allStrings = extractAsciiStrings(packageData, minLength);
    console.log(`\n[packageData fallback] strings: ${allStrings.length}`);
    for (const value of allStrings) {
      console.log(value);
    }
  }
}

main().catch(console.error);
