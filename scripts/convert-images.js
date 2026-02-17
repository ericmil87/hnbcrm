const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '../public');
const pngFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.png'));

pngFiles.forEach(async (file) => {
  const input = path.join(publicDir, file);
  const output = path.join(publicDir, file.replace('.png', '.webp'));
  await sharp(input).webp({ quality: 85 }).toFile(output);
  console.log(`✓ Converted ${file} to WebP`);
});
