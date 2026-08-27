-- The MCCodes fixture seed (plan Task 7): every edge the migrators must
-- handle. Fixed epochs (1754000000 ≈ 2025-08-31); password digests are
-- placeholders — the migrator copies them verbatim, and the login-upgrade
-- math is already pinned in apps/server's auth tests.

-- Identity: u1 salted member mid-everything (both banks, pools drained, both
-- weapon slots + armor, donator, gang, employment); u2 unsalted admin
-- (cyber-bank only, jailed, hp=1, full pools); u3 fresh victim (no bank,
-- hospital, in-flight course + job, divergent login_name, fedjailed).
INSERT INTO users (userid, username, userpass, level, exp, money, crystals, laston,
  job, energy, will, maxwill, brave, maxbrave, maxenergy, hp, maxhp,
  location, hospital, jail, jail_reason, user_level, signedup, gang, daysingang,
  course, cdays, jobrank, donatordays, email, login_name, bankmoney, cybermoney,
  crimexp, equip_primary, equip_secondary, equip_armor, pass_salt) VALUES
(1, 'Muggy', 'hash_muggy_salted', 5, 1234.5678, 2500, 40, 1756000000,
  1, 7, 60, 100, 3, 5, 12, 84, 100,
  1, 0, 0, '', 1, 1754000000, 1, 45,
  0, 0, 1, 3, 'muggy@example.com', 'Muggy', 5000, -1,
  8500, 1, 2, 3, 'abcd1234'),
(2, 'BigSal', '5f4dcc3b5aa765d61d8327deb882cf99', 22, 50000.5000, 900000, 0, 1756050000,
  0, 12, 100, 100, 5, 5, 12, 1, 150,
  1, 0, 12, 'Failed bust', 2, 1750000000, 1, 300,
  0, 0, 0, 0, 'bigsal@example.com', 'BigSal', -1, 20000,
  120000, 0, 0, 0, ''),
(3, 'Newbie', 'hash_newbie_salted', 1, 0.0000, 100, 5, 1756100000,
  1, 2, 20, 80, 1, 3, 10, 50, 100,
  2, 30, 0, '', 1, 1756090000, 0, 0,
  2, 3, 2, 0, 'newbie@example.com', 'newbie_login', -1, -1,
  0, 0, 0, 0, '9182f7de');

-- u4's stats row without a users row: the orphan case.
INSERT INTO userstats VALUES
(1, 123.5, 80.25, 60, 90.75, 42.5),
(2, 500, 300.5, 250, 400, 600),
(3, 10, 10, 10, 10, 12.5),
(99, 999, 999, 999, 999, 999);

INSERT INTO staff_roles (id, name, administrator, credit_all_users, credit_item,
  credit_user, edit_newspaper, manage_challenge_bots, manage_cities, manage_courses,
  manage_crimes, manage_donator_packs, manage_forums, manage_gangs, manage_houses,
  manage_items, manage_jobs, manage_player_reports, manage_polls, manage_punishments,
  manage_roles, manage_shops, manage_staff, manage_users, mass_mail, use_staff_forums,
  view_logs, view_user_inventory) VALUES
(1, 'Administrator', true, true, true, true, true, true, true, true, true, true,
  true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true),
(2, 'Secretary', false, false, false, false, false, false, false, false, false,
  false, false, false, false, false, false, false, false, true, false, false, false,
  false, false, true, false, true),
(3, 'Assistant', false, false, false, false, false, false, false, false, false,
  false, false, false, false, false, false, false, false, true, false, false, false,
  false, false, false, false, false);

INSERT INTO users_roles (id, userid, staff_role) VALUES (1, 2, 1);

INSERT INTO cities VALUES (1, 'Default City', 'Where everyone starts.', 0),
                          (2, 'Uptown', 'The fancy district.', 5);
INSERT INTO crimegroups VALUES (1, 'Beginner', 1), (2, 'Serious', 2);
INSERT INTO crimes (crimeID, crimeNAME, crimeBRAVE, crimePERCFORM, crimeSUCCESSMUNY,
  crimeSUCCESSCRYS, crimeSUCCESSITEM, crimeGROUP, crimeITEXT, crimeSTEXT, crimeFTEXT,
  crimeJTEXT, crimeJAILTIME, crimeJREASON, crimeXP) VALUES
(1, 'Pickpocket', 2, 'min(95, 10 + CRIMEXP / 100)', 300, 0, 0, 1,
  'You spot a mark.', 'Wallet lifted.', 'They saw you.', 'You were caught.', 3, 'Pickpocketing', 7),
(2, 'Museum Heist', 5, 'min(90, max(5, LEVEL * 8))', 5000, 2, 0, 2,
  'Night falls.', 'Clean sweep.', 'Alarm!', 'Caught red-handed.', 20, 'Grand theft', 40),
