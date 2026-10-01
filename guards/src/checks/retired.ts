import path from 'node:path';
import { allRoutes } from '@shop/contracts/routes';
import { defineCheck, fail, result, type Finding } from '../framework';
import { isScript, walk } from '../lib/files';
import { apiClientSrc, miniApp, rel, repoRoot, storefrontBlocksSrc } from '../lib/paths';

/**
 * The shop's scope, enforced instead of remembered (CORE-002).
 *
 * The features below are ones the shop deliberately does not have. The unit
 * is the **identifier or URL token**: a word that can only mean the feature,
 * matched as a whole word in code (never in prose) and as a whole path segment
 * in a URL.
 *
 * Words that are ordinary English elsewhere in the domain ("live", "sign",
 * "chat") are matched only in the URL form, because `isLive`, `signature` and
 * `chatty` are all legitimate. Words that could only ever be the retired
 * feature are matched as identifiers too.
 */

export interface RetiredWord {
  /** Matched as a whole word anywhere in source. */
  identifier?: RegExp;
  /** Matched as a whole path segment or hyphen token of a URL. */
  urlToken?: string;
  feature: string;
}

export const RETIRED: readonly RetiredWord[] = [
  { identifier: /\bbargain(s|Id|_id)?\b/i, urlToken: 'bargain', feature: '砍价' },
  { identifier: /\bseckill\b/i, urlToken: 'seckill', feature: '秒杀' },
  { identifier: /\bluckLottery|\blottery\b/i, urlToken: 'lottery', feature: '抽奖' },
  { urlToken: 'live', feature: '直播' },
  { identifier: /\bbrokerage\b/i, urlToken: 'brokerage', feature: '分销佣金' },
  { identifier: /\bdistributionAgent\b/i, urlToken: 'agent', feature: '分销代理' },
  { identifier: /\bspreadUser|\bspread_uid\b/i, urlToken: 'spread', feature: '分销关系' },
  { identifier: /\bintegral\b/i, urlToken: 'integral', feature: '积分' },
  { urlToken: 'sign', feature: '签到' },
  { identifier: /\bmemberCard|\bmember_card\b/i, urlToken: 'member-card', feature: '付费会员' },
  { identifier: /\bsvipPrice|\bvipPrice\b/i, feature: '会员价' },
  { identifier: /\brecharge\b/i, urlToken: 'recharge', feature: '充值' },
  { identifier: /\byuePay|\bnow_money\b/i, urlToken: 'balance', feature: '余额支付' },
  { identifier: /\balipay\b/i, urlToken: 'alipay', feature: '支付宝' },
  { identifier: /\ballinpay\b/i, urlToken: 'allinpay', feature: '通联支付' },
  { identifier: /\bofflinePay|\boffline_pay\b/i, feature: '线下支付' },
  { identifier: /\bwriteOff|\bwrite_off\b/i, urlToken: 'write-off', feature: '核销' },
  { identifier: /\bstoreSelfMention\b/i, urlToken: 'store-pickup', feature: '门店自提' },
  { identifier: /\bkefu\b/i, urlToken: 'kefu', feature: '自建客服' },
  { identifier: /\bnewChat\b/i, urlToken: 'chat', feature: '聊天' },
  { identifier: /\boutapi\b/i, urlToken: 'outapi', feature: 'outapi' },
  { identifier: /\bsystemCrud\b/i, feature: 'CRUD 代码生成器' },
  { identifier: /\bsystemRoute\b/i, feature: 'system_route 注册表' },
  { identifier: /\bpcDecoration|\bpc_decoration\b/i, feature: 'PC 装修' },
  { identifier: /\bcityDelivery|\bdelivery_service\b/i, feature: '同城配送' },
  { identifier: /\binvoiceProvider\b/i, feature: '电子发票服务商' },
];

