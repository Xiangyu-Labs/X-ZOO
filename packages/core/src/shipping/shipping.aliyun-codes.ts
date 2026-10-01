/**
 * Our carrier code → 阿里云云市场 `/kdi`'s `type`.
 *
 * `express_companies.code` holds 快递100's names (`yuantong`, `shunfeng`), the
 * list the shop was seeded with. The market API has its own (`YTO`,
 * `SFEXPRESS`) and answers 204/205 to a `type` it does not know, so sending
 * ours as-is made every lookup but `jd` and `ems` come back empty.
 *
 * Every right-hand value is from the vendor's carrier table on the product
 * page. A carrier missing here sends no `type` at all, which the vendor answers
 * by guessing from the number (it claims 95%) — better than a wrong guess of
 * ours, which fails every time.
 */
const ALIYUN_TYPE: Readonly<Record<string, string>> = {
  shunfeng: 'SFEXPRESS',
  zhongtong: 'ZTO',
  yuantong: 'YTO',
  yunda: 'YUNDA',
  shentong: 'STO',
  huitongkuaidi: 'HTKY',
  jd: 'JD',
  jtexpress: 'JITU',
  youzhengguonei: 'CHINAPOST',
  ems: 'EMS',
  tiantian: 'TTKDEX',
  debangwuliu: 'DEPPON',
  debangkuaidi: 'DEPPON',
  youshuwuliu: 'UC56',
  zhongtongkuaiyun: 'ZTO56',
  yundakuaiyun: 'YUNDA56',
  baishiwuliu: 'BSKY',
  zhaijisong: 'ZJS',
  suning: 'SUNING',
  annengwuliu: 'ANE',
  ane66: 'ANEEX',
  kuayue: 'KYEXPRESS',
  danniao: 'DANNIAO',
  yimidida: 'YIMIDIDA',
  sxjdfreight: 'SXJD',
  zhongyouwuliu: 'ZYWL',
  suer: 'SURE',
  kuaijiesudi: 'FASTEXPRESS',
  rrs: 'RRS',
  xinfengwuliu: 'XFEXPRESS',
  lianhaowuliu: 'LTS',
  ztky: 'CRE',
  zhongtiewuliu: 'ZTKY',
  tiandihuayu: 'HOAU',
  longbanwuliu: 'LBEX',
  guotongkuaidi: 'GTO',
  quanfengkuaidi: 'QFKD',
  rufengda: 'RFD',
  jiajiwuliu: 'JIAJI',
  pjbest: 'PJKD',
  ups: 'UPS',
  dhl: 'DHL',
  lianbangkuaidi: 'FEDEX',
};

/**
 * The vendor's own codes, accepted as they are (`YTO` typed into 「测试查询」).
 * Only these: `SF` is WeChat's name for 顺丰 and the vendor's 204 for it.
 */
const VENDOR_CODES: ReadonlySet<string> = new Set(Object.values(ALIYUN_TYPE));

/**
 * The `type` to send for one of our carrier codes, or `undefined` to send none
 * and let the vendor recognise the carrier from the number.
 */
export function aliyunExpressType(code: string): string | undefined {
  const trimmed = code.trim();
  if (trimmed === '') return undefined;
  const known = ALIYUN_TYPE[trimmed.toLowerCase()];
  if (known !== undefined) return known;
  const upper = trimmed.toUpperCase();
  return VENDOR_CODES.has(upper) ? upper : undefined;
}

/** 顺丰 answers nothing without the receiver's phone tail in the number. */
export const ALIYUN_SHUNFENG = 'SFEXPRESS';