(3, 'Cursed Job', 3, 'rand(1,100) + LEVEL', 1000, 0, 0, 1,
  'Odd offer.', 'Paid.', 'Nope.', 'Jailed.', 5, 'Curses', 10);

INSERT INTO houses VALUES (1, 'Default House', 0, 100), (2, 'Manor', 250000, 250);
INSERT INTO courses VALUES
(1, 'Basic Fitness', 'Three days of pain.', 500, 0, 3, 2, 1, 1, 0, 0),
(2, 'Study Group', 'Book club with stakes.', 900, 0, 7, 0, 0, 0, 0, 5);
INSERT INTO coursesdone VALUES (1, 2);
INSERT INTO jobs VALUES (1, 'Labourer', 1, 'Move crates.', 0);
INSERT INTO jobranks VALUES
(1, 'Apprentice', 1, 150, 0, 1, 1, 0, 10, 10),
(2, 'Foreman', 1, 400, 1, 2, 2, 20, 50, 50);

-- itmid 1/2 are melee weapons (flat `weapon`), 3 armor, 4 an effect-bearing
-- item in MCCodes' PHP-serialized effect shape.
INSERT INTO itemtypes VALUES (1, 'Weapon'), (2, 'Armor');
INSERT INTO items (itmid, itmtype, itmname, itmdesc, itmbuyprice, itmsellprice,
  itmbuyable, effect1_on, effect1, effect2_on, effect2, effect3_on, effect3, weapon, armor) VALUES
(1, 1, 'Rusty Knife', 'It saw better days.', 500, 250, 1, 0, '', 0, '', 0, '', 10, 0),
(2, 1, 'Sharp Knife', 'Recently sharpened.', 1200, 600, 1, 0, '', 0, '', 0, '', 16, 0),
(3, 2, 'Leather Vest', 'Better than nothing.', 800, 400, 1, 0, '', 0, '', 0, '', 0, 25),
(4, 1, 'Vial of Will', 'Restores 25% will.', 2000, 1000, 1, 1,
  'a:4:{s:8:"inc_type";s:7:"percent";s:4:"stat";s:4:"will";s:3:"dir";s:3:"pos";s:10:"inc_amount";i:25;}',
  0, '', 0, '', 0, 0);
INSERT INTO shops VALUES (1, 1, 'Corner Store', 'Everything a criminal needs.');
INSERT INTO shopitems VALUES (1, 1, 1), (2, 1, 3);
-- Row 5 references item 99, which does not exist — the B4 orphan case.
INSERT INTO inventory VALUES (1, 1, 1, 1), (2, 3, 1, 1), (3, 4, 1, 3), (4, 2, 2, 1),
                             (5, 99, 1, 2);

INSERT INTO gangs VALUES (1, 'The Syndicate', 'Old money, older grudges.', 'Wise', 'Guy',
  750000, 30, 240, 2, 1, 10, 0, 0, '');
INSERT INTO gangevents VALUES (1, 1, 1755000000, 'The vault received a donation.');
INSERT INTO gangwars VALUES (1, 1, 0, 1755000000);
INSERT INTO surrenders VALUES (1, 1, 0, 1, 'We give up.');
INSERT INTO applications VALUES (1, 3, 1, 'Let me in, I own a knife.');

INSERT INTO friendslist VALUES (1, 1, 2, 'oldest friend');
INSERT INTO contactlist VALUES (1, 1, 2);
INSERT INTO blacklist VALUES (1, 1, 3, 'shady');

INSERT INTO mail VALUES
(1, 1, 2, 1, 1755500000, 'Hello', 'Welcome to the game.'),
(2, 0, 0, 1, 1755550000, 'System', 'Your account was created.');
INSERT INTO events VALUES
(1, 1, 1755600000, 1, 'You were mugged.'),
(2, 2, 1755600001, 0, 'Someone busted you out.');
INSERT INTO announcements VALUES ('Welcome to the game.', 1754000000),
                                ('Second announcement.', 1754100000);

INSERT INTO forum_forums (ff_id, ff_name, ff_desc, ff_posts, ff_topics, ff_lp_time,
  ff_lp_poster_id, ff_lp_poster_name, ff_lp_t_id, ff_lp_t_name, ff_auth, ff_owner) VALUES
(1, 'General', 'Public chat', 1, 1, 1755200000, 1, 'Muggy', 1, 'First topic', 'public', -1),
(2, 'Staff Room', 'Staff only', 1, 1, 1755300000, 2, 'BigSal', 2, 'Staff topic', 'staff', -1);
INSERT INTO forum_topics (ft_id, ft_forum_id, ft_name, ft_desc, ft_posts, ft_owner_id,
  ft_owner_name, ft_start_time, ft_last_id, ft_last_name, ft_last_time, ft_pinned, ft_locked) VALUES
