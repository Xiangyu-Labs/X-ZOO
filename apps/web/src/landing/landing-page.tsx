import type { LandingData } from '@/server/landing';

/**
 * The landing page at `/` (docs/mini/cutover.md §2.10): the shop's name, the
 * 小程序码 and one line — open it in WeChat. Deliberately plain: no products,
 * no pictures but the code, no admin link. Mobile first, light and dark; the
 * code keeps a white frame in the dark scheme, because a scanner needs dark
 * modules on a light ground.
 *
 * A server component with its own stylesheet and no antd, so the page ships
 * no client JavaScript of its own.
 */

const CSS = `
.landing {
  --landing-bg: #f5f5f3;
  --landing-card: #ffffff;
  --landing-text: #1f1f1f;
  --landing-muted: #6b6b6b;
  --landing-line: #e7e7e4;
  box-sizing: border-box;
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
  padding: 32px 16px calc(24px + env(safe-area-inset-bottom));
  background: var(--landing-bg);
  color: var(--landing-text);
  font-family: system-ui, -apple-system, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  .landing {
    --landing-bg: #141414;
    --landing-card: #1d1d1d;
    --landing-text: #ececec;
    --landing-muted: #9b9b9b;
    --landing-line: #2d2d2d;
  }
}
.landing-card {
  box-sizing: border-box;
  width: 100%;
  max-width: 360px;
  padding: 32px 24px;
  border: 1px solid var(--landing-line);
  border-radius: 16px;
  background: var(--landing-card);
  text-align: center;
}
.landing-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.landing-code {
  display: inline-block;
  margin-top: 24px;
  padding: 12px;
  border-radius: 12px;
  background: #ffffff;
  line-height: 0;
}
.landing-code img {
  width: 200px;
  height: 200px;
  max-width: 56vw;
  max-height: 56vw;
}
.landing-lead {
  margin: 20px 0 0;
  font-size: 16px;
  line-height: 1.5;
}
.landing-hint {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--landing-muted);
}
.landing-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px 16px;
  max-width: 360px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--landing-muted);
  text-align: center;
}
.landing-footer a {
  color: inherit;
  text-decoration: none;
}
.landing-footer a:hover,
.landing-footer a:focus-visible {
  text-decoration: underline;
}
`;

export function LandingPage({ data }: { data: LandingData }) {
  const title = data.shopName ?? '欢迎光临';
  const name = data.miniName;

  return (
    <main className="landing">
      <style>{CSS}</style>
      <section className="landing-card" aria-labelledby="landing-title">
        <h1 id="landing-title" className="landing-title">
          {title}
        </h1>
        {data.codeUrl ? (
          <>
            <div className="landing-code">
              <img src={data.codeUrl} alt={`${name ?? title} 小程序码`} width={200} height={200} />
            </div>
            <p className="landing-lead">请使用微信扫码打开</p>
            <p className="landing-hint">
              {name
                ? `在微信中打开本页时，可长按识别；也可在微信中搜索「${name}」`
                : '在微信中打开本页时，可长按识别'}
            </p>
          </>
        ) : (
          <>
            <p className="landing-lead">
              {name ? `请在微信中搜索「${name}」小程序` : '请在微信中打开本店小程序'}
            </p>
            <p className="landing-hint">本店通过微信小程序提供服务</p>
          </>
        )}
      </section>
      {data.footer.length > 0 ? (
        <footer className="landing-footer">
          {data.footer.map((item) =>
            item.href ? (
              <a key={item.text} href={item.href} target="_blank" rel="noopener noreferrer">
                {item.text}
              </a>
            ) : (
              <span key={item.text}>{item.text}</span>
            ),
          )}
        </footer>
      ) : null}
    </main>
  );
}
