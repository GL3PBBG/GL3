-- Roles
INSERT INTO userRoles (UR_id, UR_name, UR_color) VALUES
  (1, 'Player', '#ffffff'),
  (2, 'Admin', '#ff0000');
INSERT INTO roleAccess (RA_role, RA_module) VALUES
  (2, '*'),
  (1, 'crimes'),
  (99, 'ghost'); -- orphan: role 99 does not exist

-- Rounds
INSERT INTO rounds (RND_id, RND_name, RND_start, RND_end) VALUES
  (1, 'Round 1', 1700000000, NULL);

-- Content
INSERT INTO ranks (R_id, R_name, R_exp, R_cashReward, R_bulletReward, R_health) VALUES
  (1, 'Rookie', 0, 0, 10, 100),
  (2, 'Soldier', 1000, 500, 20, 120);
INSERT INTO moneyRanks (MR_id, MR_label, MR_threshold) VALUES
  (1, 'Poor', 0), (2, 'Rich', 1000000);
-- Explicit gap at id 4: SPEC §1.2 quirk — crime 4 was deleted, leaving a
-- dead position in every US_crimes string that still has an index 3.
INSERT INTO crimes (C_id, C_name, C_cooldown, C_money, C_maxMoney, C_bullets, C_maxBullets, C_exp, C_level) VALUES
  (1, 'Pickpocket', 60, 10, 50, 0, 0, 2, 0),
  (2, 'Shoplifting', 90, 20, 80, 0, 0, 3, 0),
  (3, 'Mugging', 120, 40, 150, 1, 2, 5, 1),
  (5, 'Burglary', 300, 200, 800, 0, 0, 10, 3),
  (6, 'Grand Theft Auto', 600, 500, 2000, 0, 0, 20, 5);
INSERT INTO locations (L_id, L_name, L_cost, L_cooldown, L_bullets, L_bulletCost) VALUES
  (1, 'New York', 0, 0, 500, 5),
  (2, 'Chicago', 100, 60, 300, 6);
INSERT INTO cars (CA_id, CA_name, CA_value, CA_theftChance) VALUES
  (1, 'Sedan', 5000, 10), (2, 'Sports Car', 50000, 2);
INSERT INTO theft (T_id, T_name, T_chance, T_maxDamage, T_worstCar, T_bestCar) VALUES
  (1, 'Amateur', 60, 30, 1000, 10000);
INSERT INTO weapons (W_id, W_name, W_accuracy) VALUES
  (1, 'Pistol', 60), (2, 'Shotgun', 45);
INSERT INTO items (I_id, I_name, I_type) VALUES
  (1, 'Baseball Bat', 'weapon'), (2, 'Kevlar Vest', 'armor');
INSERT INTO itemEffects (IE_item, IE_effect, IE_value) VALUES
  (1, 'damage', 15), (2, 'armor', 20),
  (99, 'orphan', 1); -- orphan: item 99 does not exist
INSERT INTO itemMeta (IM_item, IM_key, IM_value) VALUES
  (1, 'rarity', 'common');
INSERT INTO premiumMembership (PM_id, PM_name, PM_seconds, PM_cost) VALUES
  (1, 'VIP Week', 604800, 500);
-- The five bullet options plus the restock cursor are V2's flat keys; GL3
-- namespaces every plugin setting as `<pluginId>.<key>`, so migrateSettings
-- renames these six rather than copying them verbatim like the rest.
INSERT INTO settings (S_key, S_value) VALUES
  ('pointsName', 'Respect Points'),
  ('gangName', 'Family'),
  ('detectiveReport', '1'),
  ('bulletsStockMinPerHour', '1000'),
  ('bulletsStockMaxPerHour', '1500'),
  ('maxBulletStock', '25000'),
  ('maxBulletCost', '900'),
  ('maxBulletBuy', '250'),
  ('lastBulletRestock', '1420070400');

