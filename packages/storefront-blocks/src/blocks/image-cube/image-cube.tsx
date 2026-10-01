import { View } from '@tarojs/components';

import type { LinkTarget } from '@shop/contracts/decor/link';
import { IMAGE_CUBE_LAYOUTS, type ImageCubeLayout } from '@shop/contracts/decor/constants';
import type { ImageCubeProps } from '@shop/contracts/decor/all-blocks';
import { BlockImage } from '../shared/block-image';
import { cx, designVars, tapProps } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import type { BlockHost, BlockProps } from '../shared/types';
import styles from './image-cube.module.scss';

type Cell = ImageCubeProps['cells'][number] | undefined;

interface CellProps {
  cell: Cell;
  className?: string | undefined;
  onLink: ((target: LinkTarget) => void) | undefined;
  host: BlockHost | undefined;
}

function tap(cell: Cell, onLink: CellProps['onLink']) {
  const link = cell?.link;
  return link && onLink ? () => onLink(link) : undefined;
}

/**
 * A composite-layout cell: fills its box. An unset cell is an empty grey box.
 * The box has its size before the picture arrives, so it loads lazily.
 */
function BoxCell({ cell, className, onLink, host }: CellProps) {
  return (
    <View className={cx(styles.cell, className)} {...tapProps(tap(cell, onLink))}>
      {cell ? (
        <BlockImage
          className={styles.fill}
          src={cell.image}
          width={960}
          resolve={host?.resolveImage}
          mode="aspectFill"
          lazyLoad={!host?.canvas}
        />
      ) : null}
    </View>
  );
}

const ROWS: Partial<Record<ImageCubeLayout, true>> = { row2: true, row3: true, row4: true };

/**
 * 图片魔方: two to four pictures in one of six layouts, each with its own link.
 *
 * Row layouts size each picture by its own ratio (`widthFix`); they load
 * lazily too — WeChat starts them a few screens ahead, so the row reaches its
 * height before it scrolls into view.
 */
export function ImageCube({ props, onLink, host }: BlockProps<ImageCubeProps>) {
  const count = IMAGE_CUBE_LAYOUTS[props.layout].cells;
  const cells: Cell[] = Array.from({ length: count }, (_unused, index) => props.cells[index]);
  const [a, b, c, d] = cells;

  if (ROWS[props.layout]) {
    return (
      <BlockFrame type="imageCube" frame={props.style}>
        <View className={styles.row} style={designVars({ gap: props.gap })}>
          {cells.map((cell, index) => (
            <View
              key={index}
              className={cx(styles.rowCell, index > 0 && styles.gapLeft)}
              {...tapProps(tap(cell, onLink))}
            >
              {cell ? (
                <BlockImage
                  className={styles.rowImage}
                  src={cell.image}
                  width={count === 2 ? 960 : 480}
                  resolve={host?.resolveImage}
                  mode="widthFix"
                  lazyLoad={!host?.canvas}
                />
              ) : null}
            </View>
          ))}
        </View>
      </BlockFrame>
    );
  }

  const vars = designVars({ gap: props.gap, height: props.height });
  let body;
  switch (props.layout) {
    case 'left1right2':
      body = (
        <View className={styles.box} style={vars}>
          <BoxCell cell={a} onLink={onLink} host={host} />
          <View className={cx(styles.split, styles.column, styles.gapLeft)}>
            <BoxCell cell={b} onLink={onLink} host={host} />
            <BoxCell cell={c} onLink={onLink} host={host} className={styles.gapTop} />
          </View>
        </View>
      );
      break;
    case 'top1bottom2':
      body = (
        <View className={cx(styles.box, styles.column)} style={vars}>
          <BoxCell cell={a} onLink={onLink} host={host} />
          <View className={cx(styles.split, styles.gapTop)}>
            <BoxCell cell={b} onLink={onLink} host={host} />
            <BoxCell cell={c} onLink={onLink} host={host} className={styles.gapLeft} />
          </View>
        </View>
      );
      break;
    default:
      body = (
        <View className={cx(styles.box, styles.column)} style={vars}>
          <View className={styles.split}>
            <BoxCell cell={a} onLink={onLink} host={host} />
            <BoxCell cell={b} onLink={onLink} host={host} className={styles.gapLeft} />
          </View>
          <View className={cx(styles.split, styles.gapTop)}>
            <BoxCell cell={c} onLink={onLink} host={host} />
            <BoxCell cell={d} onLink={onLink} host={host} className={styles.gapLeft} />
          </View>
        </View>
      );
  }

  return (
    <BlockFrame type="imageCube" frame={props.style}>
      {body}
    </BlockFrame>
  );
}
