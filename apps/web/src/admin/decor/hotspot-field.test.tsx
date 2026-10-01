import type { Hotspot, LinkTarget } from '@shop/storefront-blocks/schema';
import { hotspotImageProps } from '@shop/storefront-blocks/schema';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { boxFrom, fitBox, HotspotEditor, MAX_HOTSPOTS, type LinkControl } from './hotspot-field';

// The field runs inside Puck; here only its label wrapper and store hook are needed.
vi.mock('@puckeditor/core', () => ({
  FieldLabel: ({ label, children }: { label: string; children: ReactNode }) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
  createUsePuck: () => () => '',
}));

const IMAGE = 'https://cdn.example.com/banner.jpg';
const link: LinkTarget = { kind: 'product', id: '12' };

/** A stage of 300 × 150 px at the origin, so 3 px = 1 % across and 1.5 px = 1 % down. */
function stubStage() {
  const stage = screen.getByTestId('hotspot-stage');
  stage.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 300, height: 150, right: 300, bottom: 150, x: 0, y: 0 }) as DOMRect;
  return stage;
}

function drag(stage: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(stage, { clientX: from[0], clientY: from[1], pointerId: 1 });
  fireEvent.pointerMove(stage, { clientX: to[0], clientY: to[1], pointerId: 1 });
  fireEvent.pointerUp(stage, { clientX: to[0], clientY: to[1], pointerId: 1 });
}

const renderLink: LinkControl = ({ value, onChange }) => (
  <button type="button" onClick={() => onChange({ kind: 'category', id: '3' })}>
    link:{value ? JSON.stringify(value) : 'none'}
  </button>
);

function Harness({ initial, onValue }: { initial: Hotspot[]; onValue: (next: Hotspot[]) => void }) {
  const [value, setValue] = useState<Hotspot[]>(initial);
  return (
    <HotspotEditor
      field={{ type: 'custom', label: '热区', render: () => null as never }}
      name="hotspots"
      id="hotspots"
      value={value}
      image={IMAGE}
      renderLink={renderLink}
      onChange={(next: Hotspot[] | undefined) => {
        setValue(next ?? []);
        onValue(next ?? []);
      }}
    />
  );
}

describe('the 热区 field', () => {
  it('turns a drag on the picture into a box in percent, inside the picture', () => {
    const onValue = vi.fn();
    render(<Harness initial={[]} onValue={onValue} />);
    // Dragged up-left, and past the right edge: the box is normalised and clamped.
    drag(stubStage(), [330, 120], [150, 30]);
    const [spot] = onValue.mock.lastCall?.[0] as Hotspot[];
    expect(spot).toMatchObject({ x: 50, y: 20, w: 50, h: 60, label: '' });
    // No link is made up: the box waits for one, and until then publishing is refused.
    expect(spot).not.toHaveProperty('link');
    expect(screen.getByText('还没有选择跳转链接，选好之前页面不能发布')).toBeInTheDocument();
    const parsed = hotspotImageProps.safeParse({ image: IMAGE, hotspots: [spot] });
    expect(parsed.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['hotspots.0.link', '请选择跳转链接'],
    ]);
    // With a link picked, the schema accepts what the field made.
    expect(
      hotspotImageProps.safeParse({ image: IMAGE, hotspots: [{ ...spot, link }] }).success,
    ).toBe(true);
    // The new area is selected for editing.
    expect(screen.getByRole('button', { name: '热区 1' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('takes a tiny drag as a tap, not a new area', () => {
    const onValue = vi.fn();
    render(<Harness initial={[]} onValue={onValue} />);
    drag(stubStage(), [100, 100], [102, 101]);
    expect(onValue).not.toHaveBeenCalled();
  });

  it('edits the selected area’s box, keeping it inside, and its link', () => {
    const onValue = vi.fn();
    render(
      <Harness initial={[{ x: 10, y: 10, w: 20, h: 20, label: '', link }]} onValue={onValue} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '热区 1' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '宽' }), { target: { value: '95' } });
    fireEvent.blur(screen.getByRole('spinbutton', { name: '宽' }));
    const [resized] = onValue.mock.lastCall?.[0] as Hotspot[];
    // Width 95 does not fit from x 10: the box moves left to stay inside.
    expect(resized).toMatchObject({ x: 5, w: 95 });

    fireEvent.click(screen.getByText(/^link:/));
    expect((onValue.mock.lastCall?.[0] as Hotspot[])[0]?.link).toEqual({
      kind: 'category',
      id: '3',
    });
  });

  it('deletes the selected area', () => {
    const onValue = vi.fn();
    render(
      <Harness
        initial={[
          { x: 0, y: 0, w: 10, h: 10, label: 'a', link },
          { x: 50, y: 50, w: 10, h: 10, label: 'b', link },
        ]}
        onValue={onValue}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '热区 1' }));
    fireEvent.click(screen.getByRole('button', { name: /删除热区 1/ }));
    expect((onValue.mock.lastCall?.[0] as Hotspot[]).map((spot) => spot.label)).toEqual(['b']);
  });

  it('stops at the most areas the schema allows', () => {
    const onValue = vi.fn();
    const full = Array.from({ length: MAX_HOTSPOTS }, () => ({
      x: 0,
      y: 0,
      w: 5,
      h: 5,
      label: '',
      link,
    }));
    render(<Harness initial={full} onValue={onValue} />);
    drag(stubStage(), [150, 30], [270, 120]);
    expect(onValue).not.toHaveBeenCalled();
    expect(screen.getByText(`最多 ${MAX_HOTSPOTS} 个热区`)).toBeInTheDocument();
  });

  it('asks for the picture first when there is none', () => {
    render(
      <HotspotEditor
        field={{ type: 'custom', label: '热区', render: () => null as never }}
        name="hotspots"
        id="hotspots"
        value={[]}
        image=""
        renderLink={renderLink}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('先选择图片，再在图片上拖出热区')).toBeInTheDocument();
    expect(screen.queryByTestId('hotspot-stage')).toBeNull();
  });
});

describe('hotspot geometry', () => {
  it('normalises two corners into a box', () => {
    expect(boxFrom({ x: 80, y: 90 }, { x: 20, y: 30 })).toEqual({ x: 20, y: 30, w: 60, h: 60 });
    expect(boxFrom({ x: 12.345, y: 0 }, { x: 40.04, y: 10.06 })).toEqual({
      x: 12.3,
      y: 0,
      w: 27.7,
      h: 10.1,
    });
  });

  it('fits an edited box inside the picture', () => {
    expect(fitBox({ x: 90, y: 90, w: 30, h: 0, label: '', link })).toMatchObject({
      x: 70,
      y: 90,
      w: 30,
      h: 1,
    });
  });
});
