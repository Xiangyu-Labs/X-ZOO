import { describe, expect, it } from 'vitest';
import { isAllowedRedirect } from './storefront-auth.service';
import {
  anonymisedAccount,
  blankToNull,
  checkPasswordShape,
  defaultNickname,
  hasStarterProfile,
  invoiceTitleProblems,
  isDefaultNickname,
  isSyntheticAccount,
  maskPhone,
  pageBounds,
  pickOrder,
  planBatch,
  shouldForceDefault,
  syntheticAccount,
  toPasswordAlgo,
} from './user.rules';

describe('maskPhone', () => {
  it('hides the middle four digits of a mainland number', () => {
    expect(maskPhone('13800138000')).toBe('138****8000');
  });

  it('masks anything that is not 11 digits rather than returning it', () => {
    // A stored row can hold a landline, a number with a country code, or junk.
    // None of those stop being somebody's phone number because the regex
    // missed.
    expect(maskPhone('01012345678')).toBe('010****5678');
    expect(maskPhone('+8613800138000')).toBe('+8**********00');
    expect(maskPhone('1234')).toBe('****');
  });

  it('passes null and empty through as null', () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone('   ')).toBeNull();
  });
});

describe('defaultNickname', () => {
  it('uses the last four digits', () => {
    expect(defaultNickname('13800138000')).toBe('用户8000');
  });

  it('still produces something for an account with no number', () => {
    expect(defaultNickname(null)).toMatch(/^用户[0-9a-f]{4}$/);
  });
});

describe('isDefaultNickname', () => {
  it('recognises both forms defaultNickname makes, and no nickname at all', () => {
    expect(isDefaultNickname(defaultNickname('13800138000'))).toBe(true);
    expect(isDefaultNickname(defaultNickname(null))).toBe(true);
    expect(isDefaultNickname(null)).toBe(true);
  });

  it('leaves a chosen nickname alone', () => {
    expect(isDefaultNickname('小明')).toBe(false);
    expect(isDefaultNickname('用户小明')).toBe(false);
    expect(isDefaultNickname('用户12345')).toBe(false);
  });
});

describe('hasStarterProfile', () => {
  const avatar = 'https://cdn.example.com/a.png';
  const shopDefault = 'https://cdn.example.com/default.png';

  it('is false once both the nickname and the avatar were chosen', () => {
    expect(hasStarterProfile({ nickname: '小明', avatarUrl: avatar }, shopDefault)).toBe(false);
    expect(hasStarterProfile({ nickname: '小明', avatarUrl: avatar }, '')).toBe(false);
  });

  it('is true while either is still the starter one', () => {
    expect(hasStarterProfile({ nickname: '用户8000', avatarUrl: avatar }, '')).toBe(true);
    expect(hasStarterProfile({ nickname: '小明', avatarUrl: null }, '')).toBe(true);
    expect(
      hasStarterProfile({ nickname: '小明', avatarUrl: shopDefault }, ` ${shopDefault} `),
    ).toBe(true);
  });
});

describe('synthetic accounts', () => {
  it('cannot be mistaken for a phone number', () => {
    const account = syntheticAccount();
    expect(account).toMatch(/^wx_[0-9a-f]{16}$/);
    expect(account).not.toMatch(/^1[3-9]\d{9}$/);
  });

  it('is unique enough that two draws differ', () => {
    expect(syntheticAccount()).not.toBe(syntheticAccount());
  });

  it('recognises its own handles and nobody else’s', () => {
    expect(isSyntheticAccount(syntheticAccount())).toBe(true);
    expect(isSyntheticAccount(anonymisedAccount())).toBe(true);
    expect(isSyntheticAccount('13800138000')).toBe(false);
    expect(isSyntheticAccount('xiaoming')).toBe(false);
  });
});

describe('toPasswordAlgo', () => {
  it('adapts the column enum to what password.ts understands', () => {
    // The DB says `md5_legacy`, `auth/password.ts` says `md5`. Getting this
    // backwards makes every MD5-hashed login fail bcrypt verification silently.
    expect(toPasswordAlgo('md5_legacy')).toBe('md5');
    expect(toPasswordAlgo('bcrypt')).toBe('bcrypt');
    expect(toPasswordAlgo(null)).toBe('bcrypt');
  });
});

describe('checkPasswordShape', () => {
  it('accepts a mixed password of at least six characters', () => {
    expect(checkPasswordShape('xzoo654321')).toBe('ok');
    expect(checkPasswordShape('correct horse')).toBe('ok');
  });

  it('rejects the ones a length check alone would allow', () => {
    // `123456` passes a 6..16 length check and is the most common password in
    // every leak corpus.
    expect(checkPasswordShape('123456')).toBe('too-simple');
    expect(checkPasswordShape('abcdef')).toBe('too-simple');
    expect(checkPasswordShape('12345')).toBe('too-short');
  });

  it('rejects past bcrypt’s 72-byte truncation point', () => {
    // Longer than 72 bytes and bcrypt silently ignores the rest, so two very
    // different passphrases become the same secret.
    expect(checkPasswordShape(`a1${'x'.repeat(71)}`)).toBe('too-long');
    // Multi-byte characters count as bytes, not as characters.
    expect(checkPasswordShape(`a1${'汉'.repeat(24)}`)).toBe('too-long');
  });
});

