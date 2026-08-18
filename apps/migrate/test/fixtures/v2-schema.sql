-- Reconstructed from SPEC.md §1.2 (V2's install/schema.sql is not checked
-- out in this repo). See "Known unknowns" in the M4 plan for every column
-- this file infers rather than quotes directly from SPEC.

CREATE TABLE users (
  U_id INT(11) NOT NULL AUTO_INCREMENT,
  U_name VARCHAR(30) NOT NULL,
  U_email VARCHAR(255) DEFAULT NULL,
  U_password CHAR(64) NOT NULL,
  U_userLevel INT(11) NOT NULL DEFAULT 1,
  U_status INT(11) NOT NULL DEFAULT 1,
  U_round INT(11) NOT NULL DEFAULT 1,
  PRIMARY KEY (U_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE userStats (
  US_id INT(11) NOT NULL,
  US_money INT(11) NOT NULL DEFAULT 0,
  US_bank INT(11) NOT NULL DEFAULT 0,
  US_bullets INT(11) NOT NULL DEFAULT 0,
  US_exp INT(11) NOT NULL DEFAULT 0,
  US_health INT(11) NOT NULL DEFAULT 100,
  US_backfire INT(11) NOT NULL DEFAULT 0,
  US_points INT(11) NOT NULL DEFAULT 0,
  US_weapon INT(11) NOT NULL DEFAULT 0,
  US_armor INT(11) NOT NULL DEFAULT 0,
  US_rank INT(11) NOT NULL DEFAULT 1,
  US_gang INT(11) NOT NULL DEFAULT 0,
  US_location INT(11) DEFAULT NULL,
  US_pic VARCHAR(255) DEFAULT NULL,
  US_bio TEXT,
  US_shotBy INT(11) DEFAULT NULL,
  US_crimes VARCHAR(500) NOT NULL DEFAULT '35-25-15-5-5',
  PRIMARY KEY (US_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE userTimers (
  UT_id INT(11) NOT NULL AUTO_INCREMENT,
  UT_user INT(11) NOT NULL,
  UT_key VARCHAR(50) NOT NULL,
  UT_time INT(11) NOT NULL,
  PRIMARY KEY (UT_id),
  KEY UT_user (UT_user)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE ranks (
  R_id INT(11) NOT NULL AUTO_INCREMENT,
  R_name VARCHAR(50) NOT NULL,
  R_exp INT(11) NOT NULL,
  R_cashReward INT(11) NOT NULL DEFAULT 0,
  R_bulletReward INT(11) NOT NULL DEFAULT 0,
  R_health INT(11) NOT NULL DEFAULT 100,
  PRIMARY KEY (R_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE moneyRanks (
  MR_id INT(11) NOT NULL AUTO_INCREMENT,
  MR_label VARCHAR(50) NOT NULL,
  MR_threshold INT(11) NOT NULL,
  PRIMARY KEY (MR_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE userRoles (
  UR_id INT(11) NOT NULL AUTO_INCREMENT,
  UR_name VARCHAR(50) NOT NULL,
  UR_color VARCHAR(20) DEFAULT NULL,
  PRIMARY KEY (UR_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE roleAccess (
  RA_id INT(11) NOT NULL AUTO_INCREMENT,
  RA_role INT(11) NOT NULL,
  RA_module VARCHAR(50) NOT NULL,
  PRIMARY KEY (RA_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- RND_ prefix, not R_ — see "Known unknowns" item 1.
CREATE TABLE rounds (
  RND_id INT(11) NOT NULL AUTO_INCREMENT,
  RND_name VARCHAR(50) NOT NULL,
  RND_start INT(11) NOT NULL,
  RND_end INT(11) DEFAULT NULL,
  PRIMARY KEY (RND_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE crimes (
  C_id INT(11) NOT NULL AUTO_INCREMENT,
  C_name VARCHAR(100) NOT NULL,
  C_description TEXT,
  C_cooldown INT(11) NOT NULL DEFAULT 60,
  C_money INT(11) NOT NULL DEFAULT 0,
  C_maxMoney INT(11) NOT NULL DEFAULT 0,
  C_bullets INT(11) NOT NULL DEFAULT 0,
  C_maxBullets INT(11) NOT NULL DEFAULT 0,
  C_exp INT(11) NOT NULL DEFAULT 0,
  C_level INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (C_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE locations (
  L_id INT(11) NOT NULL AUTO_INCREMENT,
  L_name VARCHAR(100) NOT NULL,
  L_cost INT(11) NOT NULL DEFAULT 0,
  L_cooldown INT(11) NOT NULL DEFAULT 0,
  L_bullets INT(11) NOT NULL DEFAULT 0,
  L_bulletCost INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (L_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE cars (
  CA_id INT(11) NOT NULL AUTO_INCREMENT,
  CA_name VARCHAR(100) NOT NULL,
  CA_value INT(11) NOT NULL DEFAULT 0,
  CA_theftChance INT(11) NOT NULL DEFAULT 1,
  PRIMARY KEY (CA_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE theft (
  T_id INT(11) NOT NULL AUTO_INCREMENT,
  T_name VARCHAR(100) NOT NULL,
  T_chance INT(11) NOT NULL,
  T_maxDamage INT(11) NOT NULL DEFAULT 0,
  T_worstCar INT(11) NOT NULL DEFAULT 0,
  T_bestCar INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (T_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE weapons (
  W_id INT(11) NOT NULL AUTO_INCREMENT,
  W_name VARCHAR(100) NOT NULL,
  W_accuracy INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (W_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE items (
  I_id INT(11) NOT NULL AUTO_INCREMENT,
  I_name VARCHAR(100) NOT NULL,
  I_type VARCHAR(50) NOT NULL,
  PRIMARY KEY (I_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE itemEffects (
  IE_id INT(11) NOT NULL AUTO_INCREMENT,
  IE_item INT(11) NOT NULL,
  IE_effect VARCHAR(50) NOT NULL,
  IE_value INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (IE_id),
  KEY IE_item (IE_item)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE itemMeta (
  IM_id INT(11) NOT NULL AUTO_INCREMENT,
  IM_item INT(11) NOT NULL,
  IM_key VARCHAR(50) NOT NULL,
  IM_value VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (IM_id),
  KEY IM_item (IM_item)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- Recognised V2 core table, deliberately NOT migrated in v1 (SPEC §5: no
-- membership table in the GL3 §2.5 schema). Present here so the preflight
-- test (Task 9) can assert it is reported as a known-but-unsupported table.
CREATE TABLE premiumMembership (
  PM_id INT(11) NOT NULL AUTO_INCREMENT,
  PM_name VARCHAR(100) NOT NULL,
  PM_seconds INT(11) NOT NULL,
  PM_cost INT(11) NOT NULL,
  PRIMARY KEY (PM_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE settings (
  S_key VARCHAR(100) NOT NULL,
  S_value TEXT,
  PRIMARY KEY (S_key)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE gangs (
  G_id INT(11) NOT NULL AUTO_INCREMENT,
  G_name VARCHAR(100) NOT NULL,
  G_boss INT(11) NOT NULL,
  G_underboss INT(11) DEFAULT NULL,
  G_bank INT(11) NOT NULL DEFAULT 0,
  G_money INT(11) NOT NULL DEFAULT 0,
  G_level INT(11) NOT NULL DEFAULT 1,
  G_location INT(11) DEFAULT NULL,
  PRIMARY KEY (G_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE gangPermissions (
  GP_id INT(11) NOT NULL AUTO_INCREMENT,
  GP_user INT(11) NOT NULL,
  GP_access VARCHAR(50) NOT NULL,
  PRIMARY KEY (GP_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE gangInvites (
  GI_id INT(11) NOT NULL AUTO_INCREMENT,
  GI_gang INT(11) NOT NULL,
  GI_user INT(11) NOT NULL,
  GI_invitedBy INT(11) NOT NULL,
  GI_time INT(11) NOT NULL,
  PRIMARY KEY (GI_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE gangLogs (
  GL_id INT(11) NOT NULL AUTO_INCREMENT,
  GL_gang INT(11) NOT NULL,
  GL_user INT(11) DEFAULT NULL,
  GL_message VARCHAR(255) NOT NULL,
  GL_time INT(11) NOT NULL,
  PRIMARY KEY (GL_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE userInventory (
  UI_user INT(11) NOT NULL,
  UI_item INT(11) NOT NULL,
  UI_qty INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (UI_user, UI_item)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE garage (
  GA_id INT(11) NOT NULL AUTO_INCREMENT,
  GA_user INT(11) NOT NULL,
  GA_car INT(11) NOT NULL,
  GA_damage INT(11) NOT NULL DEFAULT 0,
  GA_location INT(11) DEFAULT NULL,
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

CREATE TABLE bounties (
  B_id INT(11) NOT NULL AUTO_INCREMENT,
  B_user INT(11) NOT NULL,
  B_userToKill INT(11) NOT NULL,
  B_cost INT(11) NOT NULL,
  B_time INT(11) NOT NULL,
  PRIMARY KEY (B_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE detectives (
  D_id INT(11) NOT NULL AUTO_INCREMENT,
  D_user INT(11) NOT NULL,
  D_target INT(11) NOT NULL,
  D_start INT(11) NOT NULL,
  D_end INT(11) NOT NULL,
  D_success INT(11) DEFAULT NULL,
  PRIMARY KEY (D_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE mail (
  M_id INT(11) NOT NULL AUTO_INCREMENT,
  M_parent INT(11) DEFAULT NULL,
  M_sender INT(11) DEFAULT NULL,
  M_recipient INT(11) NOT NULL,
  M_subject VARCHAR(255) NOT NULL,
  M_body TEXT,
  M_read INT(11) NOT NULL DEFAULT 0,
  M_type INT(11) NOT NULL DEFAULT 0,
  M_time INT(11) NOT NULL,
  PRIMARY KEY (M_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE notifications (
  N_id INT(11) NOT NULL AUTO_INCREMENT,
  N_user INT(11) NOT NULL,
  N_body VARCHAR(255) NOT NULL,
  N_read INT(11) NOT NULL DEFAULT 0,
  N_time INT(11) NOT NULL,
  PRIMARY KEY (N_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

CREATE TABLE gameNews (
  GN_id INT(11) NOT NULL AUTO_INCREMENT,
  GN_author INT(11) DEFAULT NULL,
  GN_title VARCHAR(255) NOT NULL,
  GN_body TEXT,
  GN_time INT(11) NOT NULL,
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

CREATE TABLE posts (
  P_id INT(11) NOT NULL AUTO_INCREMENT,
  P_date INT(11) NOT NULL,
  P_user INT(11) NOT NULL,
  P_body TEXT,
  P_topic INT(11) NOT NULL,
  PRIMARY KEY (P_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;

-- A genuine third-party/custom module table (e.g. a casino sub-module),
-- present in a real dump but never core V2. Preflight (Task 9) must report
-- this the same way it reports premiumMembership: "custom module table, not
-- migrated" — the migrator does not distinguish "unsupported core" from
-- "truly custom", by design (see "Known unknowns" preamble above Task 9).
CREATE TABLE blackjackHands (
  BJ_id INT(11) NOT NULL AUTO_INCREMENT,
  BJ_user INT(11) NOT NULL,
  BJ_result VARCHAR(20) NOT NULL,
  PRIMARY KEY (BJ_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;
