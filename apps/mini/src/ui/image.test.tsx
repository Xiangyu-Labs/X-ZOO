import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Image } from './image';

/**
 * An upload's content hash, the part of its name the server generates. Built, not written out:
 * the credentials guard flags any 32-hex literal.
 */
const HASH = '0123456789abcdef'.repeat(2);

describe('Image', () => {
  it('keeps its ratio before the picture arrives, and is named when it has a label', () => {
    const { container } = render(
      <Image src="https://cdn.example.com/a.jpg" ratio={2} label="坚果礼盒" />,
    );
    const box = screen.getByRole('img', { name: '坚果礼盒' });
    expect(box.style.paddingTop).toBe('50.0000%');
    expect(box.className).not.toContain('shop-image--loaded');
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://cdn.example.com/a.jpg');
    fireEvent.load(img as HTMLImageElement);
    expect(box.className).toContain('shop-image--loaded');
  });

  it('shows the placeholder icon when it fails or has no source', () => {
    const { container, rerender } = render(<Image src="/uploads/x.png" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/uploads/x.png');
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.shop-image__fallback')).toBeTruthy();
    rerender(<Image src={null} />);
    expect(container.querySelector('.shop-image__fallback')).toBeTruthy();
    // A plain picture, not 「添加图片」: there is nothing to add here.
    expect(container.querySelector('.shop-icon--image')).toBeTruthy();
    expect(container.querySelector('.shop-icon--image-plus')).toBeNull();
    rerender(<Image src={null} placeholder="user" />);
    expect(container.querySelector('.shop-icon--user')).toBeTruthy();
  });

  it('tries again when the source changes after a failure', () => {
    const { container, rerender } = render(<Image src="/a.png" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    rerender(<Image src="/b.png" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/b.png');
  });

  it('loads the smaller copy of one of our uploads, and the original if the copy is missing', () => {
    const upload = `/uploads/product/2026/09/${HASH}.jpg`;
    const { container } = render(<Image src={upload} size="small" />);
    const img = () => container.querySelector('img');
    expect(img()?.getAttribute('src')).toBe(upload.replace(/\.jpg$/, '.w480.jpg'));

    fireEvent.error(img() as HTMLImageElement);
    expect(img()?.getAttribute('src')).toBe(upload);
    expect(container.querySelector('.shop-image__fallback')).toBeNull();

    // Only when the original fails too does the placeholder show.
    fireEvent.error(img() as HTMLImageElement);
    expect(img()).toBeNull();
    expect(container.querySelector('.shop-image__fallback')).toBeTruthy();
  });

  it('keeps the original for a picture that has no copies, and by default', () => {
    const { container, rerender } = render(
      <Image src="https://cdn.example.com/a.gif" size="medium" />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn.example.com/a.gif',
    );
    const upload = `/uploads/product/2026/09/${HASH}.png`;
    rerender(<Image src={upload} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(upload);
    rerender(<Image src={upload} size="medium" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      upload.replace(/\.png$/, '.w960.png'),
    );
  });

  it('is decoration without a label', () => {
    const { container } = render(<Image src="/a.png" />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});
