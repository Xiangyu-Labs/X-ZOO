import { describe, expect, it } from 'vitest';
import { groupbuyGroupStatus, groupbuyMemberRole } from '../groupbuy/schemas';
import { orderGroupbuyTeam } from './schemas';

describe('the 拼团 team on a storefront order', () => {
  it('spells the team status and seat role exactly as the group-buy contract does', () => {
    expect(orderGroupbuyTeam.shape.status.options).toEqual(groupbuyGroupStatus.options);
    expect(orderGroupbuyTeam.shape.role.options).toEqual(groupbuyMemberRole.options);
  });
});
