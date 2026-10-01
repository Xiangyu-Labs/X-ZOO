import { encryptMessage, signatureOf } from '../wechat';

/**
 * The Official Account callback's signature check and AES envelope.
 *
 * Pure functions, no `Ctx`, no I/O — so the vectors in `wechat-oa.crypto.test.ts`
 * are the real thing rather than a mock of it. Everything that decides *whether*
 * to trust a callback lives here; `wechat-oa.webhook.service.ts` decides what to
 * do with one that is trusted.
 *
 * ## Why the signature is checked before the body is parsed
 *
 * The callback URL is public and has to be: WeChat calls it from its own
 * addresses and publishes no stable list. So the URL is the authentication
 * boundary, and the only thing standing between the open internet and a "this
 * user just subscribed, give them the new-customer coupon" event is this file.
 *
 * `verifySignature` therefore runs on the raw query string, before any XML is
 * looked at, and in safe mode `verifyMessageSignature` runs on the still
 * encrypted `Encrypt` element before it is decrypted. Parsing the XML first and
 * checking the signature afterwards would turn a malformed body into a 500 that
 * WeChat then retries three times.
 *
 * ## Modes
 *
 * WeChat has three (明文 / 兼容 / 安全) and the mode is *not* read from config
 * here. The request says which one it is: a callback carrying `encrypt_type=aes`
 * and a `msg_signature` is encrypted, everything else is plain. A reply is then
 * encrypted exactly when the request was, which is correct in all three modes
 * and cannot drift out of step with a setting somebody changed in 公众平台 but
 * not in our admin.
 */

// ---------------------------------------------------------------------------
// signature and the AES envelope — shared with the mini program's message push
// ---------------------------------------------------------------------------

export {
  aesKeyOf,
  decryptMessage,
  encryptMessage,
  equalsSignature,
  signatureOf,
  verifyMessageSignature,
  verifySignature,
  WechatMessageCryptoError as WechatOaCryptoError,
} from '../wechat';

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/**
 * A deliberately tiny XML reader for a deliberately tiny XML dialect.
 *
 * A callback body is one flat `<xml>` element of scalar children, half of them
 * `<![CDATA[…]]>`. A general parser would bring an external-entity surface, a
 * dependency and a billion-laughs bomb to a problem that is one regular
 * expression — and the body arrives from the open internet before the signature
 * has been checked in exactly one case (it has not; the signature is checked
 * first, and this runs after).
 *
 * Nested elements are not supported because the dialect has none, except
 * `<ScanCodeInfo>` on a scan event, which we do not use.
 */
/**
 * The bare-value branch is `[^<]*` and not `[\s\S]*?`, which is the difference
 * between reading a callback and reading nothing at all.
 *
 * With a lazy any-character branch the very first thing the engine meets is
 * `<xml>`, and the value expands until `</xml>` — so the whole document matches
 * as one element named `xml`, which this function skips, and every callback
 * parses to `{}`. Forbidding `<` inside a bare value makes the wrapper
 * unmatchable and the children match one at a time; a nested element such as
 * `<Image><MediaId>…</MediaId></Image>` yields its leaf, which is the part
 * anybody wants.
 */
const ELEMENT = /<([A-Za-z0-9_]+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;

export function parseXml(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Limit the damage a pathological body can do: WeChat's own cap is 2 KB-ish.
  const source = xml.length > 64 * 1024 ? xml.slice(0, 64 * 1024) : xml;
  for (const match of source.matchAll(ELEMENT)) {
    const name = match[1];
    if (name === undefined || name === 'xml') continue;
    out[name] = match[2] ?? match[3] ?? '';
  }
  return out;
}

/** CDATA-wraps every string value; a number is written bare, as WeChat writes `CreateTime`. */
export function cdata(value: string): string {
  // `]]>` inside CDATA would close it early. Splitting it across two sections is
  // the only escape CDATA has.
  return `<![CDATA[${value.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/**
 * Builds one flat `<xml>` element.
 *
 * `nested` is appended verbatim for the handful of replies that carry a child
 * element (`<Image><MediaId>…`), which is not worth a tree model for.
 */
export function buildXml(fields: Record<string, string | number | undefined>, nested = ''): string {
  const body = Object.entries(fields)
    .flatMap(([key, value]) => {
      if (value === undefined) return [];
      return [
        typeof value === 'number'
          ? `<${key}>${value}</${key}>`
          : `<${key}>${cdata(value)}</${key}>`,
      ];
    })
    .join('');
  return `<xml>${body}${nested}</xml>`;
}

/** Wraps a plain reply in the safe-mode envelope, signature and all. */
export function encryptReply(args: {
  token: string;
  encodingAesKey: string;
  appId: string;
  message: string;
  timestamp: string;
  nonce: string;
  random?: Buffer;
}): string {
  const encrypt = encryptMessage({
    encodingAesKey: args.encodingAesKey,
    appId: args.appId,
    message: args.message,
    ...(args.random === undefined ? {} : { random: args.random }),
  });
  return buildXml({
    Encrypt: encrypt,
    MsgSignature: signatureOf([args.token, args.timestamp, args.nonce, encrypt]),
    TimeStamp: args.timestamp,
    Nonce: args.nonce,
  });
}
