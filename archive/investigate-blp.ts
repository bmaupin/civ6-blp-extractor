import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

interface BLPHeader {
  magic: string;
  packageDataOffset: number;
  packageDataSize: number;
  bigDataOffset: number;
  bigDataCount: number;
  fileSize: number;
}

interface CIVBIGHeader {
  magic: string;
  payloadSize: number;
  dataOffset: number;
  typeFlag: number;
  isCompressed: boolean;
}

/**
 * Parse BLP file header (first 1024 bytes)
 */
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

/**
 * Parse CIVBIG file header (first 16 bytes)
 */
function parseCIVBIGHeader(buffer: Buffer): CIVBIGHeader {
  const magic = buffer.toString('ascii', 0, 6);
  
  if (magic !== 'CIVBIG') {
    throw new Error(`Invalid CIVBIG magic: ${magic}`);
  }

  const payloadSize = buffer.readUInt32LE(0x08);
  const dataOffset = buffer.readUInt16LE(0x0c);
  const typeFlag = buffer.readUInt16LE(0x0e);
  
  // Check if payload is Oodle compressed (signature 0x8C)
  const isCompressed = buffer.length > dataOffset && buffer[dataOffset] === 0x8c;

  return {
    magic,
    payloadSize,
    dataOffset,
    typeFlag,
    isCompressed,
  };
}

/**
 * Get type name from flag
 */
function getTypeNameFromFlag(flag: number): string {
  const types: Record<number, string> = {
    0: 'GPU Buffer',
    1: 'Texture (DDS)',
    2: 'Blob',
    3: 'Sound Bank',
  };
  return types[flag] || `Unknown (${flag})`;
}

/**
 * Investigate a BLP file
 */
async function investigateBLP(blpPath: string) {
  console.log(`\n📦 Investigating BLP: ${blpPath}\n`);

  try {
    const blpBuffer = fs.readFileSync(blpPath);
    const header = parseBLPHeader(blpBuffer);

    console.log('BLP Header:');
    console.log(`  Magic: ${header.magic}`);
    console.log(`  File size: ${header.fileSize} bytes`);
    console.log(`  Package data offset: 0x${header.packageDataOffset.toString(16)}`);
    console.log(`  Package data size: ${header.packageDataSize} bytes`);
    console.log(`  BigData offset: ${header.bigDataOffset} (${header.bigDataCount} entries)`);
    console.log(`  Embedded data: ${header.bigDataCount > 0 ? 'YES' : 'NO'}`);

    // Check if this BLP has BigData (embedded assets)
    if (header.bigDataCount > 0) {
      console.log(
        `\n✅ This BLP contains ${header.bigDataCount} embedded asset(s).`
      );
      console.log('   You can extract directly from this file without SHARED_DATA.');
    } else {
      console.log(
        `\n⚠️  This BLP references external CIVBIG files in SHARED_DATA.`
      );
      console.log('   Need to locate SHARED_DATA directory to extract assets.');
    }
  } catch (error) {
    console.error(`Error reading BLP: ${error}`);
  }
}

/**
 * Investigate a CIVBIG file
 */
async function investigateCIVBIG(civbigPath: string) {
  console.log(`\n📦 Investigating CIVBIG: ${path.basename(civbigPath)}\n`);

  try {
    const civbigBuffer = fs.readFileSync(civbigPath);
    const header = parseCIVBIGHeader(civbigBuffer);

    console.log('CIVBIG Header:');
    console.log(`  Magic: ${header.magic}`);
    console.log(`  Payload size: ${header.payloadSize} bytes`);
    console.log(`  Data offset: 0x${header.dataOffset.toString(16)}`);
    console.log(`  Type: ${getTypeNameFromFlag(header.typeFlag)}`);
    console.log(`  Compression: ${header.isCompressed ? 'YES (Oodle Kraken)' : 'NO (raw data)'}`);

    // Show first bytes of payload
    if (header.isCompressed) {
      console.log(`\n⚠️  Payload is compressed with Oodle Kraken (0x8C signature detected).`);
      console.log('   You will need the ooz tool to decompress.');
      console.log(`   Compressed size: ${header.payloadSize} bytes`);
    } else {
      console.log(`\n✅ Payload is raw/uncompressed.`);
      console.log(`   Raw size: ${header.payloadSize} bytes`);
      
      if (header.typeFlag === 1) {
        console.log('   This is a DDS texture - can be extracted directly!');
      }
    }

    // Peek at raw data
    const payloadStart = header.dataOffset;
    const previewEnd = Math.min(payloadStart + 32, civbigBuffer.length);
    const previewBytes = civbigBuffer.slice(payloadStart, previewEnd);
    console.log(
      `\n  Payload preview (hex): ${previewBytes.toString('hex').substring(0, 64)}...`
    );
  } catch (error) {
    console.error(`Error reading CIVBIG: ${error}`);
  }
}

/**
 * Find SHARED_DATA directory for a BLP
 */
function findSharedData(blpPath: string): string | null {
  const blpDir = path.dirname(blpPath);
  const sharedDataPath = path.join(blpDir, 'SHARED_DATA');

  if (fs.existsSync(sharedDataPath)) {
    return sharedDataPath;
  }

  return null;
}

/**
 * Main investigation flow
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: ts-node investigate-blp.ts <blp-file>');
    console.log(
      '\nExample: ts-node investigate-blp.ts /path/to/strategicview_terraintypes.blp'
    );
    process.exit(1);
  }

  const blpPath = args[0];

  if (!fs.existsSync(blpPath)) {
    console.error(`File not found: ${blpPath}`);
    process.exit(1);
  }

  await investigateBLP(blpPath);

  // Try to find SHARED_DATA
  const sharedDataPath = findSharedData(blpPath);
  if (sharedDataPath) {
    console.log(`\n🔍 Found SHARED_DATA at: ${sharedDataPath}`);
    
    // List first few CIVBIG files
    const files = fs.readdirSync(sharedDataPath).slice(0, 3);
    if (files.length > 0) {
      console.log(`   Found ${fs.readdirSync(sharedDataPath).length} assets total.\n`);
      console.log('   Inspecting first asset...');
      await investigateCIVBIG(path.join(sharedDataPath, files[0]));
    }
  }

  console.log('\n✨ Investigation complete!');
}

main().catch(console.error);
