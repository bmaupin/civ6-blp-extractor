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

interface BigDataEntry {
  index: number;
  offset: number;
  size: number;
  isCompressed: boolean;
  name?: string;
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
 * Try to detect CIVBIG containers within BigData section
 * CIVBIG format: "CIVBIG" (6 bytes) + fields
 */
function findCIVBIGContainers(
  buffer: Buffer,
  startOffset: number,
  endOffset: number,
): number[] {
  const civbigOffsets: number[] = [];
  const civbigMagic = Buffer.from('CIVBIG');

  for (let i = startOffset; i < endOffset - 6; i++) {
    if (buffer.compare(civbigMagic, 0, 6, i, i + 6) === 0) {
      civbigOffsets.push(i);
    }
  }

  return civbigOffsets;
}

/**
 * Extract BigData entries from BLP
 * For Civ 6, data is in unknown format (not DDS), so we extract raw chunks
 * Strategy: Divide remaining space equally among bigDataCount entries
 */
function extractBigDataEntries(
  buffer: Buffer,
  header: BLPHeader,
): BigDataEntry[] {
  const entries: BigDataEntry[] = [];

  if (header.bigDataCount === 0) {
    return entries;
  }

  // BigData section starts at bigDataOffset
  const bigDataStart = header.bigDataOffset;
  const bigDataEnd = buffer.length;
  const bigDataSize = bigDataEnd - bigDataStart;

  // Try to find CIVBIG containers first
  const civbigOffsets = findCIVBIGContainers(buffer, bigDataStart, bigDataEnd);

  if (
    civbigOffsets.length > 0 &&
    civbigOffsets.length === header.bigDataCount
  ) {
    // We found CIVBIG containers matching the count - use them!
    console.log(`✅ Found ${civbigOffsets.length} CIVBIG containers`);

    for (let i = 0; i < civbigOffsets.length; i++) {
      const offset = civbigOffsets[i];
      const nextOffset =
        i < civbigOffsets.length - 1 ? civbigOffsets[i + 1] : bigDataEnd;
      const size = nextOffset - offset;

      entries.push({
        index: i,
        offset,
        size,
        isCompressed: false,
        name: `asset_${i.toString().padStart(2, '0')}.civbig`,
      });
    }
  } else {
    // Fall back to equal division of BigData section
    const entrySize = Math.floor(bigDataSize / header.bigDataCount);

    for (let i = 0; i < header.bigDataCount; i++) {
      const offset = bigDataStart + i * entrySize;
      const nextOffset =
        i === header.bigDataCount - 1
          ? bigDataEnd
          : bigDataStart + (i + 1) * entrySize;
      const size = nextOffset - offset;

      entries.push({
        index: i,
        offset,
        size,
        isCompressed: false,
        name: `asset_${i.toString().padStart(2, '0')}.raw`,
      });
    }
  }

  return entries;
}

/**
 * Extract a single asset from BLP
 */
function extractAsset(
  buffer: Buffer,
  entry: BigDataEntry,
  outputPath: string,
  oozPath?: string,
): boolean {
  try {
    const assetData = buffer.slice(entry.offset, entry.offset + entry.size);

    // Check if this is a CIVBIG container
    const magic = assetData.toString('ascii', 0, Math.min(6, assetData.length));

    if (magic === 'CIVBIG') {
      console.log(`  📦 Asset ${entry.name} is a CIVBIG container`);

      // Parse CIVBIG header
      if (assetData.length < 16) {
        console.log(`     ⚠️  CIVBIG header incomplete, saving raw`);
        fs.writeFileSync(outputPath, assetData);
        return true;
      }

      const payloadSize = assetData.readUInt32LE(0x08);
      const dataOffset = assetData.readUInt16LE(0x0c);
      const typeFlag = assetData.readUInt16LE(0x0e);
      const isCompressed =
        assetData.length > dataOffset && assetData[dataOffset] === 0x8c;

      const typeNames: Record<number, string> = {
        0: 'GPU Buffer',
        1: 'Texture (DDS)',
        2: 'Blob',
        3: 'Sound Bank',
      };
      const typeName = typeNames[typeFlag] || `Unknown (${typeFlag})`;

      console.log(
        `     Type: ${typeName}, Payload: ${payloadSize} bytes, Compressed: ${isCompressed}`,
      );

      if (isCompressed) {
        if (!oozPath) {
          console.log(
            `     ⚠️  Compressed - need ooz decompressor, saving CIVBIG`,
          );
          fs.writeFileSync(outputPath, assetData);
          return true;
        }

        // Extract just the payload
        const payload = assetData.slice(dataOffset);
        const tempCompressed = `${outputPath}.oodle`;
        fs.writeFileSync(tempCompressed, payload);

        try {
          execSync(`"${oozPath}" "${tempCompressed}" "${outputPath}"`, {
            stdio: 'pipe',
          });
          fs.unlinkSync(tempCompressed);
          console.log(`     ✅ Decompressed to ${path.basename(outputPath)}`);
          return true;
        } catch (error) {
          console.log(`     ❌ Decompression failed`);
          fs.unlinkSync(tempCompressed);
          // Save CIVBIG anyway
          fs.writeFileSync(outputPath, assetData);
          return true;
        }
      } else {
        // Extract uncompressed payload
        const payload = assetData.slice(dataOffset, dataOffset + payloadSize);
        fs.writeFileSync(outputPath, payload);
        console.log(`     ✅ Extracted ${payload.length} byte payload`);
        return true;
      }
    } else {
      // Raw data - just write it
      fs.writeFileSync(outputPath, assetData);
      console.log(`  ✅ Extracted ${entry.name} (${entry.size} bytes)`);
      return true;
    }
  } catch (error) {
    console.error(`  ❌ Failed to extract ${entry.name}: ${error}`);
    return false;
  }
}

/**
 * Main extraction function
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: tsx extract-blp.ts <blp-file> [output-dir] [ooz-path]');
    console.log(
      '\nExample: tsx extract-blp.ts strategicview_terraintypes.blp ./output',
    );
    console.log(
      '\nWith ooz: tsx extract-blp.ts file.blp ./output /path/to/ooz',
    );
    process.exit(1);
  }

  const blpPath = args[0];
  const outputDir = args[1] || './extracted';
  const oozPath = args[2];

  if (!fs.existsSync(blpPath)) {
    console.error(`File not found: ${blpPath}`);
    process.exit(1);
  }

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`\n📦 Extracting BLP: ${path.basename(blpPath)}\n`);

  // Read and parse BLP
  const buffer = fs.readFileSync(blpPath);
  const header = parseBLPHeader(buffer);

  console.log(`Found ${header.bigDataCount} embedded assets\n`);

  if (header.bigDataCount === 0) {
    console.log(
      '⚠️  This BLP has no embedded data (uses external CIVBIG files)',
    );
    console.log('   External extraction not yet implemented.');
    process.exit(1);
  }

  // Extract BigData entries
  const entries = extractBigDataEntries(buffer, header);

  console.log(`Extracting ${entries.length} assets to: ${outputDir}\n`);

  let successCount = 0;
  for (const entry of entries) {
    // Output filename based on asset type
    const outputPath = path.join(outputDir, entry.name);
    if (extractAsset(buffer, entry, outputPath, oozPath)) {
      successCount++;
    }
  }

  console.log(
    `\n✨ Extraction complete! ${successCount}/${entries.length} assets extracted successfully.`,
  );

  if (successCount < entries.length) {
    console.log(
      '\n💡 Some assets may require Oodle decompression. Build ooz from:',
    );
    console.log('   https://github.com/baconwaifu/ooz');
  }
}

main().catch(console.error);