-- Users. Legacy passwords are sha256(U_id . plaintext) — SPEC §1.1/§4.3.
-- Plaintext noted per row for the Task 31 login end-to-end test; never
-- stored in the fixture itself beyond the hash, matching a real V2 dump.
INSERT INTO users (U_id, U_name, U_email, U_password, U_userLevel, U_status, U_round) VALUES
  (1, 'DonVito', 'vito@family.test', 'd62a234e0d9f59d8240292e2042e50e7d1da3c668a0636bf5930fcaac5b52224', 1, 1, 1),        -- plaintext: vitopass1
  (2, 'Underboss', 'underboss@family.test', 'ad5729a45428b40f65f0bb98f213872dc0f12727938ccc7cfd5623a3de600d43', 1, 1, 1), -- plaintext: underbosspass2
  (3, 'Soldier', 'soldier@family.test', '3cf74ece85a49a6d02f53cf8c230edb71bcd3f8875228b808f5e663a3c21bf6e', 1, 1, 1),     -- plaintext: soldierpass3
  (4, 'LoneWolf', NULL, '413561a00a38a8ef52a938b55c06dd84361fa98178703dcea62ab7f0c138ba21', 1, 1, 1),                     -- plaintext: lonewolfpass4
  (5, 'GhostGangMember', NULL, '637f7e11c418a91661037112b6b3f5f7665f977ce8300471e6b6e440809a9b78', 1, 1, 1),            -- plaintext: ghostpass5
  (6, 'OldTimer', NULL, '37701a2e572407c9b8e1f811a3b2c9eb738b529ae0d6a324b419d20d138edc8d', 2, 1, 1);                    -- plaintext: oldpass6 (admin, role 2)

-- userStats. US_gang: 1 = DonVito's gang (id 1), but DonVito's OWN row is
-- US_gang = 0 — the boss is deliberately not a member of his own gang
-- (§4.2 item 5 cross-check). GhostGangMember's US_gang = 99, a gang that
-- does not exist (orphan membership, §4.2 item 4).
INSERT INTO userStats (US_id, US_money, US_bank, US_bullets, US_exp, US_health, US_backfire, US_points, US_weapon, US_armor, US_rank, US_gang, US_location, US_pic, US_bio, US_crimes) VALUES
  (1, 2100000000, 500000, 1000, 5000, 100, 0, 100, 1, 2, 2, 0, 1, NULL, 'Head of the family', '50-40-30'),
  (2, 800000, 200000, 500, 3000, 100, 0, 50, 0, 0, 2, 1, 1, NULL, NULL, '20-20-20-20-20-20'),
  (3, 15000, 5000, 100, 800, 100, 0, 0, 0, 0, 1, 1, 2, NULL, NULL, '10'),
  (4, 500, 0, 20, 50, 100, 0, 0, 0, 0, 1, 0, 1, NULL, NULL, '35-25-15-5-5'),
  (5, 100, 0, 10, 10, 100, 0, 0, 0, 0, 1, 99, 1, NULL, NULL, '35-25-15-5-5'),
  (6, 250, 0, 5, 5, 100, 0, 0, 0, 0, 1, 0, 1, NULL, NULL, '35-25-15-5-5');

-- Timers. user 999 does not exist (orphan). 'jail'/'hospital' are the two
-- keys promoted to typed player_stats columns; 'someCustomModuleKey' is not
-- in SPEC §1.2's observed-keys list and must still migrate (§1.2: "Custom
-- modules add arbitrary keys — migrate ALL rows, known or not").
INSERT INTO userTimers (UT_user, UT_key, UT_time) VALUES
  (1, 'jail', 2100000000),        -- future (year 2036) — maps to player_stats.jailed_until
  (1, 'hospital', 1000000000),    -- past — dropped
  (3, 'crime', 2100000000),       -- future — generic player_timers row
  (3, 'someCustomModuleKey', 2100000000), -- future, unknown key — still migrated + reported
  (999, 'crime', 2100000000);     -- orphan: user 999 does not exist

-- Gangs. G_boss=1 (DonVito) but DonVito's own userStats.US_gang=0 above.
INSERT INTO gangs (G_id, G_name, G_boss, G_underboss, G_bank, G_money, G_level, G_location) VALUES
  (1, 'The Family', 1, 2, 900000000, 500, 5, 1);