describe('shouldForceDefault', () => {
  it('makes the first address the default whatever the form said', () => {
    expect(shouldForceDefault(0, false)).toBe(true);
    expect(shouldForceDefault(3, false)).toBe(false);
    expect(shouldForceDefault(3, true)).toBe(true);
  });
});

describe('planBatch', () => {
  it('distinguishes "clear them all" from "remove nothing"', () => {
    expect(planBatch('replace', [])).toEqual({ clearAll: true, removeIds: [], addIds: [] });
    expect(planBatch('remove', [])).toEqual({ clearAll: false, removeIds: [], addIds: [] });
  });

  it('deduplicates', () => {
    expect(planBatch('add', [1, 1, 2]).addIds).toEqual([1, 2]);
  });
});

describe('pageBounds', () => {
  it('turns a 1-based page into an offset', () => {
    expect(pageBounds({ page: 1, pageSize: 20 })).toEqual({ offset: 0, limit: 20 });
    expect(pageBounds({ page: 3, pageSize: 20 })).toEqual({ offset: 40, limit: 20 });
  });
});

describe('pickOrder', () => {
  const table = {
    id: { asc: 'id asc', desc: 'id desc' },
    name: { asc: 'name asc', desc: 'name desc' },
  };

  it('defaults to descending, which is what a list screen wants', () => {
    expect(pickOrder(table, 'name', undefined, 'id')).toBe('name desc');
    expect(pickOrder(table, 'name', 'asc', 'id')).toBe('name asc');
  });

  it('falls back rather than throwing on a key that is not in the whitelist', () => {
    // Somebody bookmarked `?sortBy=password_hash`. That is a 200 with the
    // default ordering, not a 500, and certainly not a column reference.
    expect(pickOrder(table, 'password_hash', 'asc', 'id')).toBe('id asc');
    expect(pickOrder(table, undefined, 'desc', 'id')).toBe('id desc');
  });
});

describe('isAllowedRedirect', () => {
  it('accepts the configured origin', () => {
    expect(isAllowedRedirect('https://shop.example.com/pages/me', 'https://shop.example.com')).toBe(
      true,
    );
  });

  it('rejects a host that merely starts with the site URL', () => {
    // The `startsWith` version of this check is the classic OAuth open
    // redirect: WeChat hands the `code` to whoever asked for it.
    expect(
      isAllowedRedirect('https://shop.example.com.attacker.test/steal', 'https://shop.example.com'),
    ).toBe(false);
    expect(isAllowedRedirect('https://attacker.test', 'https://shop.example.com')).toBe(false);
  });

  it('rejects a different scheme or port', () => {
    expect(isAllowedRedirect('http://shop.example.com', 'https://shop.example.com')).toBe(false);
    expect(isAllowedRedirect('https://shop.example.com:8443', 'https://shop.example.com')).toBe(
      false,
    );
    expect(isAllowedRedirect('javascript:alert(1)', 'https://shop.example.com')).toBe(false);
  });

  it('refuses everything when no site URL is configured', () => {
    // Failing closed: an unconfigured shop cannot be used to launder a redirect.
    expect(isAllowedRedirect('https://shop.example.com', '')).toBe(false);
  });

  it('does not throw on a malformed URL', () => {
    expect(isAllowedRedirect('not a url', 'https://shop.example.com')).toBe(false);
  });
});

describe('invoice titles', () => {
  const company = {
    headerType: 'company' as const,
    invoiceType: 'plain' as const,
    name: '某某公司',
    dutyNumber: '91330100MA2XXXXX0A',
    registeredTel: null,
    registeredAddress: null,
    bankName: null,
    bankAccount: null,
  };

  it('trims, and stores a blank as null', () => {
    expect(blankToNull(undefined)).toBeNull();
    expect(blankToNull('')).toBeNull();
    expect(blankToNull('   ')).toBeNull();
    expect(blankToNull(' 91330100MA2XXXXX0A ')).toBe('91330100MA2XXXXX0A');
  });

  it('finds nothing wrong with a complete title', () => {
    expect(invoiceTitleProblems(company)).toEqual([]);
    expect(invoiceTitleProblems({ ...company, headerType: 'personal', dutyNumber: null })).toEqual(
      [],
    );
  });

  it('names every field a company 专票 is missing', () => {
    expect(
      invoiceTitleProblems({ ...company, invoiceType: 'special', dutyNumber: null }).map(
        (p) => p.field,
      ),
    ).toEqual([
      'body.dutyNumber',
      'body.registeredAddress',
      'body.registeredTel',
      'body.bankName',
      'body.bankAccount',
    ]);
  });

  it('refuses a title with no name left after trimming', () => {
    expect(invoiceTitleProblems({ ...company, name: null })).toEqual([
      { field: 'body.name', message: '请填写抬头名称' },
    ]);
  });
});
