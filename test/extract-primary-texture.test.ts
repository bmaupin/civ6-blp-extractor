/**
 * Regression tests for exact DDS extraction from known Civ 6 BLP files.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractTextureByName } from '../extract-primary-texture.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const outputDir = '/tmp/civ6-blp-extractor/test-output';

function readFile(filePath: string): Buffer {
  assert.ok(fs.existsSync(filePath), `Missing file: ${filePath}`);
  return fs.readFileSync(filePath);
}

function getDdsPayload(dds: Buffer): Buffer {
  assert.ok(dds.length >= 128, 'DDS file too small to contain a header');

  const fourCC = dds.subarray(84, 88).toString('ascii');
  const headerSize = fourCC === 'DX10' ? 148 : 128;

  assert.ok(dds.length >= headerSize, 'DDS file shorter than declared header');
  return dds.subarray(headerSize);
}

function runExactMatchExtractionTest(
  sourceBlpRelativePath: string,
  textureName: string,
  referenceRelativePath: string,
) {
  const sourceBlpPath = path.resolve(projectRoot, sourceBlpRelativePath);
  const referencePath = path.resolve(projectRoot, referenceRelativePath);

  const result = extractTextureByName(sourceBlpPath, textureName, outputDir);
  const extractedPath = result.outputPath;
  const extracted = readFile(extractedPath);
  const reference = readFile(referencePath);

  const extractedPayload = getDdsPayload(extracted);
  const referencePayload = getDdsPayload(reference);

  assert.equal(
    extractedPayload.length,
    referencePayload.length,
    `Payload size mismatch for ${textureName}`,
  );
  assert.ok(
    extractedPayload.equals(referencePayload),
    `Texture payload mismatch for ${textureName}`,
  );
}

test.before(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
});

test.after(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
});

test('extracts SV_TerrainMountain_Tundra_FOW_06 payload as exact match', () => {
  runExactMatchExtractionTest(
    'workdir/terrainsprites/strategicview_terrainsprites.blp',
    'SV_TerrainMountain_Tundra_FOW_06',
    'workdir/testdata/SV_TerrainMountain_Tundra_FOW_06.dds',
  );
});

test('extracts SV_TerrainHexGrasslands_Color payload as exact match', () => {
  runExactMatchExtractionTest(
    'workdir/terraintypes/strategicview_terraintypes.blp',
    'SV_TerrainHexGrasslands_Color',
    'workdir/testdata/SV_TerrainHexGrasslands_Color.dds',
  );
});