(1, 1, 'First topic', '', 1, 1, 'Muggy', 1755200000, 1, 'Muggy', 1755200000, 0, 0),
(2, 2, 'Staff topic', '', 1, 2, 'BigSal', 1755300000, 2, 'BigSal', 1755300000, 0, 0);
INSERT INTO forum_posts (fp_id, fp_topic_id, fp_forum_id, fp_poster_id, fp_poster_name,
  fp_time, fp_subject, fp_text) VALUES
(1, 1, 1, 1, 'Muggy', 1755200000, 'Hello', 'First post!'),
(2, 2, 2, 2, 'BigSal', 1755300000, 'Secrets', 'Staff-only business.');

-- The three `stole` shapes: a mug amount, the hospitalized sentinel (-1), the
-- left sentinel (-2).
INSERT INTO attacklogs (log_id, attacker, attacked, result, time, stole, attacklog) VALUES
(1, 1, 3, 'won', 1755500000, 500, 'transcript omitted'),
(2, 2, 1, 'won', 1755500100, -1, 'transcript omitted'),
(3, 3, 1, 'lost', 1755500200, -2, 'transcript omitted');

INSERT INTO fedjail VALUES (1, 3, 2, 2, 'Cheating');

INSERT INTO settings (conf_id, conf_name, conf_value, data_type) VALUES
(1, 'ct_refillprice', '12', 'num'),
(2, 'ct_iqpercrys', '5', 'num'),
(3, 'ct_moneypercrys', '200', 'num'),
(4, 'game_name', 'Mob City', 'text'),
(5, 'game_owner', 'The Owner', 'text'),
(6, 'jail_count', '20', 'num');

-- One row each in every drop+report table, so the report's counts have
-- something real to count.
INSERT INTO preports VALUES (1, 3, 1, 'spam report');
INSERT INTO referals VALUES (1, 2, 3, 1754000000, '10.0.0.2', '10.0.0.3');
INSERT INTO polls (id, active, question, choice1, choice2) VALUES (1, 1, 'Best crew?', 'Syndicate', 'Nobody');
INSERT INTO papercontent VALUES ('The Daily Mob');
INSERT INTO votes VALUES (1, 'toplist');
INSERT INTO challengebots VALUES (5, 500);
INSERT INTO challengesbeaten VALUES (1, 5);
INSERT INTO dps_accepted VALUES (1, 2, 2, 'dp', 1754000000, 'txn-1');
INSERT INTO willps_accepted VALUES (1, 2, 2, '100', 1754000000, 'txn-2');
INSERT INTO oclogs VALUES (1, 1, 1, 'The heist ran.', 'success', 50000, 'Museum Job', 1755400000);
INSERT INTO crystalmarket VALUES (1, 10, 1, 2500);
INSERT INTO itemmarket VALUES (1, 1, 1, 999, 'money', 1);
INSERT INTO stafflog VALUES (1, 2, 1754100000, 'edited a crime', '10.0.0.2');
INSERT INTO staffnotelogs VALUES (1, 2, 3, 1754100000, 'old note', 'new note');
INSERT INTO jaillogs VALUES (1, 2, 3, 5, 'Cheating', 1754100000);
INSERT INTO unjaillogs VALUES (1, 2, 3, 1754100500);
INSERT INTO cashxferlogs VALUES (1, 1, 2, 1000, 1755000000, '10.0.0.1', '10.0.0.2');
INSERT INTO bankxferlogs VALUES (1, 1, 2, 1000, 1755000000, '10.0.0.1', '10.0.0.2', 'bank');
INSERT INTO crystalxferlogs VALUES (1, 1, 2, 10, 1755000000, '10.0.0.1', '10.0.0.2');
INSERT INTO itemxferlogs VALUES (1, 1, 2, 1, 1, 1755000000, '10.0.0.1', '10.0.0.2');
INSERT INTO itembuylogs VALUES (1, 1, 1, 500, 1, 1755000000, 'bought');
INSERT INTO itemselllogs VALUES (1, 1, 1, 250, 1, 1755000000, 'sold');
INSERT INTO imarketaddlogs VALUES (1, 1, 999, 1, 1, 1755000000, 'listed');
INSERT INTO imbuylogs VALUES (1, 1, 1, 2, 999, 1, 1, 1755000000, 'bought listing');
INSERT INTO imremovelogs VALUES (1, 1, 1, 2, 1, 1, 1755000000, 'removed listing');
INSERT INTO orgcrimes VALUES (1, 'Museum Job', 3, 'The crew gathers.', 'Clean sweep.',
  'Alarm!', 10000, 60000);
INSERT INTO cron_times (id, name, last_run) VALUES (1, 'minute-1', '2026-08-01 00:00:00');
