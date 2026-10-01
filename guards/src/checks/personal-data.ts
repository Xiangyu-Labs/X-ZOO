import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { allRoutes } from '@shop/contracts/routes';
import { defineCheck, fail, result, type Finding } from '../framework';
import { repoRoot } from '../lib/paths';
import { walkSchema } from './secrets';

/**
 * Personal data in responses, walked over every contract (the `secrets`
 * check's schema walk, over other names).
 *
 * Two kinds of field, by the last property name, counted only where the node
 * is a string (an `isSet` flag or `hasPassword: boolean` says nothing):
 *
 *  - **never**: credentials and cross-app identifiers — a password or its
 *    hash, a WeChat `session_key`, an `openid` / `unionid`, an ID-card number,
 *    a virtual card's 卡密. No response carries one unless `NEVER_ALLOW` names
 *    the exact route and path with the reason, and — where the reason is "it
 *    is masked" — the source line that masks it, which must still exist.
 *  - **personal**: a phone number, a real name, an e-mail address, the bank
 *    account on a company invoice title. Staff need
 *    them, so `auth: 'admin'` routes pass. Anything a shopper's device or the
 *    public can call passes only under an `OWN_OR_SHOP` rule: the shopper's
 *    own record (profile, addresses, invoice titles, own orders), or the
 *    shop's own number. A new storefront route that returns somebody else's
 *    phone — a group-buy team, a review list — fails until someone decides.
 *
 * Both lists are exactly compared: an entry or a rule that matches nothing
 * fails, so neither can outlive the routes it names.
 */

const NEVER =
  /^(password|passwordHash|passwordDigest|salt|sessionKey|session_key|openid|openId|unionid|unionId|idCard|idCardNo|idNumber|cardSecret|payPassword|bankCardNo)$/;

const PERSONAL = /(phone|mobile|tel)$|^(realName|email|bankAccount)$/i;

interface NeverEntry {
  route: string;
  path: string;
  why: string;
  /** Where the value is masked before it leaves, if that is the reason. Must still be there. */
  maskedAt?: { file: string; text: string };
}

export const NEVER_ALLOW: readonly NeverEntry[] = [
  {
    route: 'wechatOa.qrcodeScans',
    path: 'items.[].openid',
    why: 'the 渠道码 scan log shows which follower scanned, masked to its first and last four characters',
    maskedAt: {
      file: 'packages/core/src/wechat-oa/wechat-oa.qrcode.service.ts',
      text: 'openid: maskOpenid(scan.openid),',
    },
  },
  {
    route: 'catalog.adminVirtualCardList',
    path: 'items.[].cardSecret',
    why: 'the 卡密 pool staff load and audit; an admin read gated on catalog:card:read, and the only screen that shows it',
  },
];

interface OwnRule {
  /** Route ids the rule covers. */
  routes: RegExp;
  /** Response paths, e.g. `user.phone`, `items.[].receiverPhone`. */
  paths: RegExp;
  is: string;
}

export const OWN_OR_SHOP: readonly OwnRule[] = [
  {
    routes:
      /^auth\.(miniLogin|miniPhoneLogin|oaLogin|oaPhoneLogin|passwordLogin|register|smsLogin)$/,
    paths: /^(session\.)?user\.(phone|realName)$/,
    is: 'the signed-in shopper’s own profile, answered to the device that just proved it',
  },
  {
    routes: /^system\.appConfigGet$/,
    paths: /^support\.phone$/,
    is: 'the shop’s customer-service number',
  },
  {
    routes:
      /^user\.(getProfile|updateProfile|currentCancellation|requestCancellation|withdrawCancellation)$/,
    paths: /^(request\.)?(phone|realName)$/,
    is: 'the shopper’s own account',
  },
  {
    routes: /^user\.(address\w*|defaultAddress)$/,
    paths: /^(items\.\[\]\.|address\.)?receiverPhone$/,
    is: 'the shopper’s own address book',
  },
  {
    routes:
      /^(user\.invoiceTitle\w*|order\.(myInvoices|myInvoiceDetail|invoiceRequest|cancelInvoice))$/,
    paths: /^(items\.\[\]\.|title\.)?(drawerPhone|registeredTel|email|bankAccount)$/,
    is: 'the shopper’s own invoice titles and requests',
  },
  {
    routes: /^order\.(checkoutPreview|create|detail|cancel|confirmReceipt)$/,
    paths: /^receiver\.phone$/,
    is: 'the receiver the shopper typed on their own order',
  },
  {
    routes: /^order\.myShipments$/,
    paths: /^items\.\[\]\.courierPhone$/,
    is: 'the courier’s number on the shopper’s own parcel',
  },
  {
    routes: /^refund\.(apply|cancel|myDetail|submitReturnShipment)$/,
    paths: /^(returnAddress\.phone|returnPhone)$/,
    is: 'the shop’s return address',
  },
];

