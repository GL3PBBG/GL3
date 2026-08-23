-- Mirrors V2's real install/schema.sql (ChristopherDay/Gangster-Legends-V2
-- @master, last pushed 2024-05-05) plus the DDL its modules/installed/
-- {inventory,membership,rounds}/schema.sql files re-create — column names,
-- nullability, defaults and primary keys verbatim. Earlier revisions of this
-- file inferred plausible-looking names from SPEC prose (UT_key, S_key,
-- M_sender, MR_label, ...) that exist in no V2 release, which the migrator
-- then quietly matched; keeping this file byte-honest is what stops that
-- class of bug from coming back.
--
-- Deliberate deviations from upstream, all test-motivated:
--   * blackjackHands — not a V2 table at all; a stand-in custom module table
--     so preflight has a real "unknown table" to detect.
--   * forumAccess / topicReads — upstream core tables the migrator does not
--     migrate; a real dump reports them (with blackjackHands) as unknown.
--   * forums.F_id has no AUTO_INCREMENT (gang forums use negative ids by
--     convention, inserted explicitly — see the seed).

CREATE TABLE users (
  U_id INT(11) NOT NULL AUTO_INCREMENT,
  U_name VARCHAR(30) DEFAULT NULL,
  U_email VARCHAR(100) DEFAULT NULL,
  U_password VARCHAR(255) NOT NULL DEFAULT '',
  U_userLevel INT(1) DEFAULT NULL,
  U_status INT(1) DEFAULT NULL,
  U_round INT(11) NOT NULL DEFAULT 1,
  PRIMARY KEY (U_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE userStats (
  US_id INT(11) NOT NULL,
  US_shotBy INT(11) NOT NULL DEFAULT 0,
  US_health INT(11) NOT NULL DEFAULT 0,
  US_exp INT(11) NOT NULL DEFAULT 0,
  US_money INT(11) NOT NULL DEFAULT 250,
  US_bank INT(11) NOT NULL DEFAULT 0,
  US_bullets INT(11) NOT NULL DEFAULT 100,
  US_backfire INT(11) NOT NULL DEFAULT 50,
  US_points INT(11) NOT NULL DEFAULT 0,
  US_pic VARCHAR(200) NOT NULL DEFAULT 'themes/default/images/default-profile-picture.png',
  US_bio VARCHAR(1000) NOT NULL DEFAULT '0',
  US_weapon INT(11) NOT NULL DEFAULT 0,
  US_armor INT(11) NOT NULL DEFAULT 0,
  US_rank INT(11) NOT NULL DEFAULT 1,
  US_gang INT(11) NOT NULL DEFAULT 0,
  US_location INT(11) NOT NULL DEFAULT 1,
  US_crimes VARCHAR(255) NOT NULL DEFAULT '35-25-15-5-5-5-5-5-5-5-5-5-5-5-5',
  PRIMARY KEY (US_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- No primary key at all upstream — (UT_user, UT_desc) is unique only by
-- convention; rows are auto-created on first use.
CREATE TABLE userTimers (
  UT_user INT(11) NOT NULL DEFAULT 0,
  UT_desc VARCHAR(32) DEFAULT NULL,
  UT_time INT(11) NOT NULL
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE ranks (
  R_id INT(11) NOT NULL AUTO_INCREMENT,
  R_name VARCHAR(100) DEFAULT NULL,
  R_exp INT(11) NOT NULL DEFAULT 0,
  R_limit INT(11) NOT NULL DEFAULT 0,
  R_cashReward INT(11) NOT NULL DEFAULT 0,
  R_health INT(11) NOT NULL DEFAULT 0,
  R_bulletReward INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (R_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE moneyRanks (
  MR_id INT(11) NOT NULL AUTO_INCREMENT,
  MR_desc VARCHAR(128) DEFAULT NULL,
  MR_money INT(11) DEFAULT NULL,
  PRIMARY KEY (MR_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE userRoles (
  UR_id INT(11) NOT NULL AUTO_INCREMENT,
  UR_desc VARCHAR(128) DEFAULT NULL,
  UR_color VARCHAR(7) NOT NULL,
  PRIMARY KEY (UR_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE roleAccess (
  RA_role INT(11) NOT NULL,
  RA_module VARCHAR(128) NOT NULL,
  PRIMARY KEY (RA_role, RA_module)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE rounds (
  R_id INT(11) NOT NULL AUTO_INCREMENT,
  R_name VARCHAR(128) DEFAULT NULL,
  R_start INT(11) DEFAULT NULL,
  R_end INT(11) DEFAULT NULL,
  PRIMARY KEY (R_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- No description column upstream — GL3's crimes.description is an addition.
CREATE TABLE crimes (
  C_id INT(11) NOT NULL AUTO_INCREMENT,
  C_name VARCHAR(120) DEFAULT NULL,
  C_cooldown INT(11) NOT NULL DEFAULT 0,
  C_money INT(11) NOT NULL DEFAULT 0,
  C_maxMoney INT(11) NOT NULL DEFAULT 0,
  C_bullets INT(11) NOT NULL DEFAULT 0,
  C_maxBullets INT(11) NOT NULL DEFAULT 0,
  C_exp INT(11) NOT NULL DEFAULT 1,
  C_level INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (C_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE locations (
  L_id INT(11) NOT NULL AUTO_INCREMENT,
  L_name VARCHAR(120) DEFAULT NULL,
  L_cost INT(11) NOT NULL DEFAULT 0,
  L_bullets INT(11) NOT NULL DEFAULT 0,
  L_bulletCost INT(11) NOT NULL DEFAULT 100,
  L_cooldown INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (L_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE cars (
  CA_id INT(11) NOT NULL AUTO_INCREMENT,
  CA_name VARCHAR(255) DEFAULT NULL,
  CA_value INT(11) NOT NULL DEFAULT 0,
  CA_theftChance INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (CA_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE theft (
  T_id INT(11) NOT NULL AUTO_INCREMENT,
  T_name VARCHAR(255) DEFAULT NULL,
  T_chance INT(11) NOT NULL DEFAULT 0,
  T_maxDamage INT(11) NOT NULL DEFAULT 0,
  T_worstCar INT(11) NOT NULL DEFAULT 0,
  T_bestCar INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (T_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE weapons (
  W_id INT(11) NOT NULL AUTO_INCREMENT,
  W_name VARCHAR(100) DEFAULT NULL,
  W_accuracy INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (W_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- I_type is an int id into the `itemTypes` settings registry, not a string.
CREATE TABLE items (
  I_id INT(11) NOT NULL AUTO_INCREMENT,
  I_name VARCHAR(128) NOT NULL,
  I_type INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (I_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- IE_value is a VARCHAR upstream — numeric strings like '15'.
CREATE TABLE itemEffects (
  IE_effect VARCHAR(32) NOT NULL,
  IE_item INT(11) NOT NULL,
  IE_value VARCHAR(128) NOT NULL,
  IE_desc VARCHAR(128) DEFAULT NULL,
  PRIMARY KEY (IE_effect, IE_item)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE itemMeta (
  IM_item INT(11) NOT NULL,
  IM_meta VARCHAR(32) NOT NULL,
  IM_value TEXT,
  PRIMARY KEY (IM_item, IM_meta)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE premiumMembership (
  PM_id INT(11) NOT NULL AUTO_INCREMENT,
  PM_desc VARCHAR(255) NOT NULL,
  PM_seconds INT(11) NOT NULL,
  PM_cost INT(11) NOT NULL,
  PRIMARY KEY (PM_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- Keyed by S_desc (V2's settings class does WHERE S_desc = :desc).
CREATE TABLE settings (
  S_id INT(11) NOT NULL AUTO_INCREMENT,
  S_desc VARCHAR(255) DEFAULT NULL,
  S_value TEXT,
  PRIMARY KEY (S_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE gangs (
  G_id INT(11) NOT NULL AUTO_INCREMENT,
  G_name VARCHAR(120) DEFAULT NULL,
  G_bank INT(11) NOT NULL DEFAULT 0,
  G_money INT(11) NOT NULL DEFAULT 0,
  G_bullets INT(11) NOT NULL DEFAULT 0,
  G_info TEXT,
  G_desc TEXT,
  G_location INT(11) NOT NULL DEFAULT 0,
  G_boss INT(11) NOT NULL DEFAULT 0,
  G_underboss INT(11) NOT NULL DEFAULT 0,
  G_level INT(11) NOT NULL DEFAULT 1,
  PRIMARY KEY (G_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE gangPermissions (
  GP_id INT(11) NOT NULL AUTO_INCREMENT,
  GP_user INT(11) NOT NULL,
  GP_access VARCHAR(128) NOT NULL,
  PRIMARY KEY (GP_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE gangInvites (
  GI_id INT(11) NOT NULL AUTO_INCREMENT,
  GI_user INT(11) NOT NULL,
  GI_gangUser INT(11) NOT NULL,
  GI_gang INT(11) NOT NULL,
  PRIMARY KEY (GI_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE gangLogs (
  GL_id INT(11) NOT NULL AUTO_INCREMENT,
  GL_gang INT(11) NOT NULL,
  GL_time INT(11) NOT NULL,
  GL_user INT(11) NOT NULL,
  GL_log VARCHAR(255) NOT NULL,
  PRIMARY KEY (GL_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE userInventory (
  UI_user INT(11) NOT NULL,
  UI_item INT(11) NOT NULL,
  UI_qty INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (UI_user, UI_item)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE garage (
  GA_id INT(11) NOT NULL AUTO_INCREMENT,
  GA_uid INT(11) NOT NULL DEFAULT 0,
  GA_car INT(11) NOT NULL DEFAULT 0,
  GA_damage INT(11) NOT NULL DEFAULT 0,
  GA_location INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (GA_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- Verbatim from V2 install/schema.sql. Do NOT "tidy" this: the absent unique
-- constraint on PR_location is real (V2 keys on (PR_location, PR_module) by
-- convention only), and PR_user NOT NULL DEFAULT 0 carries two sentinels -
-- 0 = unowned, -1 = closed.
CREATE TABLE IF NOT EXISTS `properties` (
  `PR_id` INT(11) NOT NULL PRIMARY KEY AUTO_INCREMENT ,
  `PR_location` INT(11) NOT NULL ,
  `PR_module` VARCHAR(128) NOT NULL ,
  `PR_user` int(11) NOT NULL DEFAULT 0,
  `PR_cost` int(11) NOT NULL DEFAULT 0,
  `PR_profit` INT(11) NOT NULL DEFAULT 0
) ENGINE = InnoDB;

-- No timestamp column upstream — B_id/B_user/B_userToKill/B_cost only.
CREATE TABLE bounties (
  B_id INT(11) NOT NULL AUTO_INCREMENT,
  B_user INT(11) NOT NULL DEFAULT 0,
  B_userToKill INT(11) NOT NULL DEFAULT 0,
  B_cost INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (B_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE detectives (
  D_id INT(11) NOT NULL AUTO_INCREMENT,
  D_user INT(11) NOT NULL DEFAULT 0,
  D_userToFind INT(11) NOT NULL DEFAULT 0,
  D_detectives INT(11) NOT NULL DEFAULT 0,
  D_start INT(11) NOT NULL DEFAULT 0,
  D_end INT(11) NOT NULL DEFAULT 0,
  D_success INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (D_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- M_sid = sender, M_uid = recipient; 0 (not NULL) is the system sentinel on
-- M_sid and the no-parent sentinel on M_parent.
CREATE TABLE mail (
  M_id INT(11) NOT NULL AUTO_INCREMENT,
  M_time INT(11) NOT NULL DEFAULT 0,
  M_uid INT(11) NOT NULL DEFAULT 0,
  M_sid INT(11) NOT NULL DEFAULT 0,
  M_subject VARCHAR(120) DEFAULT NULL,
  M_parent INT(11) NOT NULL DEFAULT 0,
  M_text TEXT,
  M_type INT(11) NOT NULL DEFAULT 0,
  M_read INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (M_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE notifications (
  N_id INT(11) NOT NULL AUTO_INCREMENT,
  N_uid INT(11) NOT NULL DEFAULT 0,
  N_time INT(11) NOT NULL DEFAULT 0,
  N_text TEXT,
  N_read INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (N_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE gameNews (
  GN_id INT(11) NOT NULL AUTO_INCREMENT,
  GN_author INT(11) NOT NULL DEFAULT 0,
  GN_title VARCHAR(120) DEFAULT NULL,
  GN_text TEXT,
  GN_date INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (GN_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- Forum (SPEC §1.2 line 81). No AUTO_INCREMENT on F_id: gang forums use
-- negative ids assigned by convention, not by the sequence, and the fixture
-- below inserts both signs explicitly.
CREATE TABLE forums (
  F_id INT(11) NOT NULL,
  F_name VARCHAR(255) NOT NULL,
  F_sort INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (F_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- Upstream core table, empty here: real dumps carry it, the migrator does
-- not migrate it, so preflight reports it as an unknown table.
CREATE TABLE forumAccess (
  FA_role INT(11),
  FA_forum INT(11)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- T_type is a bitmask: 1 = sticky, 2 = important. Both bits can be set on one
-- row (V2 let a topic be marked sticky and important independently); GL3 has
-- one priority tier, so the migrator collapses either bit, or both, to
-- "sticky". T_status: 0 = open, 1 = locked.
CREATE TABLE topics (
  T_id INT(11) NOT NULL AUTO_INCREMENT,
  T_date INT(11) NOT NULL,
  T_user INT(11) NOT NULL,
  T_subject VARCHAR(255) NOT NULL,
  T_forum INT(11) NOT NULL,
  T_status INT(11) NOT NULL DEFAULT 0,
  T_type INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (T_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- Upstream core table, empty here — same preflight treatment as forumAccess.
CREATE TABLE topicReads (
  TR_topic INT(11),
  TR_user INT(11)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE posts (
  P_id INT(11) NOT NULL AUTO_INCREMENT,
  P_topic INT(11) NOT NULL,
  P_date INT(11) NOT NULL,
  P_user INT(11) NOT NULL,
  P_body TEXT,
  PRIMARY KEY (P_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- A genuinely third-party/custom module table (e.g. a casino sub-module),
-- present in a real dump but never core V2. Preflight (Task 9) must report
-- this as "custom module table, not migrated" — the KNOWN_TABLES entry
-- left in that bucket alongside forumAccess/topicReads.
CREATE TABLE blackjackHands (
  BJ_id INT(11) NOT NULL AUTO_INCREMENT,
  BJ_user INT(11) NOT NULL,
  BJ_result VARCHAR(20) NOT NULL,
  PRIMARY KEY (BJ_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;
