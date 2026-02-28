import fs from 'fs';
import path from 'path';

interface AssetInfo {
  name: string;
  size: number;
  magic?: string;
  patterns: string;
  hasTextureHints: boolean;
}

/**
 * Analyze an extracted asset to understand its structure
 */
function analyzeAsset(filePath: string): AssetInfo {
  const buffer = fs.readFileSync(filePath);
  const name = path.basename(filePath);

  // Try to extract magic bytes
  let magic = '';
  try {
    magic = buffer.toString('ascii', 0, 4);
    // Check if it's printable ASCII
    if (!/^[\x20-\x7E]*$/.test(magic)) {
      magic = '';
    }
  } catch {
    magic = '';
  }

  // Check for texture-like patterns
  // Look for DDS or common image format signatures
  let hasTextureHints = false;
  const ddsSignature = buffer.slice(0, 4).toString('ascii', 0, 4);

  // Check for DDS magic
  if (ddsSignature === 'DDS ') {
    hasTextureHints = true;
  }

  // Analyze byte patterns
  const firstBytes = buffer.slice(0, 16);
  const patterns =
    firstBytes
      .toString('hex')
      .match(/.{1,2}/g)
      ?.join(' ')
      .toUpperCase() || '';

  // Look for repeating patterns (common in structured data)
  const repeatingBytes: Record<string, number> = {};
  for (let i = 0; i < Math.min(256, buffer.length); i++) {
    const byte = buffer[i];
    const key = '0x' + byte.toString(16).padStart(2, '0').toUpperCase();
    repeatingBytes[key] = (repeatingBytes[key] || 0) + 1;
  }

  // Find most common bytes
  const mostCommon = Object.entries(repeatingBytes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([byte]) => byte)
    .join(', ');

  return {
    name,
    size: buffer.length,
    magic: magic || undefined,
    patterns,
    hasTextureHints,
  };
}

/**
 * Analyze all assets in a directory
 */
async function analyzeDirectory(dirPath: string) {
  console.log(
    `\n📊 Analyzing extracted assets from: ${path.basename(dirPath)}\n`,
  );

  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.raw'));

  if (files.length === 0) {
    console.log('No .raw files found');
    return;
  }

  const analyses = files.map((file) => analyzeAsset(path.join(dirPath, file)));

  // Group by size
  const bySize = new Map<number, AssetInfo[]>();
  for (const asset of analyses) {
    const key = asset.size;
    if (!bySize.has(key)) {
      bySize.set(key, []);
    }
    bySize.get(key)!.push(asset);
  }

  // Display summary
  console.log(`Total assets: ${analyses.length}`);
  console.log(`Unique sizes: ${bySize.size}\n`);

  for (const [size, assets] of bySize.entries()) {
    console.log(`Size: ${size} bytes (${assets.length} assets)`);
    console.log(`  First bytes: ${assets[0]!.patterns}`);
    console.log(`  Sample: ${assets[0]!.name}`);

    if (assets.some((a) => a.hasTextureHints)) {
      console.log(`  ✅ Contains potential texture data`);
    }

    console.log('');
  }

  // Look for patterns
  console.log('📝 Data Structure Observations:\n');

  // Check if all have same size (uniform format)
  const sizes = Array.from(bySize.keys());
  if (sizes.length === 1) {
    console.log(
      `✅ All ${analyses.length} assets are ${sizes[0]} bytes (uniform format)`,
    );
    console.log('   This suggests all assets have the same type/structure.\n');
  }

  // Check magic bytes
  const withMagic = analyses.filter((a) => a.magic);
  if (withMagic.length > 0) {
    console.log(`✅ Found ${withMagic.length} assets with ASCII magic bytes:`);
    const magics = new Set(withMagic.map((a) => a.magic));
    for (const m of magics) {
      console.log(`   "${m}"`);
    }
    console.log('');
  }

  // Check for texture hints
  const textured = analyses.filter((a) => a.hasTextureHints);
  if (textured.length > 0) {
    console.log(
      `✅ Found ${textured.length} assets with texture-like patterns`,
    );
    console.log('');
  }

  // Sample detailed analysis
  console.log(`📖 Detailed view of first asset (${analyses[0]!.name}):\n`);
  const firstFile = path.join(dirPath, analyses[0]!.name);
  const buffer = fs.readFileSync(firstFile);

  console.log(`Size: ${buffer.length} bytes`);
  console.log(`First 32 bytes (hex):`);

  const lines = [];
  for (let i = 0; i < Math.min(32, buffer.length); i += 16) {
    const hex = buffer
      .slice(i, i + 16)
      .toString('hex')
      .match(/.{1,2}/g)
      ?.join(' ')
      .toUpperCase();
    const ascii = buffer
      .slice(i, i + 16)
      .toString('ascii')
      .replace(/[^\x20-\x7E]/g, '.');

    console.log(`  0x${i.toString(16).padStart(8, '0')}: ${hex}  ${ascii}`);
  }

  // Look for the second sample to see if there are differences
  if (analyses.length > 1) {
    console.log(
      `\n📖 Detailed view of last asset (${analyses[analyses.length - 1]!.name}):\n`,
    );
    const lastFile = path.join(dirPath, analyses[analyses.length - 1]!.name);
    const lastBuffer = fs.readFileSync(lastFile);

    console.log(`Size: ${lastBuffer.length} bytes`);
    console.log(`First 32 bytes (hex):`);

    for (let i = 0; i < Math.min(32, lastBuffer.length); i += 16) {
      const hex = lastBuffer
        .slice(i, i + 16)
        .toString('hex')
        .match(/.{1,2}/g)
        ?.join(' ')
        .toUpperCase();
      const ascii = lastBuffer
        .slice(i, i + 16)
        .toString('ascii')
        .replace(/[^\x20-\x7E]/g, '.');

      console.log(`  0x${i.toString(16).padStart(8, '0')}: ${hex}  ${ascii}`);
    }
  }
}

/**
 * Main
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: tsx analyze-assets.ts <directory>');
    console.log('\nExample: tsx analyze-assets.ts ./workdir/extracted');
    process.exit(1);
  }

  const dirPath = args[0];

  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    console.error(`Directory not found: ${dirPath}`);
    process.exit(1);
  }

  await analyzeDirectory(dirPath);
}

main().catch(console.error);