INSERT INTO gangPermissions (GP_user, GP_access) VALUES
  (3, 'kick'),   -- Soldier, US_gang=1 — migrates normally
  (4, 'invite'), -- LoneWolf, US_gang=0 — dropped, gangless (§1.2 quirk)
  (999, 'ghost'); -- orphan: user 999 does not exist

INSERT INTO gangInvites (GI_gang, GI_user, GI_invitedBy, GI_time) VALUES
  (1, 4, 1, 1700000100),
  (99, 4, 1, 1700000100); -- orphan: gang 99 does not exist

INSERT INTO gangLogs (GL_gang, GL_user, GL_message, GL_time) VALUES
  (1, 1, 'Founded the family', 1700000000),
  (1, NULL, 'System: round started', 1700000050), -- system log, no user — not an orphan
  (99, 1, 'Ghost log', 1700000000); -- orphan: gang 99 does not exist

-- Inventory / garage / properties
INSERT INTO userInventory (UI_user, UI_item, UI_qty) VALUES
  (1, 1, 5),
  (4, 99, 1),  -- orphan: item 99 does not exist
  (88, 1, 1);  -- orphan: user 88 does not exist
INSERT INTO garage (GA_user, GA_car, GA_damage, GA_location) VALUES
  (1, 1, 10, 1),
  (77, 1, 0, 1); -- orphan: user 77 does not exist
-- Only locations 1 and 2 are seeded above. Task 4 re-keyed the plugin table
-- to (location_id, plugin_id), so location 1 now carries two rows — 'casino'
-- and 'bullets' — to exercise both V2 owner sentinels (0 = unowned,
-- -1 = closed) without colliding on the new key. The -1 row (location 2) is
-- the load-bearing one: it is the only case that distinguishes a correct
-- `PR_user > 0` check from a buggy `PR_user !== 0` one, which would wrongly
-- pass -1 to the user lookup and report a spurious orphan.
INSERT INTO properties (PR_location, PR_module, PR_user, PR_cost, PR_profit) VALUES
  (1, 'casino', 1, 5000, 100),
  (1, 'bullets', 0, 250, 0),     -- PR_user = 0: unowned
  (2, 'bullets', -1, 250, 0),    -- PR_user = -1: closed, migrates as unowned
  (99, 'casino', 1, 5000, 100);  -- orphan: location 99 does not exist

-- Social
INSERT INTO bounties (B_user, B_userToKill, B_cost, B_time) VALUES
  (1, 3, 1000, 1700000200),
  (1, 999, 1000, 1700000200); -- orphan: target 999 does not exist
INSERT INTO detectives (D_user, D_target, D_start, D_end, D_success) VALUES
  (1, 3, 1700000000, 2100000000, NULL);
INSERT INTO mail (M_id, M_parent, M_sender, M_recipient, M_subject, M_body, M_read, M_type, M_time) VALUES
  (1, NULL, 1, 3, 'Hi', 'Welcome to the family.', 1, 0, 1700000300),
  (2, 1, 3, 1, 'Re: Hi', 'Thanks, boss.', 0, 0, 1700000400),  -- thread root walks to message 1
  (3, NULL, NULL, 1, 'System notice', 'Server maintenance tonight.', 0, 1, 1700000500), -- system mail, no sender
  (4, NULL, 1, 999, 'Lost', 'nobody home', 0, 0, 1700000600); -- orphan: recipient 999 does not exist
INSERT INTO notifications (N_user, N_body, N_read, N_time) VALUES
  (1, 'Welcome to GL3', 0, 1700000000),
  (999, 'Ghost notification', 0, 1700000000); -- orphan: user 999 does not exist
INSERT INTO gameNews (GN_author, GN_title, GN_body, GN_time) VALUES
  (1, 'Season 1 begins', 'Good luck.', 1700000000),
  (NULL, 'System announcement', 'Automated post.', 1700000100); -- system news, no author

-- A genuinely custom module table's data — irrelevant to migration, present
-- only so the preflight test (Task 9) has a real unknown table to detect.
INSERT INTO blackjackHands (BJ_user, BJ_result) VALUES (1, 'win');