export interface ResponseField {
  route: string;
  auth: string;
  path: string;
  key: string;
}

/** Every string-typed response property whose name is a never or personal field. */
export function sensitiveFields(
  routes: ReadonlyArray<{ id: string; auth: string; response: unknown }>,
): ResponseField[] {
  const out: ResponseField[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    walkSchema(route.response as z.ZodType, (at, node) => {
      const key = at.at(-1);
      if (key === undefined) return;
      if (!NEVER.test(key) && !PERSONAL.test(key)) return;
      if ((node.def as { type?: string }).type !== 'string') return;
      const field = { route: route.id, auth: route.auth, path: at.join('.'), key };
      const id = `${field.route}:${field.path}`;
      if (seen.has(id)) return;
      seen.add(id);
      out.push(field);
    });
  }
  return out;
}

export interface Verdict {
  findings: Finding[];
  usedNever: Set<NeverEntry>;
  usedRules: Set<OwnRule>;
}

export function judge(
  fields: readonly ResponseField[],
  never: readonly NeverEntry[] = NEVER_ALLOW,
  rules: readonly OwnRule[] = OWN_OR_SHOP,
): Verdict {
  const findings: Finding[] = [];
  const usedNever = new Set<NeverEntry>();
  const usedRules = new Set<OwnRule>();
  for (const field of fields) {
    if (NEVER.test(field.key)) {
      const entry = never.find((e) => e.route === field.route && e.path === field.path);
      if (entry) {
        usedNever.add(entry);
        continue;
      }
      findings.push(
        fail(
          field.route,
          `response.${field.path} carries ${field.key} as text — a credential or cross-app identifier never leaves the server; mask it and add a NEVER_ALLOW entry naming where, or drop it`,
        ),
      );
      continue;
    }
    if (field.auth === 'admin') continue;
    const rule = rules.find((r) => r.routes.test(field.route) && r.paths.test(field.path));
    if (rule) {
      usedRules.add(rule);
      continue;
    }
    findings.push(
      fail(
        field.route,
        `response.${field.path} is personal data (${field.key}) on a '${field.auth}' route that is not the shopper’s own record or the shop’s — mask it, drop it, or add an OWN_OR_SHOP rule saying whose it is`,
      ),
    );
  }
  return { findings, usedNever, usedRules };
}

export const personalData = defineCheck(
  'personal-data',
  'no credential in any response; personal data leaves the storefront only as the shopper’s own',
  () => {
    const fields = sensitiveFields(allRoutes);
    const { findings, usedNever, usedRules } = judge(fields);

    for (const entry of NEVER_ALLOW) {
      if (!usedNever.has(entry)) {
        findings.push(
          fail(
            entry.route,
            `NEVER_ALLOW names ${entry.route}:${entry.path}, which no response carries any more — delete the entry`,
          ),
        );
      }
      if (entry.maskedAt) {
        const file = path.join(repoRoot, entry.maskedAt.file);
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (!text.includes(entry.maskedAt.text)) {
          findings.push(
            fail(
              entry.maskedAt.file,
              `NEVER_ALLOW excuses ${entry.route}:${entry.path} because it is masked by \`${entry.maskedAt.text}\`, which is no longer in this file`,
            ),
          );
        }
      }
    }
    for (const rule of OWN_OR_SHOP) {
      if (!usedRules.has(rule)) {
        findings.push(
          fail(
            String(rule.routes),
            `the OWN_OR_SHOP rule "${rule.is}" matches no response field any more — delete it`,
          ),
        );
      }
    }

    const outside = fields.filter((f) => f.auth !== 'admin').length;
    return result(
      'personal-data',
      'personal data in responses',
      `${fields.length} personal or credential fields in ${allRoutes.length} contracts; ${outside} outside the admin, under ${OWN_OR_SHOP.length} own-record rules; ${NEVER_ALLOW.length} masked or staff-only credentials`,
      findings,
    );
  },
);
