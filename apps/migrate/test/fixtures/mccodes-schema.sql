-- The MCCodes v2 source fixture (cluster B, plan 2026-08-26-mccodes-migrator.md
-- Task 7). Reconstructed from the engine's dbdata.sql (audit §5's 63-table
-- catalog; source tree mccodes-v2-engine@30cb0f9) — column names, types,
-- defaults and PK presence match the real installer output, but the DDL is
-- rewritten, not vendored, for the same licensing reason the V2 fixture is a
-- reconstruction. int(11) signed epochs, decimal(11,4) exp, float stats, the
-- six PK-less tables exactly as upstream ships them. No engine clause: a dump
-- read does not care whether MyISAM or InnoDB stored the rows.

-- Identity & progression (8)
CREATE TABLE users (
  userid int(11) NOT NULL auto_increment,
  username varchar(255) NOT NULL default '',
  userpass varchar(255) NOT NULL default '',
  level int(11) NOT NULL default '0',
  exp decimal(11,4) NOT NULL default '0.0000',
  money int(11) NOT NULL default '0',
  crystals int(11) NOT NULL default '0',
  laston int(11) NOT NULL default '0',
  lastip varchar(255) NOT NULL default '',
  job int(11) NOT NULL default '0',
  energy int(11) NOT NULL default '0',
  will int(11) NOT NULL default '0',
  maxwill int(11) NOT NULL default '0',
  brave int(11) NOT NULL default '0',
  maxbrave int(11) NOT NULL default '0',
  maxenergy int(11) NOT NULL default '0',
  hp int(11) NOT NULL default '0',
  maxhp int(11) NOT NULL default '0',
  lastrest_life int(11) NOT NULL default '0',
  lastrest_other int(11) NOT NULL default '0',
  location int(11) NOT NULL default '0',
  hospital int(11) NOT NULL default '0',
  jail int(11) NOT NULL default '0',
  jail_reason varchar(255) NOT NULL default '',
  fedjail int(11) NOT NULL default '0',
  user_level int(11) NOT NULL default '1',
  gender enum('Male','Female') NOT NULL default 'Male',
  daysold int(11) NOT NULL default '0',
  signedup int(11) NOT NULL default '0',
  gang int(11) NOT NULL default '0',
  daysingang int(11) NOT NULL default '0',
  course int(11) NOT NULL default '0',
  cdays int(11) NOT NULL default '0',
  jobrank int(11) NOT NULL default '0',
  donatordays int(11) NOT NULL default '0',
  email varchar(255) NOT NULL default '',
  login_name varchar(255) NOT NULL default '',
  display_pic text NOT NULL,
  duties varchar(255) NOT NULL default 'N/A',
  bankmoney int(11) NOT NULL default '0',
  cybermoney int(11) NOT NULL default '-1',
  staffnotes longtext NOT NULL,
  mailban int(11) NOT NULL default '0',
  mb_reason varchar(255) NOT NULL default '',
  hospreason varchar(255) NOT NULL default '',
  lastip_login varchar(255) NOT NULL default '127.0.0.1',
  lastip_signup varchar(255) NOT NULL default '127.0.0.1',
  last_login int(11) NOT NULL default '0',
  voted text NOT NULL,
  crimexp int(11) NOT NULL default '0',
  attacking int(11) NOT NULL default '0',
  verified int(11) NOT NULL default '0',
  forumban int(11) NOT NULL default '0',
  fb_reason varchar(255) NOT NULL default '',
  posts int(11) NOT NULL default '0',
  forums_avatar varchar(255) NOT NULL default '',
  forums_signature varchar(250) NOT NULL default '',
  new_events int(11) NOT NULL default '0',
  new_mail int(11) NOT NULL default '0',
  friend_count int(11) NOT NULL default '0',
  enemy_count int(11) NOT NULL default '0',
  new_announcements int(11) NOT NULL default '0',
  boxes_opened int(11) NOT NULL default '0',
  user_notepad text NOT NULL,
  equip_primary int(11) NOT NULL default '0',
  equip_secondary int(11) NOT NULL default '0',
  equip_armor int(11) NOT NULL default '0',
  force_logout tinyint(4) NOT NULL default '0',
  pass_salt varchar(8) NOT NULL default '',
  PRIMARY KEY (userid)
);
CREATE TABLE userstats (
  userid int(11) NOT NULL,
  strength float NOT NULL default '0',
  agility float NOT NULL default '0',
  guard float NOT NULL default '0',
  labour float NOT NULL default '0',
  IQ float NOT NULL default '0',
  PRIMARY KEY (userid)
);
CREATE TABLE staff_roles (
  id int(11) NOT NULL auto_increment,
  name varchar(255) NOT NULL default '',
  administrator bool NOT NULL default false,
  credit_all_users bool NOT NULL default false,
  credit_item bool NOT NULL default false,
  credit_user bool NOT NULL default false,
  edit_newspaper bool NOT NULL default false,
  manage_challenge_bots bool NOT NULL default false,
  manage_cities bool NOT NULL default false,
  manage_courses bool NOT NULL default false,
  manage_crimes bool NOT NULL default false,
  manage_donator_packs bool NOT NULL default false,
  manage_forums bool NOT NULL default false,
  manage_gangs bool NOT NULL default false,
  manage_houses bool NOT NULL default false,
  manage_items bool NOT NULL default false,
  manage_jobs bool NOT NULL default false,
  manage_player_reports bool NOT NULL default false,
  manage_polls bool NOT NULL default false,
  manage_punishments bool NOT NULL default false,
  manage_roles bool NOT NULL default false,
  manage_shops bool NOT NULL default false,
  manage_staff bool NOT NULL default false,
  manage_users bool NOT NULL default false,
  mass_mail bool NOT NULL default false,
  use_staff_forums bool NOT NULL default false,
  view_logs bool NOT NULL default false,
  view_user_inventory bool NOT NULL default false,
  PRIMARY KEY (id)
);
CREATE TABLE users_roles (
  id int(11) NOT NULL auto_increment,
  userid int(11) NOT NULL,
  staff_role int(11) NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE coursesdone (userid int(11) NOT NULL, courseid int(11) NOT NULL);
CREATE TABLE inventory (
  inv_id int(11) NOT NULL auto_increment,
  inv_itemid int(11) NOT NULL default '0',
  inv_userid int(11) NOT NULL default '0',
  inv_qty int(11) NOT NULL default '0',
  PRIMARY KEY (inv_id)
);
CREATE TABLE challengesbeaten (userid int(11) NOT NULL, npcid int(11) NOT NULL);
CREATE TABLE votes (userid int(11) NOT NULL, list text NOT NULL);

-- Content (14; stock ships all but cities/houses EMPTY — the seed adds real rows)
CREATE TABLE cities (
  cityid int(11) NOT NULL auto_increment,
  cityname varchar(255) NOT NULL default '',
  citydesc text NOT NULL,
  cityminlevel int(11) NOT NULL default '0',
  PRIMARY KEY (cityid)
);
CREATE TABLE houses (
  hID int(11) NOT NULL auto_increment,
  hNAME varchar(255) NOT NULL default '',
  hPRICE int(11) NOT NULL default '0',
  hWILL int(11) NOT NULL default '100',
  PRIMARY KEY (hID)
);
CREATE TABLE courses (
  crID int(11) NOT NULL auto_increment,
  crNAME varchar(255) NOT NULL default '',
  crDESC text NOT NULL,
  crCOST int(11) NOT NULL default '0',
  crENERGY int(11) NOT NULL default '0',
  crDAYS int(11) NOT NULL default '0',
  crSTR int(11) NOT NULL default '0',
  crGUARD int(11) NOT NULL default '0',
  crLABOUR int(11) NOT NULL default '0',
  crAGIL int(11) NOT NULL default '0',
  crIQ int(11) NOT NULL default '0',
  PRIMARY KEY (crID)
);
CREATE TABLE crimes (
  crimeID int(11) NOT NULL auto_increment,
  crimeNAME varchar(255) NOT NULL default '',
  crimeBRAVE int(11) NOT NULL default '0',
  crimePERCFORM text NOT NULL,
  crimeSUCCESSMUNY int(11) NOT NULL default '0',
  crimeSUCCESSCRYS int(11) NOT NULL default '0',
  crimeSUCCESSITEM int(11) NOT NULL default '0',
  crimeGROUP int(11) NOT NULL default '0',
  crimeITEXT text NOT NULL,
  crimeSTEXT text NOT NULL,
  crimeFTEXT text NOT NULL,
  crimeJTEXT text NOT NULL,
  crimeJAILTIME int(11) NOT NULL default '0',
  crimeJREASON varchar(255) NOT NULL default '',
  crimeXP int(11) NOT NULL default '0',
  PRIMARY KEY (crimeID)
);
CREATE TABLE crimegroups (
  cgID int(11) NOT NULL auto_increment,
  cgNAME varchar(255) NOT NULL default '',
  cgORDER int(11) NOT NULL default '0',
  PRIMARY KEY (cgID)
);
CREATE TABLE itemtypes (
  itmtypeid int(11) NOT NULL auto_increment,
  itmtypename varchar(255) NOT NULL default '',
  PRIMARY KEY (itmtypeid)
);
CREATE TABLE items (
  itmid int(11) NOT NULL auto_increment,
  itmtype int(11) NOT NULL default '1',
  itmname varchar(255) NOT NULL default '',
  itmdesc text NOT NULL,
  itmbuyprice int(11) NOT NULL default '0',
  itmsellprice int(11) NOT NULL default '0',
  itmbuyable int(11) NOT NULL default '1',
  effect1_on tinyint(4) NOT NULL default '0',
  effect1 text NOT NULL,
  effect2_on tinyint(4) NOT NULL default '0',
  effect2 text NOT NULL,
  effect3_on tinyint(4) NOT NULL default '0',
  effect3 text NOT NULL,
  weapon int(11) NOT NULL default '0',
  armor int(11) NOT NULL default '0',
  PRIMARY KEY (itmid)
);
CREATE TABLE shops (
  shopID int(11) NOT NULL auto_increment,
  shopLOCATION int(11) NOT NULL default '0',
  shopNAME varchar(255) NOT NULL default '',
  shopDESCRIPTION text NOT NULL,
  PRIMARY KEY (shopID)
);
CREATE TABLE shopitems (
  sitemID int(11) NOT NULL auto_increment,
  sitemSHOP int(11) NOT NULL default '0',
  sitemITEMID int(11) NOT NULL default '0',
  PRIMARY KEY (sitemID)
);
CREATE TABLE jobs (
  jID int(11) NOT NULL auto_increment,
  jNAME varchar(255) NOT NULL default '',
  jFIRST int(11) NOT NULL default '0',
  jDESC text NOT NULL,
  jOWNER int(11) NOT NULL default '0',
  PRIMARY KEY (jID)
);
CREATE TABLE jobranks (
  jrID int(11) NOT NULL auto_increment,
  jrNAME varchar(255) NOT NULL default '',
  jrJOB int(11) NOT NULL default '0',
  jrPAY int(11) NOT NULL default '0',
  jrIQG int(11) NOT NULL default '0',
  jrLABOURG int(11) NOT NULL default '0',
  jrSTRG int(11) NOT NULL default '0',
  jrIQN int(11) NOT NULL default '0',
  jrLABOURN int(11) NOT NULL default '0',
  jrSTRN int(11) NOT NULL default '0',
  PRIMARY KEY (jrID)
);
CREATE TABLE orgcrimes (
  ocID int(11) NOT NULL auto_increment,
  ocNAME varchar(255) NOT NULL default '',
  ocUSERS int(11) NOT NULL default '0',
  ocSTARTTEXT text NOT NULL,
  ocSUCCTEXT text NOT NULL,
  ocFAILTEXT text NOT NULL,
  ocMINMONEY int(11) NOT NULL default '0',
  ocMAXMONEY int(11) NOT NULL default '0',
  PRIMARY KEY (ocID)
);
CREATE TABLE polls (
  id int(11) NOT NULL auto_increment,
  active tinyint(4) NOT NULL default '0',
  question varchar(255) NOT NULL default '',
  choice1 varchar(255) NOT NULL default '',
  choice2 varchar(255) NOT NULL default '',
  choice3 varchar(255) NOT NULL default '',
  choice4 varchar(255) NOT NULL default '',
  choice5 varchar(255) NOT NULL default '',
  choice6 varchar(255) NOT NULL default '',
  choice7 varchar(255) NOT NULL default '',
  choice8 varchar(255) NOT NULL default '',
  choice9 varchar(255) NOT NULL default '',
  choice10 varchar(255) NOT NULL default '',
  voted1 int(11) NOT NULL default '0',
  voted2 int(11) NOT NULL default '0',
  voted3 int(11) NOT NULL default '0',
  voted4 int(11) NOT NULL default '0',
  voted5 int(11) NOT NULL default '0',
  voted6 int(11) NOT NULL default '0',
  voted7 int(11) NOT NULL default '0',
  voted8 int(11) NOT NULL default '0',
  voted9 int(11) NOT NULL default '0',
  voted10 int(11) NOT NULL default '0',
  votes text NOT NULL,
  winner int(11) NOT NULL default '-1',
  hidden tinyint(4) NOT NULL default '0',
  PRIMARY KEY (id)
);
CREATE TABLE papercontent (content longtext NOT NULL);

-- Social & economy state (21)
CREATE TABLE gangs (
  gangID int(11) NOT NULL auto_increment,
  gangNAME varchar(255) NOT NULL default '',
  gangDESC text NOT NULL,
  gangPREF varchar(255) NOT NULL default '',
  gangSUFF varchar(255) NOT NULL default '',
  gangMONEY int(11) NOT NULL default '0',
  gangCRYSTALS int(11) NOT NULL default '0',
  gangRESPECT int(11) NOT NULL default '100',
  gangPRESIDENT int(11) NOT NULL default '0',
  gangVICEPRES int(11) NOT NULL default '0',
  gangCAPACITY int(11) NOT NULL default '5',
  gangCRIME int(11) NOT NULL default '0',
  gangCHOURS int(11) NOT NULL default '0',
  gangAMENT text NOT NULL,
  PRIMARY KEY (gangID)
);
CREATE TABLE gangevents (
  gevID int(11) NOT NULL auto_increment,
  gevGANG int(11) NOT NULL default '0',
  gevTIME int(11) NOT NULL default '0',
  gevTEXT text NOT NULL,
  PRIMARY KEY (gevID)
);
CREATE TABLE gangwars (
  warID int(11) NOT NULL auto_increment,
  warDECLARER int(11) NOT NULL default '0',
  warDECLARED int(11) NOT NULL default '0',
  warTIME int(11) NOT NULL default '0',
  PRIMARY KEY (warID)
);
CREATE TABLE surrenders (
  surID int(11) NOT NULL auto_increment,
  surWAR int(11) NOT NULL default '0',
  surWHO int(11) NOT NULL default '0',
  surTO int(11) NOT NULL default '0',
  surMSG text NOT NULL,
  PRIMARY KEY (surID)
);
CREATE TABLE applications (
  appID int(11) NOT NULL auto_increment,
  appUSER int(11) NOT NULL default '0',
  appGANG int(11) NOT NULL default '0',
  appTEXT text NOT NULL,
  PRIMARY KEY (appID)
);
CREATE TABLE friendslist (
  fl_ID int(11) NOT NULL auto_increment,
  fl_ADDER int(11) NOT NULL default '0',
  fl_ADDED int(11) NOT NULL default '0',
  fl_COMMENT varchar(255) NOT NULL default '',
  PRIMARY KEY (fl_ID)
);
CREATE TABLE contactlist (
  cl_ID int(11) NOT NULL auto_increment,
  cl_ADDER int(11) NOT NULL default '0',
  cl_ADDED int(11) NOT NULL default '0',
  PRIMARY KEY (cl_ID)
);
CREATE TABLE blacklist (
  bl_ID int(11) NOT NULL auto_increment,
  bl_ADDER int(11) NOT NULL default '0',
  bl_ADDED int(11) NOT NULL default '0',
  bl_COMMENT varchar(255) NOT NULL default '',
  PRIMARY KEY (bl_ID)
);
CREATE TABLE mail (
  mail_id int(11) NOT NULL auto_increment,
  mail_read tinyint(4) NOT NULL default '0',
  mail_from int(11) NOT NULL default '0',
  mail_to int(11) NOT NULL default '0',
  mail_time int(11) NOT NULL default '0',
  mail_subject varchar(255) NOT NULL default '',
  mail_text text NOT NULL,
  PRIMARY KEY (mail_id)
);
CREATE TABLE events (
  evID int(11) NOT NULL auto_increment,
  evUSER int(11) NOT NULL default '0',
  evTIME int(11) NOT NULL default '0',
  evREAD tinyint(4) NOT NULL default '0',
  evTEXT text NOT NULL,
  PRIMARY KEY (evID)
);
CREATE TABLE announcements (a_text text NOT NULL, a_time int(11) NOT NULL default '0');
CREATE TABLE forum_forums (
  ff_id int(11) NOT NULL auto_increment,
  ff_name varchar(255) NOT NULL default '',
  ff_desc varchar(255) NOT NULL default '',
  ff_posts int(11) NOT NULL default '0',
  ff_topics int(11) NOT NULL default '0',
  ff_lp_time int(11) NOT NULL default '0',
  ff_lp_poster_id int(11) NOT NULL default '0',
  ff_lp_poster_name varchar(255) NOT NULL default '',
  ff_lp_t_id int(11) NOT NULL default '0',
  ff_lp_t_name varchar(255) NOT NULL default '',
  ff_auth enum('public','gang','staff') NOT NULL default 'public',
  ff_owner int(11) NOT NULL default '-1',
  PRIMARY KEY (ff_id)
);
CREATE TABLE forum_topics (
  ft_id int(11) NOT NULL auto_increment,
  ft_forum_id int(11) NOT NULL default '1',
  ft_name varchar(255) NOT NULL default '',
  ft_desc varchar(255) NOT NULL default '',
  ft_posts int(11) NOT NULL default '0',
  ft_owner_id int(11) NOT NULL default '0',
  ft_owner_name varchar(255) NOT NULL default '',
  ft_start_time int(11) NOT NULL default '0',
  ft_last_id int(11) NOT NULL default '0',
  ft_last_name varchar(255) NOT NULL default '',
  ft_last_time int(11) NOT NULL default '0',
  ft_pinned tinyint(4) NOT NULL default '0',
  ft_locked tinyint(4) NOT NULL default '0',
  PRIMARY KEY (ft_id)
);
CREATE TABLE forum_posts (
  fp_id int(11) NOT NULL auto_increment,
  fp_topic_id int(11) NOT NULL default '0',
  fp_forum_id int(11) NOT NULL default '0',
  fp_poster_id int(11) NOT NULL default '0',
  fp_poster_name varchar(255) NOT NULL default '',
  fp_time int(11) NOT NULL default '0',
  fp_subject varchar(255) NOT NULL default '',
  fp_text text NOT NULL,
  fp_editor_id int(11) NOT NULL default '0',
  fp_editor_name varchar(255) NOT NULL default '',
  fp_editor_time int(11) NOT NULL default '0',
  fp_edit_count int(11) NOT NULL default '0',
  PRIMARY KEY (fp_id)
);
CREATE TABLE preports (
  prID int(11) NOT NULL auto_increment,
  prREPORTER int(11) NOT NULL default '0',
  prREPORTED int(11) NOT NULL default '0',
  prTEXT text NOT NULL,
  PRIMARY KEY (prID)
);
CREATE TABLE referals (
  refID int(11) NOT NULL auto_increment,
  refREFER int(11) NOT NULL default '0',
  refREFED int(11) NOT NULL default '0',
  refTIME int(11) NOT NULL default '0',
  refREFERIP varchar(255) NOT NULL default '',
  refREFEDIP varchar(255) NOT NULL default '',
  PRIMARY KEY (refID)
);
CREATE TABLE crystalmarket (
  cmID int(11) NOT NULL auto_increment,
  cmQTY int(11) NOT NULL default '0',
  cmADDER int(11) NOT NULL default '0',
  cmPRICE int(11) NOT NULL default '0',
  PRIMARY KEY (cmID)
);
CREATE TABLE itemmarket (
  imID int(11) NOT NULL auto_increment,
  imITEM int(11) NOT NULL default '0',
  imADDER int(11) NOT NULL default '0',
  imPRICE int(11) NOT NULL default '0',
  imCURRENCY enum('money','crystals') NOT NULL default 'money',
  imQTY int(11) NOT NULL default '1',
  PRIMARY KEY (imID)
);
CREATE TABLE challengebots (cb_npcid int(11) NOT NULL, cb_money int(11) NOT NULL default '0');
CREATE TABLE dps_accepted (
  dpID int(11) NOT NULL auto_increment,
  dpBUYER int(11) NOT NULL default '0',
  dpFOR int(11) NOT NULL default '0',
  dpTYPE varchar(255) NOT NULL default '',
  dpTIME int(11) NOT NULL default '0',
  dpTXN varchar(255) NOT NULL default '',
  PRIMARY KEY (dpID)
);
CREATE TABLE willps_accepted (
  dpID int(11) NOT NULL auto_increment,
  dpBUYER int(11) NOT NULL default '0',
  dpFOR int(11) NOT NULL default '0',
  dpAMNT varchar(255) NOT NULL default '',
  dpTIME int(11) NOT NULL default '0',
  dpTXN varchar(255) NOT NULL default '',
  PRIMARY KEY (dpID)
);

-- Logs & system (20)
CREATE TABLE fedjail (
  fed_id int(11) NOT NULL auto_increment,
  fed_userid int(11) NOT NULL default '0',
  fed_days int(11) NOT NULL default '0',
  fed_jailedby int(11) NOT NULL default '0',
  fed_reason varchar(255) NOT NULL default '',
  PRIMARY KEY (fed_id),
  UNIQUE KEY (fed_userid)
);
CREATE TABLE stafflog (
  id int(11) NOT NULL auto_increment,
  user int(11) NOT NULL default '0',
  `time` int(11) NOT NULL default '0',
  action varchar(255) NOT NULL default '',
  ip varchar(255) NOT NULL default '',
  PRIMARY KEY (id)
);
CREATE TABLE staffnotelogs (
  snID int(11) NOT NULL auto_increment,
  snCHANGER int(11) NOT NULL default '0',
  snCHANGED int(11) NOT NULL default '0',
  snTIME int(11) NOT NULL default '0',
  snOLD varchar(255) NOT NULL default '',
  snNEW varchar(255) NOT NULL default '',
  PRIMARY KEY (snID)
);
CREATE TABLE jaillogs (
  jaID int(11) NOT NULL auto_increment,
  jaJAILER int(11) NOT NULL default '0',
  jaJAILED int(11) NOT NULL default '0',
  jaDAYS int(11) NOT NULL default '0',
  jaREASON varchar(255) NOT NULL default '',
  jaTIME int(11) NOT NULL default '0',
  PRIMARY KEY (jaID)
);
CREATE TABLE unjaillogs (
  ujaID int(11) NOT NULL auto_increment,
  ujaJAILER int(11) NOT NULL default '0',
  ujaJAILED int(11) NOT NULL default '0',
  ujaTIME int(11) NOT NULL default '0',
  PRIMARY KEY (ujaID)
);
CREATE TABLE attacklogs (
  log_id int(11) NOT NULL auto_increment,
  attacker int(11) NOT NULL default '0',
  attacked int(11) NOT NULL default '0',
  `result` enum('won','lost') NOT NULL default 'won',
  `time` int(11) NOT NULL default '0',
  stole int(11) NOT NULL default '0',
  attacklog longtext NOT NULL,
  PRIMARY KEY (log_id)
);
CREATE TABLE cashxferlogs (
  cxID int(11) NOT NULL auto_increment,
  cxFROM int(11) NOT NULL default '0',
  cxTO int(11) NOT NULL default '0',
  cxAMOUNT int(11) NOT NULL default '0',
  cxTIME int(11) NOT NULL default '0',
  cxFROMIP varchar(255) NOT NULL default '',
  cxTOIP varchar(255) NOT NULL default '',
  PRIMARY KEY (cxID)
);
CREATE TABLE bankxferlogs (
  cxID int(11) NOT NULL auto_increment,
  cxFROM int(11) NOT NULL default '0',
  cxTO int(11) NOT NULL default '0',
  cxAMOUNT int(11) NOT NULL default '0',
  cxTIME int(11) NOT NULL default '0',
  cxFROMIP varchar(255) NOT NULL default '',
  cxTOIP varchar(255) NOT NULL default '',
  cxBANK enum('bank','cyber') NOT NULL default 'bank',
  PRIMARY KEY (cxID)
);
CREATE TABLE crystalxferlogs (
  cxID int(11) NOT NULL auto_increment,
  cxFROM int(11) NOT NULL default '0',
  cxTO int(11) NOT NULL default '0',
  cxAMOUNT int(11) NOT NULL default '0',
  cxTIME int(11) NOT NULL default '0',
  cxFROMIP varchar(255) NOT NULL default '',
  cxTOIP varchar(255) NOT NULL default '',
  PRIMARY KEY (cxID)
);
CREATE TABLE itemxferlogs (
  ixID int(11) NOT NULL auto_increment,
  ixFROM int(11) NOT NULL default '0',
  ixTO int(11) NOT NULL default '0',
  ixITEM int(11) NOT NULL default '0',
  ixQTY int(11) NOT NULL default '0',
  ixTIME int(11) NOT NULL default '0',
  ixFROMIP varchar(255) NOT NULL default '',
  ixTOIP varchar(255) NOT NULL default '',
  PRIMARY KEY (ixID)
);
CREATE TABLE itembuylogs (
  ibID int(11) NOT NULL auto_increment,
  ibUSER int(11) NOT NULL default '0',
  ibITEM int(11) NOT NULL default '0',
  ibTOTALPRICE int(11) NOT NULL default '0',
  ibQTY int(11) NOT NULL default '0',
  ibTIME int(11) NOT NULL default '0',
  ibCONTENT varchar(255) NOT NULL default '',
  PRIMARY KEY (ibID)
);
CREATE TABLE itemselllogs (
  isID int(11) NOT NULL auto_increment,
  isUSER int(11) NOT NULL default '0',
  isITEM int(11) NOT NULL default '0',
  isTOTALPRICE int(11) NOT NULL default '0',
  isQTY int(11) NOT NULL default '0',
  isTIME int(11) NOT NULL default '0',
  isCONTENT varchar(255) NOT NULL default '',
  PRIMARY KEY (isID)
);
CREATE TABLE imarketaddlogs (
  imaID int(11) NOT NULL auto_increment,
  imaITEM int(11) NOT NULL default '0',
  imaPRICE int(11) NOT NULL default '0',
  imaINVID int(11) NOT NULL default '0',
  imaADDER int(11) NOT NULL default '0',
  imaTIME int(11) NOT NULL default '0',
  imaCONTENT varchar(255) NOT NULL default '',
  PRIMARY KEY (imaID)
);
CREATE TABLE imbuylogs (
  imbID int(11) NOT NULL auto_increment,
  imbITEM int(11) NOT NULL default '0',
  imbADDER int(11) NOT NULL default '0',
  imbBUYER int(11) NOT NULL default '0',
  imbPRICE int(11) NOT NULL default '0',
  imbIMID int(11) NOT NULL default '0',
  imbINVID int(11) NOT NULL default '0',
  imbTIME int(11) NOT NULL default '0',
  imbCONTENT varchar(255) NOT NULL default '',
  PRIMARY KEY (imbID)
);
CREATE TABLE imremovelogs (
  imrID int(11) NOT NULL auto_increment,
  imrITEM int(11) NOT NULL default '0',
  imrADDER int(11) NOT NULL default '0',
  imrREMOVER int(11) NOT NULL default '0',
  imrIMID int(11) NOT NULL default '0',
  imrINVID int(11) NOT NULL default '0',
  imrTIME int(11) NOT NULL default '0',
  imrCONTENT varchar(255) NOT NULL default '',
  PRIMARY KEY (imrID)
);
CREATE TABLE oclogs (
  oclID int(11) NOT NULL auto_increment,
  oclOC int(11) NOT NULL default '0',
  oclGANG int(11) NOT NULL default '0',
  oclLOG varchar(255) NOT NULL default '',
  oclRESULT enum('success','failure') NOT NULL default 'success',
  oclMONEY int(11) NOT NULL default '0',
  ocCRIMEN varchar(255) NOT NULL default '',
  ocTIME int(11) NOT NULL default '0',
  PRIMARY KEY (oclID)
);
CREATE TABLE settings (
  conf_id int(11) NOT NULL auto_increment,
  conf_name varchar(255) NOT NULL default '',
  conf_value text NOT NULL,
  data_type varchar(255) NOT NULL default 'text',
  PRIMARY KEY (conf_id)
);
CREATE TABLE cron_times (
  id int(11) NOT NULL auto_increment,
  name varchar(32) NOT NULL,
  last_run timestamp NULL,
  PRIMARY KEY (id),
  UNIQUE KEY (name)
);
CREATE TABLE logs_cron_fails (
  id int(11) NOT NULL auto_increment,
  cron varchar(32) NOT NULL default '',
  method varchar(32) NOT NULL default '',
  message text NULL,
  time_started timestamp NULL,
  time_finished timestamp NULL,
  time_logged timestamp NOT NULL default CURRENT_TIMESTAMP,
  handled bool NOT NULL default false,
  INDEX (cron),
  PRIMARY KEY (id)
);
CREATE TABLE logs_cron_runtimes (
  id int(11) NOT NULL auto_increment,
  cron varchar(32) NOT NULL default '',
  time_started timestamp NULL,
  time_finished timestamp NULL,
  time_logged timestamp NOT NULL default CURRENT_TIMESTAMP,
  updated_cnt int(11) NOT NULL default 0,
  INDEX (cron),
  PRIMARY KEY (id)
);
