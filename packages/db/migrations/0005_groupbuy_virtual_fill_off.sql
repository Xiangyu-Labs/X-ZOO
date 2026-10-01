-- 虚拟成团 is off for good (2026-09-23): the mini-program is the only storefront
-- after the cutover, and a team completed with invented members reads as a
-- fake transaction there. The `groupbuy` config group no longer has the
-- switch, so a stored value is already ignored by this release; deleting it
-- also keeps it off if the upgrade rolls back to the previous image, which
-- still reads the key.
DELETE FROM "config_values" WHERE "group" = 'groupbuy' AND "key" = 'virtualFillOnExpiry';
