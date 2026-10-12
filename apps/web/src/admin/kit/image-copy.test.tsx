import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CopyImage, imageCopyUrl } from './image-copy';

const upload = '/uploads/attachment/2026/09/7ed95361155e472f887737717db125cc.png';

describe('imageCopyUrl', () => {
  it('names the server’s smaller copy of one of our uploads', () => {
    expect(imageCopyUrl(upload, 480)).toBe(
      '/uploads/attachment/2026/09/7ed95361155e472f887737717db125cc.w480.png',
    );
    expect(imageCopyUrl(upload, 960)).toMatch(/\.w960\.png$/);
  });

  it('names the copy of a picture the old system stored, a day directory deeper', () => {
    expect(
      imageCopyUrl('/uploads/attach/2026/09/20260915/34fd353d2738c9ff2743bfc93125aba5.jpg', 960),
    ).toBe('/uploads/attach/2026/09/20260915/34fd353d2738c9ff2743bfc93125aba5.w960.jpg');
  });

  it('leaves a picture with no copies as it is', () => {
    const gif = '/uploads/attachment/2026/09/7ed95361155e472f887737717db125cc.gif';
    expect(imageCopyUrl(gif, 480)).toBe(gif);
    expect(imageCopyUrl('data:image/svg+xml;utf8,<svg/>', 480)).toBe(
      'data:image/svg+xml;utf8,<svg/>',
    );
  });
});

describe('CopyImage', () => {
  it('loads the copy, and the original when the copy is missing', () => {
    render(<CopyImage src={upload} alt="图" />);
    const img = screen.getByAltText('图');
    expect(img).toHaveAttribute('src', expect.stringMatching(/\.w480\.png$/));
    fireEvent.error(img);
    expect(img).toHaveAttribute('src', upload);
  });
});
