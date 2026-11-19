import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ArgusReceiptProcessor } from '../src/services/ArgusReceiptProcessor';

describe('ArgusReceiptProcessor.stackImagesVertically', () => {
  const processor = new ArgusReceiptProcessor();

  it('stacks two receipt images vertically into a single JPEG preserving combined height', async () => {
    const part1 = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 240, g: 240, b: 240 } }
    })
      .jpeg()
      .toBuffer();

    const part2 = await sharp({
      create: { width: 400, height: 250, channels: 3, background: { r: 220, g: 220, b: 220 } }
    })
      .jpeg()
      .toBuffer();

    const stacked = await processor.stackImagesVertically([part1, part2]);
    const meta = await sharp(stacked).metadata();

    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(550);
  });
});