/** Roots that must contain no retired identifier at all. */
const SOURCE_ROOTS = [
  path.join(repoRoot, 'apps/web/src'),
  path.join(repoRoot, 'apps/web/app'),
  path.join(repoRoot, 'apps/worker/src'),
  path.join(repoRoot, 'packages/core/src'),
  path.join(repoRoot, 'packages/contracts/src'),
  // The mini-program and the two packages it is built from (docs/mini), tests included.
  path.join(miniApp, 'src'),
  apiClientSrc,
  storefrontBlocksSrc,
];

/** Files that must name a retired feature in order to keep it out: the guard's own word list. */
const ALLOWED = [/^guards\//];

/**
 * The deny-lists themselves, word by word.
 *
 * A file that exists in order to *name* a retired feature and refuse it is the
 * one place the word is allowed to appear in code rather than in prose — but
 * per word, not per file, so a file on this list cannot grow a new retired
 * feature quietly. Each entry is exactly compared: a word that stops appearing
 * means the deny-list lost a row, which is exactly as interesting as a word
 * appearing somewhere new.
 */
interface DenyListFile {
  file: RegExp;
  /** `feature` values from RETIRED that this file is allowed to name. */
  words: readonly string[];
  why: string;
}

const DENY_LISTS: readonly DenyListFile[] = [
  {
    file: /^packages\/contracts\/src\/system\/system\.role\.contract\.ts$/,
    words: ['秒杀'],
    why: 'the documented example of unknownPermissions — a stored grant for a module that no longer exists, shown so it can be cleared',
  },
];

/** A retired word only counts in a URL when it is a whole segment or hyphen token. */
export function urlTokens(url: string): Set<string> {
  const tokens = new Set<string>();
  for (const segment of url.split('/')) {
    if (!segment) continue;
    tokens.add(segment.toLowerCase());
    for (const part of segment.split('-')) tokens.add(part.toLowerCase());
  }
  return tokens;
}

/** The retired feature a URL (or page path) names, or null. The query string is not read. */
export function retiredInUrl(url: string): RetiredWord | null {
  const tokens = urlTokens(url.split(/[?#]/)[0] ?? '');
  return RETIRED.find((word) => word.urlToken !== undefined && tokens.has(word.urlToken)) ?? null;
}

export const retiredFeatures = defineCheck(
  'retired',
  'no retired feature reappears in the workspace or the mini-program',
  () => {
    const findings: Finding[] = [];
    const denyListHits = new Set<string>();
    let scanned = 0;

    for (const root of SOURCE_ROOTS) {
      for (const file of walk(root, isScript)) {
        const where = rel(file.file);
        if (ALLOWED.some((re) => re.test(where))) continue;
        scanned += 1;
        const denyList = DENY_LISTS.find((entry) => entry.file.test(where));
        // Comments are prose: a note explaining *why* 秒杀 is gone is not 秒杀
        // coming back. Identifiers are what matter.
        const code = file.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const word of RETIRED) {
          if (!word.identifier) continue;
          const hit = word.identifier.exec(code);
          if (!hit) continue;
          if (denyList?.words.includes(word.feature)) {
            denyListHits.add(`${where} ${word.feature}`);
            continue;
          }
          findings.push(fail(where, `names the retired ${word.feature}: ${hit[0]}`));
        }
      }
    }

    for (const entry of DENY_LISTS) {
      for (const word of entry.words) {
        const hit = [...denyListHits].some(
          (key) => key.endsWith(` ${word}`) && entry.file.test(key.slice(0, -word.length - 1)),
        );
        if (!hit) {
          findings.push(
            fail(
              String(entry.file.source),
              `is allowed to name the retired ${word} (${entry.why}) but no longer does — delete the word from guards/src/checks/retired.ts`,
            ),
          );
        }
      }
    }

    for (const route of allRoutes) {
      const tokens = urlTokens(route.path);
      for (const word of RETIRED) {
        if (word.urlToken && tokens.has(word.urlToken)) {
          findings.push(
            fail(
              route.id,
              `${route.method} ${route.path} is a URL for the retired ${word.feature}`,
            ),
          );
        }
      }
    }

    return result(
      'retired',
      'retired features',
      `${RETIRED.length} retired features looked for in ${scanned} source files and ${allRoutes.length} route paths`,
      findings,
    );
  },
);
