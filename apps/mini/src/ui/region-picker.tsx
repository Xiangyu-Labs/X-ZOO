import { useState } from 'react';
import { ScrollView, Text, View } from '@tarojs/components';
import { useCityTree, type CityProvince } from '@/data/cities';
import { cx } from '@/lib/cx';
import { Cell } from './cell';
import { ErrorBlock } from './error-block';
import { Icon } from './icon';
import { Pressable } from './pressable';
import { Sheet } from './sheet';
import { CellSkeleton } from './skeleton';
import './region-picker.scss';

export interface Region {
  provinceId: string;
  provinceName: string;
  cityId: string;
  cityName: string;
  /** `null` where a city has no districts below it. */
  districtId: string | null;
  districtName: string | null;
}

interface Node {
  id: string;
  name: string;
  children?: readonly Node[];
}

export interface RegionPickerProps {
  value: Region | null;
  onChange: (region: Region) => void;
  title?: string | undefined;
  placeholder?: string | undefined;
  required?: boolean | undefined;
  error?: string | undefined;
}

/**
 * 所在地区 (design.md §4.3): a form row that opens a sheet of 省 → 市 → 区, one level at a time,
 * with the chosen names as tabs to step back. Ids come from `shipping.cityTree`, which freight
 * rules key on, so this never uses WeChat's own region picker.
 */
export function RegionPicker({
  value,
  onChange,
  title = '所在地区',
  placeholder = '请选择省 / 市 / 区',
  required,
  error,
}: RegionPickerProps) {
  const [open, setOpen] = useState(false);
  const text = value
    ? [value.provinceName, value.cityName, value.districtName].filter(Boolean).join(' ')
    : null;
  return (
    <>
      <Cell
        title={title}
        required={required}
        error={error}
        label={`${title}：${text ?? '未选择'}`}
        value={
          <Text className={cx('shop-region__value', !text && 'shop-region__value--empty')}>
            {text ?? placeholder}
          </Text>
        }
        onClick={() => setOpen(true)}
      />
      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        title="选择地区"
        height="tall"
        padded={false}
      >
        {open ? (
          <RegionSheetBody
            initial={value}
            onDone={(region) => {
              setOpen(false);
              onChange(region);
            }}
          />
        ) : null}
      </Sheet>
    </>
  );
}

function RegionSheetBody({
  initial,
  onDone,
}: {
  initial: Region | null;
  onDone: (region: Region) => void;
}) {
  const tree = useCityTree();
  const [path, setPath] = useState<Node[]>([]);
  const [level, setLevel] = useState(0);
  const [seeded, setSeeded] = useState(false);

  const provinces: readonly CityProvince[] = tree.data?.items ?? [];
  // Open on the saved region: its three levels as tabs, the last one showing.
  if (!seeded && provinces.length > 0) {
    setSeeded(true);
    if (initial) {
      const province = provinces.find((p) => p.id === initial.provinceId);
      const city = province?.children.find((c) => c.id === initial.cityId);
      const district = city?.children.find((d) => d.id === initial.districtId);
      const seed = [province, city, district].filter((node): node is NonNullable<typeof node> =>
        Boolean(node),
      );
      setPath(seed);
      setLevel(Math.max(0, seed.length - 1));
    }
  }

  if (tree.isPending) return <CellSkeleton rows={8} />;
  if (tree.isError) return <ErrorBlock error={tree.error} onRetry={() => tree.refetch()} compact />;

  const options: readonly Node[] = level === 0 ? provinces : (path[level - 1]?.children ?? []);
  const chosen = path[level];

  const pick = (node: Node) => {
    const next = [...path.slice(0, level), node];
    setPath(next);
    if (node.children && node.children.length > 0 && level < 2) {
      setLevel(level + 1);
      return;
    }
    const [province, city, district] = next;
    if (!province || !city) return;
    onDone({
      provinceId: province.id,
      provinceName: province.name,
      cityId: city.id,
      cityName: city.name,
      districtId: district?.id ?? null,
      districtName: district?.name ?? null,
    });
  };

  const tabs = path.slice(0, level + 1);
  return (
    <View className="shop-region">
      <View className="shop-region__tabs" ariaRole="tablist">
        {tabs.map((node, index) => (
          <Pressable
            key={node.id}
            role="tab"
            selected={index === level}
            label={node.name}
            className={cx('shop-region__tab', index === level && 'shop-region__tab--on')}
            onClick={() => setLevel(index)}
          >
            {node.name}
          </Pressable>
        ))}
        {tabs.length === level ? (
          <Text className="shop-region__tab shop-region__tab--on">请选择</Text>
        ) : null}
      </View>
      <ScrollView
        scrollY
        className="shop-region__list"
        scrollIntoView={chosen ? `region-${chosen.id}` : ''}
      >
        {options.map((node) => {
          const on = node.id === chosen?.id;
          return (
            <Pressable
              key={node.id}
              id={`region-${node.id}`}
              role="radio"
              checked={on}
              label={node.name}
              className={cx('shop-region__option', on && 'shop-region__option--on')}
              onClick={() => pick(node)}
            >
              <Text>{node.name}</Text>
              {on ? <Icon name="check" /> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
