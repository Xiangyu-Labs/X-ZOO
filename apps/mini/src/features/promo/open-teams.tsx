import { Text, View } from '@tarojs/components';
import { useRouteQuery } from '@shop/api-client/react';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Countdown } from '@/ui/countdown';
import './open-teams.scss';

/**
 * Teams on a 拼团 activity still looking for members (商品详情). Only the seats and the time left
 * are shown: a stranger's name and face have no place on a public page of this shop. 去参团
 * opens the team page, which asks for the SKU there. Not shown to a shopper who already has a
 * live team on the activity: the server allows one team per shopper per activity.
 */
export function OpenTeams({
  activityId,
  onOpen,
}: {
  activityId: string;
  onOpen: (groupId: string) => void | Promise<unknown>;
}) {
  const teams = useRouteQuery('groupbuy.openGroups', {
    params: { id: activityId },
    query: { pageSize: 5 },
  });
  const items = teams.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Card title="正在拼的团" className="open-teams" id="groupbuy-open-teams">
      <Text className="open-teams__note">可直接参与，人满即成团</Text>
      {items.map((team) => (
        <View key={team.groupId} className="open-teams__team">
          <View className="open-teams__body">
            <Text className="open-teams__seats">还差 {team.seatsLeft} 人成团</Text>
            <View className="open-teams__time">
              <Text className="open-teams__label">剩余</Text>
              <Countdown endsAt={team.expiresAt} onEnd={() => teams.refetch()} />
            </View>
          </View>
          <Button
            size="sm"
            variant="outline-primary"
            label={`去参团，还差 ${team.seatsLeft} 人`}
            onClick={() => onOpen(team.groupId)}
          >
            去参团
          </Button>
        </View>
      ))}
    </Card>
  );
}
