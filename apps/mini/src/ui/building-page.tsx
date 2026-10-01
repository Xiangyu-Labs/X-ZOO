import { navigate } from '@/platform';
import { Button } from './button';
import { Empty } from './empty';
import { PageShell } from './page-shell';

/**
 * The stand-in body of a page whose stream has not landed yet: the right title, the shell (theme,
 * privacy sheet) and a way home. Every registered page renders something real from day one.
 */
export function BuildingPage({ title, home = true }: { title: string; home?: boolean }) {
  return (
    <PageShell title={title}>
      <Empty
        image="building"
        title="建设中"
        description="这个页面正在建设，敬请期待"
        actions={
          home ? (
            <Button
              variant="outline-primary"
              onClick={() => navigate({ route: 'home', params: {} })}
            >
              回到首页
            </Button>
          ) : null
        }
      />
    </PageShell>
  );
}
